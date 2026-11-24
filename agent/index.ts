import * as ed from "@noble/ed25519"
import bs58 from "bs58"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { requireSepoliaToken } from "../shared/chain"
import { loginMessage, nearLoginMessage } from "../shared/login"
import { loadMarket, marketPreferences, requireExplicitChain } from "../shared/market"
import { parseAgentSplit } from "../shared/split"
import { activeChainKey, runOnChain } from "../server/activeChain"
import { requireNearToken } from "../shared/near"
import { accountFromSecret, NEP413_RECIPIENT, nep413Bytes, publicKeyBytes, seedFromSecret, sha256Bytes } from "../shared/nearKey"
import { feeBps, windowMs } from "../server/config"
import { configuredChain, loadEnv } from "../server/env"
import { getDb, importLegacySwarm } from "../server/db"
import { assertQmMetadata, inspectNear, NearConfigError, readTokenMetadata } from "../server/nearInspect"
import { bankAction } from "./bank"
import { callMarket, liveBook, openMarket, recentRounds, settledRounds, type ToolReply } from "./mcp"
import { checkConfig, swarmConfig, type TapeStats } from "./config"
import { admitWallet, decideOpen, freshGate, keptReadyWindow, noteResult, tapeActivity, type GateState, type PrintPoint, type Side } from "./decide"
import { fireAt, releaseWave, type FireSlot } from "./schedule"
import { createDirector, manilaHour, stepDirector, type DirectorState, type DirectorView } from "./director"
import { growKeys, growNearKeys, type NearStoredKey, type StoredKey } from "./keys"
import { personaFor, type Persona } from "./persona"
import { openClock, stepPresence, type Arrival, type WalletClock } from "./presence"
import { replayPayouts } from "./replay"
import { peekApiEndpoint, refreshApiEndpoint } from "./endpoint"
import { histogram, manilaClock, parseControl, parseFlow, percentiles, type FlowFile, type SwarmSnapshot } from "./status"
import { publishStats, startStatsServer } from "./stats"
import { dbFileSizes, readSelfIo, writeBytesPerMinute, type SelfIoSample } from "./writes"
import { CONTROL_PATH, FLOW_PATH, KEYS_PATH, NEAR_KEYS_PATH, STATUS_PATH, SWARM_PATH, readJson, writeJsonAtomic } from "./store"
import {
  loadWalletMap,
  metaGet,
  metaSet,
  metaSetMany,
  minStakeRoundAfter,
  noteWindow,
  openSwarm,
  pruneStakes,
  pruneUnenrolled,
  resetWindowEpoch,
  saveCosmetics,
  saveStakes,
  saveWallets,
  stakesFor,
  type CosmeticWalletRow,
  type WalletRow,
} from "./swarmdb"

type Book = {
  joinId: number
  windowEndsAt: number
  poolUpMicros: number
  poolDownMicros: number
  feed: "live" | "stale"
  tape: { t: number; price: string }[]
  settled: {
    id: number
    strike: string | null
    settle: string | null
    feeMicros: number
    poolUpMicros: number
    poolDownMicros: number
    winningSide: string | null
    resolution: string | null
  }[]
  recent: {
    id: number
    winningSide: string | null
  }[]
}

type LiveWallet = {
  index: number
  address: string
  privateKey: string
  funded: boolean
  clock: WalletClock
  online: boolean
  enrolled: boolean
  bankroll: number
  handled: boolean
  gate: GateState
  persona: Persona
  lastSide: Side | null
  lastStake: number | null
  lastSkip: string | null
  wins: number
  losses: number
  wokeAt: number | null
  sleptAt: number | null
  nextEnroll: number
  token: string | null
  bound: boolean
  dirty: boolean
  cosmeticDirty: boolean
}

type Pending = {
  roundId: number
  endsAt: number
  orders: { address: string; side: Side; stakeMicros: number }[]
  sent: number
}

type Wave = {
  roundId: number
  openAt: number
  endsAt: number
  queue: FireSlot[]
  taken: number
}

async function main() {
  try {
    requireExplicitChain()
    loadMarket()
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  if (marketPreferences.chain === "base") {
    console.error("The swarm refuses CHAIN=base. Real USDC is out of this mode.")
    process.exit(1)
  }
  let split
  try {
    split = parseAgentSplit(process.env.AGENT_SPLIT_BASE, process.env.AGENT_SPLIT_NEAR)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
  const lanes: { chain: "base-sepolia" | "near-testnet"; share: number }[] = []
  if (split.base > 0) lanes.push({ chain: "base-sepolia", share: split.base })
  if (split.near > 0) lanes.push({ chain: "near-testnet", share: split.near })
  console.log(`Agents trade ${lanes.map((lane) => lane.chain).join(" and ")}. Split base ${split.base} / near ${split.near}.`)
  const problem = checkConfig(swarmConfig)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  const stats = startStatsServer()
  if (stats) console.log(`agent stats on http://0.0.0.0:${stats.port}/api/health`)
  process.on("SIGINT", () => {
    stopRequested = true
  })
  process.on("SIGTERM", () => {
    stopRequested = true
  })
  await Promise.all(lanes.map((lane) => runOnChain(lane.chain, () => trade(lane.share))))
  process.exit(0)
}

async function trade(share: number): Promise<void> {
  const chain = configuredChain()
  const near = activeChainKey() === "near-testnet"
  let funded: Set<string> | null = null
  if (near) {
    requireNearToken(chain.key, loadEnv().tokenAccount)
    const env = loadEnv()
    const treasury = env.nearTreasuryAccount || (await accountFromSecret(env.treasuryPrivateKey))
    if (!treasury) {
      console.error("NEAR_TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
      process.exit(1)
    }
    try {
      assertQmMetadata(await readTokenMetadata(loadEnv().tokenAccount.trim()))
    } catch (error) {
      if (error instanceof NearConfigError) {
        console.error(error.message)
        process.exit(1)
      }
      console.error(error instanceof Error ? error.message : error)
    }
    const nearKeys = await growNearKeys(loadNearKeyFile(), 0, swarmConfig.runner.keyCap)
    saveNearKeyFile(nearKeys)
    const report = await inspectNear(treasury)
    for (const line of report.lines) console.error(line)
    // Buy-ins are ledger sessions. An implicit account with no on-chain NEAR can still sign and bet.
    funded = null
  } else {
    requireSepoliaToken(chain)
  }

  const db = getDb()
  const dbPath = loadEnv().dbPath
  importLegacySwarm(db, dbPath)
  openSwarm(db)
  pruneUnenrolled(db)
  const windowKey = String(windowMs())
  const storedWindow = metaGet(db, "window_ms")
  if (storedWindow === null) {
    metaSet(db, "window_ms", windowKey)
  } else if (storedWindow !== windowKey) {
    // Round ids are derived from the window length. A change invalidates every
    // local stake/window row and moves the clock to a different id space.
    resetWindowEpoch(db)
    metaSet(db, "settle_cursor", String(Math.max(0, Math.floor(Date.now() / windowMs()) - 1)))
    metaSet(db, "window_ms", windowKey)
    console.error(`window length changed ${storedWindow}ms -> ${windowKey}ms; local round epoch reset`)
  }
  let keys: { address: string; privateKey: string }[]
  if (near) {
    keys = loadNearKeyFile().map((key) => ({ address: key.account, privateKey: key.privateKey }))
  } else {
    const evm = growKeys(loadKeyFile(), 0, swarmConfig.runner.keyCap)
    saveKeyFile(evm)
    keys = evm
  }
  const wallets = new Map<string, LiveWallet>()
  const stored = loadWalletMap(db)
  keys.forEach((key, index) => remember(wallets, key, stored.get(key.address.toLowerCase()) ?? null, index, funded))
  try {
    await openMarket(loadEnv().apiUrl, activeChainKey())
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  }
  // The loop signs wallets in as it seats them. Waiting here for every enrolled
  // wallet keeps this market off the book for the whole crowd.
  const initialSteer = steering()
  const storedSpring = metaGet(db, "spring") !== null ? Number(metaGet(db, "spring")) : null
  const defaultSpring =
    initialSteer.pin ??
    stepDirector(createDirector(swarmConfig.clock.floor), {
      now: Date.now(),
      dtSec: 0,
      tape: { absReturn: 1, volatility: 1 },
      config: swarmConfig.clock,
      pin: initialSteer.pin,
      hold: initialSteer.hold,
      pace: initialSteer.pace,
    }).target
  const initialSpring =
    storedSpring !== null && Number.isFinite(storedSpring)
      ? initialSteer.pin === null
        ? Math.max(storedSpring, swarmConfig.clock.floor)
        : storedSpring
      : defaultSpring
  const director = createDirector(initialSpring)
  director.velocity = Number(metaGet(db, "velocity") ?? "0")
  let lastAt = Date.now() - 1_000
  let lastJoin = -1
  let book: Book | null = null
  let bookAt: number | null = null
  let cursor = Number(metaGet(db, "settle_cursor") ?? "0")
  const earliestStakeRound = minStakeRoundAfter(db, 0)
  if (earliestStakeRound !== null && cursor < earliestStakeRound - 1) {
    cursor = earliestStakeRound - 1
  }
  let wave: Wave | null = null
  let builtJoin = -1
  let auditAt = 0
  let auditCursor = 0
  let bankAt = 0
  let cleanupAt = 0
  let enrolling = false
  let nextEnrollBatch = 0
  let banking = false
  let minute = Math.floor(Date.now() / 60_000)
  let arrivedMinute = 0
  let leftMinute = 0
  let trace: number[] = []
  try {
    const parsed = JSON.parse(metaGet(db, "trace") ?? "[]") as unknown
    if (Array.isArray(parsed)) trace = parsed.filter((item): item is number => typeof item === "number")
  } catch {
    trace = []
  }
  const recent: Arrival[] = []
  const chainKey = activeChainKey()
  const storedFlow = readJson(laneFlowPath(chainKey)) ?? (chainKey === "base-sepolia" ? readJson(FLOW_PATH) : null)
  let flow = parseFlow(storedFlow)
  let lastError: string | null = null
  let windowStats = {
    roundId: null as number | null,
    buyIns: 0,
    skips: 0,
    up: 0,
    down: 0,
    stakes: [] as number[],
    attempted: 0,
    rejected: 0,
    lastReject: null as string | null,
  }
  let lastView: DirectorView | null = null
  let stopping = false
  let flushAt = 0
  let ioSample: SelfIoSample | null = null

  const flush = (running = !stopping) => {
    let dirtyWallets = 0
    const dirty: WalletRow[] = []
    for (const wallet of wallets.values()) {
      if (!wallet.dirty) continue
      dirtyWallets += 1
      if (wallet.enrolled) dirty.push(toRow(wallet))
    }
    const flushedWallets = dirty.length
    saveWallets(db, dirty)
    // A full-row write persists the cosmetic columns too, so both flags clear.
    for (const wallet of wallets.values()) {
      if (!wallet.enrolled) continue
      if (wallet.dirty) wallet.cosmeticDirty = false
      wallet.dirty = false
    }
    metaSetMany(db, [
      ["spring", String(director.value)],
      ["velocity", String(director.velocity)],
      ["settle_cursor", String(cursor)],
      ["trace", JSON.stringify(trace.slice(-180))],
      ["book_join", String(book?.joinId ?? -1)],
      ["book_at", String(bookAt ?? 0)],
      ["last_error", lastError ?? ""],
      ["bound", String(walletsBound(wallets))],
    ])
    // Write-path meters for the P1-4 gate: the whole-process write rate from
    // /proc/self/io, the DB/WAL sizes, and the rows this flush wrote back.
    const now = Date.now()
    const io = readSelfIo()
    const writeBytesPerMin = io && ioSample ? writeBytesPerMinute(ioSample, { at: now, writeBytes: io.writeBytes }) : null
    if (io) ioSample = { at: now, writeBytes: io.writeBytes }
    const sizes = dbFileSizes(dbPath)
    const snapshot = buildSnapshot({
      now,
      view: lastView,
      director,
      wallets,
      flow,
      lastError,
      book,
      bookAt,
      arrivedMinute,
      leftMinute,
      trace,
      windowStats,
      dirtyWallets,
      flushedWallets,
      cosmeticWallets,
      cosmeticFlushed,
      writeBytesPerMin,
      dbBytes: sizes.dbBytes,
      walBytes: sizes.walBytes,
      running,
    })
    publishLane(activeChainKey(), snapshot, flow)
  }

  /** Cosmetic persistence batches at a slower cadence: presence, gate, and
   *  skip diagnostics can lag a few seconds; bankroll and enrollment cannot. */
  const flushCosmetics = () => {
    let cosmeticWallets = 0
    const rows: CosmeticWalletRow[] = []
    for (const wallet of wallets.values()) {
      if (!wallet.cosmeticDirty) continue
      cosmeticWallets += 1
      if (wallet.enrolled) rows.push(cosmeticRow(wallet))
    }
    saveCosmetics(db, rows)
    for (const wallet of wallets.values()) if (wallet.enrolled) wallet.cosmeticDirty = false
    return { wallets: cosmeticWallets, flushed: rows.length }
  }
  let cosmeticAt = 0
  let cosmeticWallets = 0
  let cosmeticFlushed = 0

  /** The loop wakes four times a second; the ledger and status files do not. */
  const maybeFlush = (now: number, running = !stopping) => {
    if (now - flushAt < 1_000) return
    flushAt = now
    flush(running)
    if (now - cosmeticAt >= COSMETIC_FLUSH_MS) {
      cosmeticAt = now
      const done = flushCosmetics()
      cosmeticWallets = done.wallets
      cosmeticFlushed = done.flushed
    }
  }

  const takeBook = (): Promise<Book | null> =>
    loadBook(db, wallets, () => cursor, (value) => {
      cursor = value
    })

  const dropQueued = (closing: Wave) => {
    for (const slot of closing.queue) {
      const wallet = wallets.get(slot.address)
      if (!wallet) continue
      setSkip(wallet, "waiting")
    }
    noteWindow(db, {
      id: closing.roundId,
      buyIns: windowStats.buyIns,
      skips: windowStats.skips,
      upMicros: windowStats.up,
      downMicros: windowStats.down,
      at: Date.now(),
    })
  }

  await refreshApiEndpoint(loadEnv().apiUrl)

  while (!stopping && !stopRequested) {
    const now = Date.now()
    const dt = Math.max(0, (now - lastAt) / 1000)
    lastAt = now
    const thisMinute = Math.floor(now / 60_000)
    if (thisMinute !== minute) {
      trace.push(walletsOnline(wallets))
      if (trace.length > 180) trace = trace.slice(-180)
      arrivedMinute = 0
      leftMinute = 0
      minute = thisMinute
    }
    try {
      const steered = steering()
      const points = pointsOf(book?.tape ?? [], now)
      const tape = directorTape(points)
      const view = scaleCrowd(
        stepDirector(director, {
          now,
          dtSec: dt,
          tape,
          config: swarmConfig.clock,
          pin: steered.pin,
          hold: steered.hold,
          pace: steered.pace,
        }),
        share,
      )
      lastView = view
      const room = Math.max(0, Math.floor(view.perSecond * Math.max(dt, 0)))
      const wanted = Math.min(
        swarmConfig.runner.keyCap,
        Math.max(Math.ceil(view.window[1]) + 15, Math.ceil(view.window[1] * 1.4)),
      )
      if (keys.length < wanted && room > 0) {
        if (activeChainKey() === "near-testnet") {
          const next = await growNearKeys(
            keys.map((key) => ({ account: key.address, privateKey: key.privateKey })),
            Math.min(wanted, keys.length + room),
            swarmConfig.runner.keyCap,
          )
          const mapped = next.map((key) => ({ address: key.account, privateKey: key.privateKey }))
          if (mapped.length !== keys.length || mapped.some((key, index) => key.privateKey !== keys[index]?.privateKey)) {
            keys = mapped
            saveNearKeyFile(next)
          }
        } else {
          const next = growKeys(keys as StoredKey[], Math.min(wanted, keys.length + room), swarmConfig.runner.keyCap)
          if (next.length !== keys.length || next.some((key, index) => key.privateKey !== keys[index]?.privateKey)) {
            keys = next
            saveKeyFile(next)
          }
        }
      }
      keys.forEach((key, index) => {
        if (!wallets.has(key.address.toLowerCase())) remember(wallets, key, null, index, funded)
      })
      const hour = manilaHour(now, swarmConfig.clock.timeZoneOffsetHours)
      const enrolledWallets = [...wallets.values()].filter((wallet) => wallet.enrolled).sort((left, right) => left.index - right.index)
      const clocks = enrolledWallets.map((wallet) => wallet.clock)
      const seated = new Set(enrolledWallets.filter((wallet) => wallet.online).map((wallet) => wallet.address))
      const bend = presenceBend(points, now)
      const presentTarget = Math.min(view.online, enrolledWallets.length)
      const presentWindow: readonly [number, number] = [
        Math.min(view.window[0], presentTarget),
        Math.min(view.window[1], Math.max(presentTarget, enrolledWallets.length)),
      ]
      const step = stepPresence({
        clocks,
        seated,
        now,
        dtSec: dt,
        hour,
        target: presentTarget,
        window: presentWindow,
        tape: bend,
        recentArrivals: recent,
        config: swarmConfig.presence,
        perSecond: view.perSecond,
      })
      const byAddress = new Map(step.clocks.map((clock) => [clock.address, clock]))
      for (const wallet of enrolledWallets) {
        const clock = byAddress.get(wallet.address)
        if (!clock) continue
        if (clock.cursor !== wallet.clock.cursor || clock.visitEnd !== wallet.clock.visitEnd || clock.gapEnd !== wallet.clock.gapEnd) {
          wallet.cosmeticDirty = true
        }
        wallet.clock = clock
      }
      const joinId = Math.floor(now / windowMs())
      for (const address of step.arrived) {
        const wallet = wallets.get(address)
        if (!wallet || wallet.online || !wallet.enrolled) continue
        wallet.online = true
        wallet.wokeAt = now
        if (wallet.gate.readyWindow < joinId) {
          wallet.gate = {
            ...wallet.gate,
            burstLeft: 0,
            refractory: false,
            readyWindow: joinId + (wallet.index % 3),
          }
        }
        wallet.cosmeticDirty = true
        arrivedMinute += 1
        recent.push({ index: wallet.index, at: now })
      }
      for (const address of step.left) {
        const wallet = wallets.get(address)
        if (!wallet || !wallet.online) continue
        wallet.online = false
        wallet.sleptAt = now
        wallet.cosmeticDirty = true
        leftMinute += 1
      }
      // Warm keep: a handful of funded wallets stay online so the book is never empty.
      // They still need bound + enrolled to trade; this only overrides sleep.
      for (const address of warmKeepAddresses(wallets, swarmConfig.runner.seedCount)) {
        const wallet = wallets.get(address)
        if (!wallet || !wallet.enrolled || !wallet.bound || wallet.online) continue
        wallet.online = true
        wallet.wokeAt = now
        wallet.cosmeticDirty = true
        arrivedMinute += 1
        recent.push({ index: wallet.index, at: now })
      }
      while (recent.length > 0 && now - recent[0]!.at > swarmConfig.presence.herdWindowMs) recent.shift()

      maybeFlush(now)
      const needsRepair = [...wallets.values()].some((wallet) => wallet.enrolled && !wallet.bound && wallet.nextEnroll <= now)
      const near = activeChainKey() === "near-testnet"
      const coolingNow = isCoolingError(lastError)
      // Seed: the first batch trades in the next window even when the crowd target is smaller.
      const seedActive = enrolledWallets.length < swarmConfig.runner.seedCount
      const wantedEnroll = seedActive
        ? Math.max(swarmConfig.runner.seedCount, Math.ceil(view.online))
        : Math.ceil(view.online)
      const freshWidth = seedActive
        ? swarmConfig.runner.seedCount
        : near
          ? swarmConfig.runner.rampEnrollWidth
          : swarmConfig.runner.enrollWidth
      // A stored session token is cheap to re-establish and never mints, so repair
      // the existing crowd at once instead of making it wait behind the grant rate.
      const width = needsRepair ? swarmConfig.runner.repairWidth : freshWidth
      const enrollGap = needsRepair
        ? swarmConfig.runner.repairGapMs
        : near
          ? swarmConfig.runner.rampEnrollGapMs
          : swarmConfig.runner.enrollGapMs
      if (
        !enrolling &&
        now >= nextEnrollBatch &&
        (needsRepair || (!coolingNow && enrolledWallets.length < Math.min(swarmConfig.runner.keyCap, wantedEnroll)))
      ) {
        enrolling = true
        nextEnrollBatch = now + enrollGap
        void enrollDue(wallets, chain.id, now, wantedEnroll, width, !needsRepair, flow, (message) => {
          lastError = message
        }, coolingNow)
          .catch((error) => {
            lastError = error instanceof Error ? error.message : "Enrollment failed"
          })
          .finally(() => {
            enrolling = false
          })
      }

      const bookAge = bookAt === null ? Number.POSITIVE_INFINITY : now - bookAt
      if (lastJoin !== joinId || bookAge >= 1_000) {
        const loaded = await takeBook()
        if (loaded) {
          book = loaded
          bookAt = Date.now()
          lastError = null
          // A response can land just after a boundary and carry the previous join.
          // Track what the book actually says, not the clock we asked under.
          lastJoin = loaded.joinId
        } else lastError = "Book did not load"
      }

      if (wave && wave.roundId !== joinId) {
        dropQueued(wave)
        wave = null
      }

      const buyInPaused = steered.control.buyInPaused
      const marginMs = swarmConfig.timing.marginMs
      if (
        !buyInPaused &&
        wave === null &&
        builtJoin !== joinId &&
        book &&
        book.feed === "live" &&
        book.joinId === joinId &&
        now < book.windowEndsAt - marginMs
      ) {
        const openAt = book.windowEndsAt - windowMs()
        const paused = new Set(steered.control.paused)
        const livePoints = pointsOf(book.tape, now)
        const queue: FireSlot[] = []
        let skips = 0
        for (const wallet of wallets.values()) {
          if (!wallet.online || !wallet.enrolled || !wallet.bound) continue
          const admitted = admitWallet({
            wallet: {
              index: wallet.index,
              address: wallet.address,
              persona: wallet.persona,
              bankroll: wallet.bankroll,
              gate: wallet.gate,
              paused: paused.has(wallet.address),
            },
            windowId: book.joinId,
            now,
            windowMs: windowMs(),
            points: livePoints,
            config: swarmConfig.persona,
          })
          const admittedJson = JSON.stringify(admitted.gate)
          if (admittedJson !== JSON.stringify(wallet.gate)) wallet.cosmeticDirty = true
          wallet.gate = admitted.gate
          if (admitted.action === "skip") {
            setSkip(wallet, admitted.reason)
            skips += 1
            continue
          }
          queue.push({
            address: wallet.address,
            inBurst: admitted.inBurst,
            fireAt: fireAt(wallet.index, wallet.persona.mind, book.joinId, openAt, book.windowEndsAt, swarmConfig.timing),
          })
        }
        windowStats = {
          roundId: book.joinId,
          buyIns: 0,
          skips,
          up: 0,
          down: 0,
          stakes: [],
          attempted: 0,
          rejected: 0,
          lastReject: null,
        }
        builtJoin = joinId
        if (queue.length === 0) {
          noteWindow(db, { id: book.joinId, buyIns: 0, skips, upMicros: 0, downMicros: 0, at: now })
        } else {
          wave = { roundId: book.joinId, openAt, endsAt: book.windowEndsAt, queue, taken: 0 }
        }
      } else if (book && book.joinId === joinId && now >= book.windowEndsAt - marginMs && wave === null) {
        builtJoin = joinId
      }

      if (wave && !buyInPaused && now < wave.endsAt - swarmConfig.timing.marginMs) {
        const open = wave
        const loaded = await takeBook()
        if (loaded) {
          book = loaded
          bookAt = Date.now()
          lastError = null
        }
        const source = book
        if (source && source.feed === "live" && source.joinId === open.roundId) {
            const at = Date.now()
            const released = releaseWave({
              queue: wave.queue,
              now: at,
              closeAt: wave.endsAt,
              timing: swarmConfig.timing,
            })
            wave.queue = released.queue
            for (const slot of released.dropped) {
              const wallet = wallets.get(slot.address)
              if (!wallet) continue
              setSkip(wallet, "waiting")
              windowStats.skips += 1
            }
            const livePoints = pointsOf(source.tape, at)
            let upPool = source.poolUpMicros
            let downPool = source.poolDownMicros
            const orders: Pending["orders"] = []
            const room = swarmConfig.runner.orderCap - wave.taken
            const due = released.due.slice(0, Math.max(0, room))
            for (const slot of released.due.slice(due.length)) {
              wave.queue.push({ ...slot, fireAt: at + swarmConfig.timing.sliceMs })
            }
            for (const slot of due) {
              const wallet = wallets.get(slot.address)
              if (!wallet) continue
              if (wallet.funded === false) {
                setSkip(wallet, "unfunded")
                windowStats.skips += 1
                continue
              }
              const decision = decideOpen({
                wallet: {
                  index: wallet.index,
                  address: wallet.address,
                  persona: wallet.persona,
                  bankroll: wallet.bankroll,
                  gate: wallet.gate,
                  paused: steered.control.paused.includes(wallet.address),
                },
                inBurst: slot.inBurst,
                windowId: wave.roundId,
                now: at,
                windowMs: windowMs(),
                points: livePoints,
                poolUp: upPool,
                poolDown: downPool,
                settles: settlesOf(source.recent),
                config: swarmConfig.persona,
                stake: swarmConfig.stake,
                timing: swarmConfig.timing,
              })
              const decisionJson = JSON.stringify(decision.gate)
              if (decisionJson !== JSON.stringify(wallet.gate)) wallet.cosmeticDirty = true
              wallet.gate = decision.gate
              if (decision.action === "skip") {
                setSkip(wallet, decision.reason)
                windowStats.skips += 1
                continue
              }
              orders.push({ address: wallet.address, side: decision.side, stakeMicros: decision.stakeMicros })
              wave.taken += 1
              if (decision.side === "up") upPool += decision.stakeMicros
              else downPool += decision.stakeMicros
            }
            if (wave.taken >= swarmConfig.runner.orderCap) {
              for (const slot of wave.queue) {
                const wallet = wallets.get(slot.address)
                if (!wallet) continue
                setSkip(wallet, "waiting")
                windowStats.skips += 1
              }
              wave.queue = []
            }
            if (orders.length > 0) {
              const pending: Pending = { roundId: wave.roundId, endsAt: wave.endsAt, orders, sent: 0 }
              const posted = await postOrders(db, pending, wallets, flow, (message) => {
                lastError = message
              })
              windowStats.buyIns += posted.count
              windowStats.up += posted.up
              windowStats.down += posted.down
              windowStats.stakes.push(...posted.stakes)
              windowStats.attempted += posted.attempted
              windowStats.rejected += posted.rejected
              if (posted.lastReject) windowStats.lastReject = posted.lastReject
            }
            if (wave.queue.length === 0) {
              noteWindow(db, {
                id: wave.roundId,
                buyIns: windowStats.buyIns,
                skips: windowStats.skips,
                upMicros: windowStats.up,
                downMicros: windowStats.down,
                at: Date.now(),
              })
              wave = null
            }
        }
      } else if (wave && now >= wave.endsAt - swarmConfig.timing.marginMs) {
        dropQueued(wave)
        wave = null
      }

      if (now - auditAt >= swarmConfig.runner.auditEveryMs) {
        await audit(wallets, auditCursor, (next) => {
          auditCursor = next
        })
        auditAt = now
      }
      if (!banking && steered.control.bleed && now - bankAt >= swarmConfig.runner.bankEveryMs) {
        banking = true
        bankAt = now
        void bankPass(wallets, flow, (message) => {
          lastError = message
        })
          .catch((error) => {
            lastError = error instanceof Error ? error.message : "Bank pass failed"
          })
          .finally(() => {
            banking = false
          })
      }
      if (now - cleanupAt >= swarmConfig.runner.cleanupEveryMs) {
        cleanupAt = now
        const currentRound = Math.floor(now / windowMs())
        const replayFloor = cursor > 0 ? Math.min(cursor, currentRound) : currentRound
        pruneStakes(db, replayFloor - swarmConfig.runner.stakeRetentionRounds, chainKey)
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Swarm tick failed"
    }
    void refreshApiEndpoint(loadEnv().apiUrl).catch(() => undefined)
    try {
      maybeFlush(Date.now())
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Snapshot write failed"
    }
    const remain = book ? book.windowEndsAt - Date.now() : swarmConfig.runner.presenceTickMs
    const wait = Math.min(swarmConfig.runner.snapshotEveryMs, Math.max(40, remain))
    await sleep(wait)
  }
  flush(false)
  flushCosmetics()
}

function steering(): {
  pin: number | null
  hold: "off-peak" | "peak" | null
  pace: "glide" | "ramp"
  control: ReturnType<typeof parseControl>
} {
  const control = parseControl(readJson(CONTROL_PATH))
  const pin = loadEnv().swarmPin
  if (pin !== null) return { pin: Math.max(1, Math.round(pin)), hold: null, pace: "glide", control }
  if (control.mode === "pin") return { pin: control.pin ?? 1, hold: null, pace: "glide", control }
  if (control.mode === "off-peak") return { pin: null, hold: "off-peak", pace: "glide", control }
  if (control.mode === "peak") return { pin: null, hold: "peak", pace: "glide", control }
  if (control.mode === "ramp") return { pin: null, hold: null, pace: "ramp", control }
  return { pin: null, hold: null, pace: "glide", control }
}

function remember(
  wallets: Map<string, LiveWallet>,
  key: { address: string; privateKey: string },
  row: WalletRow | null,
  index: number,
  funded: Set<string> | null,
) {
  const address = key.address.toLowerCase()
  if (wallets.has(address)) return
  const persona = personaFor(row?.idx ?? index, swarmConfig.persona)
  const storedIndex = row?.idx ?? index
  const hour = manilaHour(Date.now(), swarmConfig.clock.timeZoneOffsetHours)
  const clock = row
    ? { index: storedIndex, address, cursor: row.cursor, visitStart: row.visitStart, visitEnd: row.visitEnd, gapEnd: row.gapEnd }
    : openClock(storedIndex, address, Date.now(), hour, swarmConfig.presence)
  wallets.set(address, {
    index: storedIndex,
    address,
    privateKey: key.privateKey,
    funded: funded === null || funded.has(address),
    clock,
    online: row?.online === 1 && row?.enrolled === 1,
    enrolled: row?.enrolled === 1,
    bankroll: row?.bankroll ?? 0,
    handled: row?.handled === 1,
    gate: gateFrom(row?.gateJson ?? "", storedIndex, persona),
    persona,
    lastSide: row?.lastSide === "up" || row?.lastSide === "down" ? row.lastSide : null,
    lastStake: row?.lastStake ?? null,
    lastSkip: row?.lastSkip ?? null,
    wins: row?.wins ?? 0,
    losses: row?.losses ?? 0,
    wokeAt: row?.wokeAt ?? null,
    sleptAt: row?.sleptAt ?? null,
    nextEnroll: 0,
    token: row?.token ?? null,
    bound: false,
    dirty: false,
    cosmeticDirty: false,
  })
}

function gateFrom(json: string, index: number, persona: Persona): GateState {
  const nowWindow = Math.floor(Date.now() / windowMs())
  const stagger = index % Math.max(2, Math.round(persona.tempoWindows * 0.5))
  const fresh = { ...freshGate(index, nowWindow, persona, swarmConfig.persona), readyWindow: nowWindow + stagger }
  if (!json) return fresh
  try {
    const parsed = JSON.parse(json) as Partial<GateState>
    if (typeof parsed.rngA !== "number" || typeof parsed.readyWindow !== "number") return fresh
    return {
      readyWindow: keptReadyWindow(parsed.readyWindow, nowWindow, stagger),
      burstLeft: typeof parsed.burstLeft === "number" ? parsed.burstLeft : 0,
      refractory: parsed.refractory === true,
      results: Array.isArray(parsed.results) ? parsed.results.filter((item): item is boolean => typeof item === "boolean").slice(-32) : [],
      edgeNudge: typeof parsed.edgeNudge === "number" ? parsed.edgeNudge : 0,
      tempoNudge: typeof parsed.tempoNudge === "number" ? parsed.tempoNudge : 0,
      bias: typeof parsed.bias === "number" ? parsed.bias : 0,
      rngA: parsed.rngA,
    }
  } catch {
    return fresh
  }
}

function toRow(wallet: LiveWallet): WalletRow {
  return {
    address: wallet.address,
    idx: wallet.index,
    online: wallet.online ? 1 : 0,
    phase: "",
    bankroll: wallet.bankroll,
    lastSide: wallet.lastSide,
    lastStake: wallet.lastStake,
    lastSkip: wallet.lastSkip,
    wins: wallet.wins,
    losses: wallet.losses,
    mind: wallet.persona.mind,
    tempo: wallet.persona.tempoWindows,
    visitEnd: wallet.clock.visitEnd,
    enrolled: wallet.enrolled ? 1 : 0,
    rngA: wallet.gate.rngA,
    gateJson: JSON.stringify(wallet.gate),
    cursor: wallet.clock.cursor,
    visitStart: wallet.clock.visitStart,
    gapEnd: wallet.clock.gapEnd,
    handled: wallet.handled ? 1 : 0,
    wokeAt: wallet.wokeAt,
    sleptAt: wallet.sleptAt,
    updatedAt: Date.now(),
    token: wallet.token,
  }
}

/** P1-4 item 4: skip diagnostics persist on the cosmetic path. The value guard
 *  keeps an unchanged reason from rewriting the wallet row every tick. */
function setSkip(wallet: LiveWallet, reason: string | null) {
  if (wallet.lastSkip === reason) return
  wallet.lastSkip = reason
  wallet.cosmeticDirty = true
}

/** Cosmetic columns only; the critical columns never pass through this shape. */
function cosmeticRow(wallet: LiveWallet): CosmeticWalletRow {
  return {
    address: wallet.address,
    online: wallet.online ? 1 : 0,
    lastSkip: wallet.lastSkip,
    rngA: wallet.gate.rngA,
    gateJson: JSON.stringify(wallet.gate),
    cursor: wallet.clock.cursor,
    visitStart: wallet.clock.visitStart,
    visitEnd: wallet.clock.visitEnd,
    gapEnd: wallet.clock.gapEnd,
    wokeAt: wallet.wokeAt,
    sleptAt: wallet.sleptAt,
    updatedAt: Date.now(),
  }
}

/** Cosmetic persistence cadence. Presence, gate, and skip state may lag a few
 *  seconds after a crash; bankroll, enrollment, and tokens never do. */
function cosmeticFlushMs(): number {
  const raw = Number(process.env.AGENT_COSMETIC_FLUSH_MS ?? "")
  if (Number.isFinite(raw) && raw >= 1_000) return Math.min(60_000, Math.floor(raw))
  return 5_000
}
const COSMETIC_FLUSH_MS = cosmeticFlushMs()

function enrollRank(wallet: LiveWallet): [number, number, number, number] {
  // Restless (frequent traders) first, then low tempo, then richest, then lowest index.
  // Ordering only; width and gap stay in the caller.
  return [
    wallet.persona.mind === "restless" ? 0 : 1,
    wallet.persona.tempoWindows,
    -wallet.bankroll,
    wallet.index,
  ]
}

function compareRank(left: readonly number[], right: readonly number[]): number {
  for (let index = 0; index < left.length; index++) {
    if (left[index]! !== right[index]!) return left[index]! - right[index]!
  }
  return 0
}

let resumeSessionsUnsupported = false

/** A smaller batch keeps one resume_sessions call inside the 30s deadline. */
const RESUME_CHUNK = 500

/** Re-establish stored sessions in a handful of calls instead of one per wallet. */
async function resumeSessions(wallets: Map<string, LiveWallet>, fail: (message: string) => void): Promise<void> {
  if (resumeSessionsUnsupported) return
  const waiting = [...wallets.values()].filter((wallet) => wallet.enrolled && !wallet.bound && wallet.token)
  if (waiting.length === 0) return
  console.error(`resume_sessions: ${waiting.length} wallets waiting`)
  const chunk = RESUME_CHUNK
  for (let index = 0; index < waiting.length; index += chunk) {
    const batch = waiting.slice(index, index + chunk)
    const tokens = batch.flatMap((wallet) => (wallet.token ? [wallet.token] : []))
    if (tokens.length === 0) continue
    const reply = await callMarket("resume_sessions", { tokens }, 30_000)
    if (reply.transport) {
      noteTransport(wallets, reply)
      fail(toolError(reply))
      backOffRepair(waiting)
      return
    }
    if (!reply.ok || !Array.isArray(reply.body.accepted)) {
      const message = toolError(reply)
      console.error(`resume_sessions failed: ${message}`)
      fail(message)
      if (/unknown tool|not found|method not found/i.test(message)) resumeSessionsUnsupported = true
      backOffRepair(batch)
      return
    }
    const accepted = new Set(reply.body.accepted.filter((item): item is string => typeof item === "string"))
    for (const wallet of batch) {
      if (!accepted.has(wallet.address)) continue
      wallet.bound = true
      wallet.enrolled = true
      wallet.dirty = true
    }
    console.error(`resume_sessions: ${accepted.size}/${tokens.length} accepted`)
  }
}

/** Do not hammer the market with the same failing batch every tick. */
function backOffRepair(wallets: Iterable<LiveWallet>) {
  const until = Date.now() + 5_000
  for (const wallet of wallets) {
    if (!wallet.bound) wallet.nextEnroll = Math.max(wallet.nextEnroll, until)
  }
}

async function enrollDue(
  wallets: Map<string, LiveWallet>,
  chainId: number,
  now: number,
  wantedOnline: number,
  enrollWidth: number,
  freshAllowed: boolean,
  _flow: FlowFile,
  fail: (message: string) => void,
  cooling = false,
) {
  await resumeSessions(wallets, fail)
  const repair = [...wallets.values()]
    .filter((wallet) => wallet.enrolled && !wallet.bound && wallet.nextEnroll <= now)
    .sort((left, right) => compareRank(enrollRank(left), enrollRank(right)))
  const enrolledCount = walletsEnrolled(wallets)
  const needed = Math.max(0, Math.min(swarmConfig.runner.keyCap, wantedOnline) - enrolledCount)
  // While cooling, never open fresh grants. Repair via stored token is safe (no mint).
  const fresh =
    !freshAllowed || needed === 0 || cooling
      ? []
      : [...wallets.values()]
          .filter((wallet) => !wallet.enrolled && wallet.nextEnroll <= now)
          .sort((left, right) => compareRank(enrollRank(left), enrollRank(right)))
          .slice(0, Math.min(needed, enrollWidth))
  const due = [...repair, ...fresh].slice(0, enrollWidth)
  if (due.length === 0) return
  await pool(due, enrollWidth, async (wallet) => {
    await bindWallet(wallets, wallet, chainId, fail)
  })
}

/** A small funded set stays on the field so the book is never empty. */
export function warmKeepAddresses(
  wallets: Map<string, { address: string; bankroll: number; enrolled: boolean; persona?: { mind: string; tempoWindows: number }; index?: number }>,
  keep = 5,
): string[] {
  const scored = [...wallets.values()].filter((wallet) => wallet.enrolled)
  const rank = (wallet: (typeof scored)[number]): [number, number, number, string] => [
    wallet.persona?.mind === "restless" ? 0 : 1,
    wallet.persona?.tempoWindows ?? 36,
    -wallet.bankroll,
    wallet.address,
  ]
  return scored
    .sort((left, right) => {
      const a = rank(left)
      const b = rank(right)
      for (let index = 0; index < 3; index++) {
        if (a[index]! !== b[index]!) return (a[index] as number) - (b[index] as number)
      }
      return a[3].localeCompare(b[3])
    })
    .slice(0, Math.max(0, keep))
    .map((wallet) => wallet.address)
}

/** Fresh grants pause while the funding plane is cooling or rate-limited. */
export function isCoolingError(message: string | null): boolean {
  if (!message) return false
  const lower = message.toLowerCase()
  return (
    lower.includes("near_cooling") ||
    lower.includes("cooling") ||
    lower.includes("429") ||
    lower.includes("503") ||
    lower.includes("rate-limited") ||
    lower.includes("rate limited") ||
    lower.includes("rpc")
  )
}

async function bindWallet(wallets: Map<string, LiveWallet>, wallet: LiveWallet, chainId: number, fail: (message: string) => void) {
  if (wallet.token) {
    const rebound = await callMarket("sign_in", { token: wallet.token }, 15_000)
    if (rebound.transport) {
      noteTransport(wallets, rebound)
      wallet.nextEnroll = Date.now() + 5_000
      fail(toolError(rebound))
      return
    }
    if (rebound.ok && rebound.body.address === wallet.address && typeof rebound.body.balanceMicros === "number") {
      wallet.bound = true
      wallet.enrolled = true
      wallet.bankroll = rebound.body.balanceMicros
      wallet.dirty = true
      return
    }
  }
  const issued = Date.now()
  const signed = await signLogin(wallet, chainId, issued)
  if (!signed) {
    wallet.bound = false
    wallet.nextEnroll = Date.now() + 5_000
    fail("Enroll failed")
    return
  }
  const opened = await callMarket(
    "sign_in",
    {
      address: wallet.address,
      signature: signed.signature,
      issued,
      ...(signed.nonce ? { nonce: signed.nonce, publicKey: signed.publicKey } : {}),
    },
    15_000,
  )
  if (opened.transport) {
    noteTransport(wallets, opened)
    wallet.nextEnroll = Date.now() + 5_000
    fail(toolError(opened))
    return
  }
  const token = opened.body.token
  if (!opened.ok || opened.body.address !== wallet.address || typeof opened.body.balanceMicros !== "number" || typeof token !== "string") {
    wallet.bound = false
    wallet.nextEnroll = Date.now() + 5_000
    fail(toolError(opened))
    return
  }
  wallet.token = token
  wallet.enrolled = true
  wallet.bound = true
  wallet.bankroll = opened.body.balanceMicros
  wallet.dirty = true
}

async function signLogin(
  wallet: LiveWallet,
  chainId: number,
  issued: number,
): Promise<{ signature: string; nonce?: string; publicKey?: string } | null> {
  if (activeChainKey() === "near-testnet") {
    const nonce = crypto.getRandomValues(new Uint8Array(32))
    const seed = seedFromSecret(wallet.privateKey)
    const pub = await publicKeyBytes(wallet.privateKey)
    if (!seed || !pub) return null
    const signature = await ed.signAsync(sha256Bytes(nep413Bytes(nearLoginMessage(wallet.address, issued), nonce, NEP413_RECIPIENT)), seed)
    return { signature: hex(signature), nonce: Buffer.from(nonce).toString("base64"), publicKey: `ed25519:${bs58.encode(pub)}` }
  }
  const signature = await privateKeyToAccount(wallet.privateKey as `0x${string}`).signMessage({
    message: loginMessage(chainId, wallet.address, issued),
  })
  return { signature }
}

function hex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

/** Only a new MCP session invalidates every account binding on the lane. */
function unbindAll(wallets: Map<string, LiveWallet>) {
  for (const wallet of wallets.values()) {
    wallet.bound = false
    wallet.nextEnroll = 0
  }
}

/** A real auth failure is scoped to the wallet that received it. */
function unbindWallet(wallet: LiveWallet | undefined, now = Date.now()) {
  if (!wallet) return
  wallet.bound = false
  wallet.nextEnroll = now + 5_000
}

/** A transport failure without a new MCP session keeps every binding. */
export function transportAction(reply: ToolReply): "none" | "backoff" | "unbind" {
  if (!reply.transport) return "none"
  return reply.sessionLost ? "unbind" : "backoff"
}

function noteTransport(wallets: Map<string, LiveWallet>, reply: ToolReply) {
  if (!reply.transport) return
  const message = toolError(reply)
  console.error(`market transport lost: ${message}`)
  if (transportAction(reply) === "unbind") {
    // The old MCP session is gone, which is what a market restart looks like.
    // Stored tokens stay on the wallets; resume_sessions re-establishes them.
    unbindAll(wallets)
    return
  }
  // A network error keeps tokens and bindings. Back the repair batch off
  // instead of unbinding thousands of wallets and starting a resume storm.
  backOffRepair(wallets.values())
}

/** The market connection forgot this account, so only this wallet is suspect. */
export function isAuthError(message: string): boolean {
  return /^(sign in first|sign in on this market|name the account)$/i.test(message.trim())
}

function toolError(reply: ToolReply): string {
  return typeof reply.body.error === "string" ? reply.body.error : "Enroll failed"
}

async function loadBook(
  db: ReturnType<typeof openSwarm>,
  wallets: Map<string, LiveWallet>,
  readCursor: () => number,
  writeCursor: (value: number) => void,
): Promise<Book | null> {
  const live = await callMarket("book", { tailMs: swarmConfig.runner.tapeTailMs }, 15_000)
  if (live.transport) {
    noteTransport(wallets, live)
    return null
  }
  if (!live.ok) return null
  const board = liveBook(live.body)
  if (!board) return null
  // A fresh local DB has no stakes and no cursor. Start replay at the current
  // clock instead of walking every settled round the market has ever produced.
  if (readCursor() <= 0 && board.joinId >= 0 && minStakeRoundAfter(db, 0) === null) {
    writeCursor(board.joinId - 1)
  }
  const settled: Book["settled"] = []
  let scan = readCursor()
  for (;;) {
    const page = await callMarket("rounds", { limit: 100, after: scan }, 15_000)
    if (page.transport) {
      noteTransport(wallets, page)
      break
    }
    if (!page.ok) break
    const rows = settledRounds(page.body)
    if (!rows || rows.length === 0) break
    const last = rows[rows.length - 1]
    if (!last || last.id <= scan) break
    settled.push(...rows)
    scan = last.id
    if (rows.length < 100) break
  }
  const recentPage = await callMarket("rounds", { limit: 8 }, 15_000)
  if (recentPage.transport) noteTransport(wallets, recentPage)
  const recent = recentPage.ok ? (recentRounds(recentPage.body) ?? []) : []
  const book: Book = { ...board, settled, recent }
  await applySettled(db, wallets, book, readCursor, writeCursor)
  return book
}

async function applySettled(
  db: ReturnType<typeof openSwarm>,
  wallets: Map<string, LiveWallet>,
  book: Book,
  readCursor: () => number,
  writeCursor: (value: number) => void,
) {
  let cursor = readCursor()
  for (const settled of book.settled) {
    if (settled.id <= cursor) continue
    const ours = stakesFor(db, settled.id)
    if (ours.length > 0) {
      const outcome = replayPayouts({
        ours,
        poolUpMicros: settled.poolUpMicros,
        poolDownMicros: settled.poolDownMicros,
        strike: settled.strike,
        settle: settled.settle,
        feeBps: feeBps(),
        voided: settled.resolution === "void",
      })
      const payouts = outcome.payouts.filter((payout) => payout.address !== "other")
      for (const payout of payouts) {
        const wallet = wallets.get(payout.address)
        if (!wallet) continue
        wallet.bankroll += payout.payoutMicros
        if (outcome.resolution === "paid") {
          const won = payout.payoutMicros > 0
          wallet.gate = noteResult(wallet.gate, won, wallet.persona, swarmConfig.persona)
          if (won) wallet.wins += 1
          else wallet.losses += 1
        }
        wallet.dirty = true
      }
    }
    cursor = settled.id
  }
  writeCursor(cursor)
}

async function postOrders(
  db: ReturnType<typeof openSwarm>,
  pending: Pending,
  wallets: Map<string, LiveWallet>,
  flow: FlowFile,
  fail: (message: string) => void,
): Promise<{
  done: boolean
  count: number
  up: number
  down: number
  stakes: number[]
  attempted: number
  rejected: number
  lastReject: string | null
}> {
  let count = 0
  let up = 0
  let down = 0
  let attempted = 0
  let rejected = 0
  let lastReject: string | null = null
  const stakes: number[] = []
  const accepted: { address: string; side: Side; stakeMicros: number }[] = []
  while (pending.sent < pending.orders.length) {
    if (Date.now() >= pending.endsAt - swarmConfig.timing.marginMs) {
      return { done: false, count, up, down, stakes, attempted, rejected, lastReject }
    }
    const part = pending.orders.slice(pending.sent, pending.sent + swarmConfig.runner.betChunk)
    const response = await callMarket("place_buy_ins", { orders: part, roundId: pending.roundId }, 15_000)
    if (response.transport) noteTransport(wallets, response)
    const results = Array.isArray(response.body.results)
      ? (response.body.results as { address?: unknown; ok?: unknown; balanceMicros?: unknown; error?: unknown }[])
      : null
    attempted += part.length
    if (!response.ok || !results) {
      const error = typeof response.body.error === "string" ? response.body.error : "Buy-in chunk failed"
      rejected += part.length
      lastReject = error
      fail(error)
      if (isAuthError(error)) {
        for (const order of part) unbindWallet(wallets.get(order.address))
        return { done: true, count, up, down, stakes, attempted, rejected, lastReject }
      }
      if (response.body.code === "late" || error === "Buy-in is closed" || error === "Price feed is delayed") {
        return { done: true, count, up, down, stakes, attempted, rejected, lastReject }
      }
      return { done: false, count, up, down, stakes, attempted, rejected, lastReject }
    }
    for (const result of results) {
      if (result.ok !== true) {
        rejected += 1
        if (typeof result.error === "string" && result.error) lastReject = result.error
        continue
      }
      if (typeof result.address !== "string") continue
      const order = part.find((item) => item.address === result.address)
      const wallet = wallets.get(result.address)
      if (!order || !wallet) continue
      wallet.bankroll = typeof result.balanceMicros === "number" ? result.balanceMicros : wallet.bankroll - order.stakeMicros
      wallet.lastSide = order.side
      wallet.lastStake = order.stakeMicros
      setSkip(wallet, null)
      wallet.dirty = true
      flow.stakeMicros += order.stakeMicros
      accepted.push(order)
      count += 1
      stakes.push(order.stakeMicros)
      if (order.side === "up") up += order.stakeMicros
      else down += order.stakeMicros
    }
    pending.sent += part.length
  }
  if (accepted.length > 0) saveStakes(db, pending.roundId, accepted)
  return { done: true, count, up, down, stakes, attempted, rejected, lastReject }
}

async function audit(wallets: Map<string, LiveWallet>, cursor: number, setCursor: (value: number) => void) {
  const enrolled = [...wallets.values()].filter((wallet) => wallet.enrolled && wallet.bound)
  if (enrolled.length === 0) return
  const start = cursor >= enrolled.length ? 0 : cursor
  const slice = enrolled.slice(start, start + swarmConfig.runner.auditSlice)
  let dropped = false
  await pool(slice, swarmConfig.runner.enrollWidth, async (wallet) => {
    if (dropped) return
    const response = await callMarket("account", { address: wallet.address })
    if (response.transport) {
      noteTransport(wallets, response)
      dropped = true
      return
    }
    if (response.ok && response.body.address === wallet.address && typeof response.body.balanceMicros === "number") {
      // An unchanged balance is the common case; do not rewrite the row for it.
      if (wallet.bankroll !== response.body.balanceMicros) {
        wallet.bankroll = response.body.balanceMicros
        wallet.dirty = true
      }
      return
    }
    if (isAuthError(toolError(response))) {
      unbindWallet(wallet)
    }
  })
  const next = start + slice.length
  setCursor(next >= enrolled.length ? 0 : next)
}

async function bankPass(wallets: Map<string, LiveWallet>, flow: FlowFile, fail: (message: string) => void) {
  let coolingLogged = false
  for (const wallet of wallets.values()) {
    if (!wallet.enrolled) continue
    const action = bankAction(wallet.bankroll, wallet.index, swarmConfig.bank, wallet.handled)
    if (action.kind === "none") {
      if (wallet.handled) {
        wallet.handled = false
        wallet.dirty = true
      }
      continue
    }
    if (!wallet.bound) continue
    const response = await callMarket("withdraw", { address: wallet.address, amountMicros: action.amountMicros })
    if (response.transport) {
      noteTransport(wallets, response)
      fail(typeof response.body.error === "string" ? response.body.error : "Withdrawal failed")
      return
    }
    const body = response.body as { error?: unknown; code?: unknown; balanceMicros?: unknown }
    if (body.code === "NEAR_COOLING") {
      if (!coolingLogged) {
        coolingLogged = true
        console.error("withdraw paused: NEAR funding cooling, retryable")
      }
      continue
    }
    if (!response.ok || typeof response.body.balanceMicros !== "number") {
      const error = typeof response.body.error === "string" ? response.body.error : "Withdrawal failed"
      fail(error)
      if (isAuthError(error)) {
        unbindWallet(wallet)
        continue
      }
      continue
    }
    wallet.bankroll = response.body.balanceMicros
    wallet.handled = true
    wallet.dirty = true
    flow.burnMicros += action.amountMicros
  }
}

function settlesOf(recent: Book["recent"] | undefined): Side[] {
  if (!recent) return []
  const sides: Side[] = []
  for (const row of recent) {
    if (row.winningSide === "up" || row.winningSide === "down") sides.push(row.winningSide)
  }
  return sides
}

function pointsOf(tape: { t: number; price: string }[], now: number): PrintPoint[] {
  const out: PrintPoint[] = []
  for (const point of tape) {
    const price = Number(point.price)
    if (!Number.isFinite(price)) continue
    if (point.t > now) continue
    out.push({ t: point.t, price })
  }
  return out
}

function directorTape(points: PrintPoint[]): TapeStats {
  if (points.length < 2) return { absReturn: 1, volatility: 1 }
  const first = points[0]!.price
  const last = points[points.length - 1]!.price
  const absReturn = first === 0 ? 0 : Math.abs((last - first) / first)
  let vol = 0
  for (let index = 1; index < points.length; index++) {
    const prev = points[index - 1]!.price
    if (prev !== 0) vol += Math.abs(points[index]!.price - prev) / prev
  }
  vol /= points.length - 1
  return { absReturn, volatility: Math.max(vol, 1e-6) }
}

function presenceBend(points: PrintPoint[], now: number): { moving: boolean; flat: boolean } {
  if (points.length < 2) return { moving: false, flat: false }
  const activity = tapeActivity(points, now, 8_000).activity
  return { moving: activity >= swarmConfig.persona.movingBand, flat: activity <= swarmConfig.persona.flatBand }
}

function buildSnapshot(input: {
  now: number
  view: DirectorView | null
  director: DirectorState
  wallets: Map<string, LiveWallet>
  flow: FlowFile
  lastError: string | null
  book: Book | null
  bookAt: number | null
  arrivedMinute: number
  leftMinute: number
  trace: number[]
  windowStats: {
    roundId: number | null
    buyIns: number
    skips: number
    up: number
    down: number
    stakes: number[]
    attempted: number
    rejected: number
    lastReject: string | null
  }
  dirtyWallets: number
  flushedWallets: number
  cosmeticWallets: number
  cosmeticFlushed: number
  writeBytesPerMin: number | null
  dbBytes: number
  walBytes: number
  running: boolean
}): SwarmSnapshot {
  const steered = steering()
  const view = input.view
  const endpoint = peekApiEndpoint(loadEnv().apiUrl)
  const stakes = percentiles(input.windowStats.stakes)
  const balances = [...input.wallets.values()].filter((wallet) => wallet.enrolled).map((wallet) => wallet.bankroll)
  return {
    at: input.now,
    manila: manilaClock(input.now, swarmConfig.clock.timeZoneOffsetHours),
    phase: view?.phase ?? "clock",
    hour: view?.hour ?? 0,
    window: view ? [view.window[0], view.window[1]] : [0, 0],
    online: input.running ? walletsOnline(input.wallets) : 0,
    enrolled: walletsEnrolled(input.wallets),
    bound: input.running ? walletsBound(input.wallets) : 0,
    pid: input.running ? process.pid : null,
    running: input.running,
    spring: input.director.value,
    target: view?.target ?? input.director.value,
    arrivedMinute: input.arrivedMinute,
    leftMinute: input.leftMinute,
    trace: input.trace,
    book: {
      roundId: input.book?.joinId ?? input.windowStats.roundId,
      upMicros: input.book?.poolUpMicros ?? 0,
      downMicros: input.book?.poolDownMicros ?? 0,
      botUpMicros: input.windowStats.up,
      botDownMicros: input.windowStats.down,
      buyIns: input.windowStats.buyIns,
      skips: input.windowStats.skips,
      attempted: input.windowStats.attempted,
      rejected: input.windowStats.rejected,
      lastReject: input.windowStats.lastReject,
      p50: stakes.p50,
      p90: stakes.p90,
    },
    money: { ...input.flow, histogram: histogram(balances) },
    lastError: input.lastError,
    bookLagMs: input.bookAt === null ? null : input.now - input.bookAt,
    buyInPaused: steered.control.buyInPaused,
    bleed: steered.control.bleed,
    mode: steered.pin !== null ? "pin" : steered.control.mode,
    pin: steered.pin,
    apiHost: endpoint.host,
    apiIp: endpoint.ip,
    writeBytesPerMin: input.writeBytesPerMin,
    dbBytes: input.dbBytes,
    walBytes: input.walBytes,
    dirtyWallets: input.dirtyWallets,
    flushedWallets: input.flushedWallets,
    cosmeticWallets: input.cosmeticWallets,
    cosmeticFlushed: input.cosmeticFlushed,
  }
}

function walletsOnline(wallets: Map<string, LiveWallet>): number {
  let count = 0
  for (const wallet of wallets.values()) if (wallet.online && wallet.enrolled) count += 1
  return count
}

function walletsEnrolled(wallets: Map<string, LiveWallet>): number {
  let count = 0
  for (const wallet of wallets.values()) if (wallet.enrolled) count += 1
  return count
}

function walletsBound(wallets: Map<string, LiveWallet>): number {
  let count = 0
  for (const wallet of wallets.values()) if (wallet.enrolled && wallet.bound) count += 1
  return count
}

function loadNearKeyFile(): NearStoredKey[] {
  if (!existsSync(NEAR_KEYS_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(NEAR_KEYS_PATH, "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((row) => {
      if (!row || typeof row !== "object") return []
      const key = row as { account?: unknown; privateKey?: unknown }
      if (typeof key.account !== "string" || typeof key.privateKey !== "string") return []
      return [{ account: key.account, privateKey: key.privateKey }]
    })
  } catch {
    return []
  }
}

function saveNearKeyFile(keys: NearStoredKey[]) {
  mkdirSync(dirname(NEAR_KEYS_PATH), { recursive: true })
  writeFileSync(NEAR_KEYS_PATH, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 })
  chmodSync(NEAR_KEYS_PATH, 0o600)
}

function loadKeyFile(): StoredKey[] {
  if (!existsSync(KEYS_PATH)) return []
  try {
    const parsed = JSON.parse(readFileSync(KEYS_PATH, "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((row) => {
      if (!row || typeof row !== "object" || typeof (row as { privateKey?: unknown }).privateKey !== "string") return []
      const key = row as { address?: unknown; privateKey: string }
      return [{ address: typeof key.address === "string" ? key.address : "", privateKey: key.privateKey as `0x${string}` }]
    })
  } catch {
    return []
  }
}

function saveKeyFile(keys: StoredKey[]) {
  mkdirSync(dirname(KEYS_PATH), { recursive: true })
  writeFileSync(KEYS_PATH, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600 })
  chmodSync(KEYS_PATH, 0o600)
}

async function pool<T>(items: T[], width: number, job: (item: T) => Promise<void>) {
  let cursor = 0
  const workers = Array.from({ length: Math.min(width, items.length) }, async () => {
    while (cursor < items.length) {
      const item = items[cursor]
      cursor += 1
      if (item === undefined) return
      await job(item)
    }
  })
  await Promise.all(workers)
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

let stopRequested = false

const lanePublish = new Map<string, { snapshot: SwarmSnapshot; flow: FlowFile }>()

/** One crowd, divided by the split. A share of 100 leaves the clock unchanged. */
export function scaleCrowd(view: DirectorView, share: number): DirectorView {
  const factor = share / 100
  if (factor === 1) return view
  return {
    ...view,
    center: view.center * factor,
    target: view.target * factor,
    online: view.online * factor,
    window: [view.window[0] * factor, view.window[1] * factor] as [number, number],
  }
}

function laneFlowPath(chain: string): string {
  return join(dirname(FLOW_PATH), `flow.${chain}.json`)
}

function publishLane(chain: string, snapshot: SwarmSnapshot, flow: FlowFile) {
  lanePublish.set(chain, { snapshot, flow })
  // These files are rewritten every second and machine-read; compact JSON cuts
  // the write bytes. The operator's control file keeps the pretty default.
  writeJsonAtomic(laneFlowPath(chain), flow, false)
  const rows = [...lanePublish.values()]
  const merged = rows.length === 1 ? rows[0]!.snapshot : mergeLanes(rows.map((row) => row.snapshot))
  const flowSum = rows.reduce(
    (sum, row) => ({
      seedMicros: sum.seedMicros + row.flow.seedMicros,
      mintMicros: sum.mintMicros + row.flow.mintMicros,
      burnMicros: sum.burnMicros + row.flow.burnMicros,
      stakeMicros: sum.stakeMicros + row.flow.stakeMicros,
    }),
    { seedMicros: 0, mintMicros: 0, burnMicros: 0, stakeMicros: 0 },
  )
  publishStats(merged)
  writeJsonAtomic(SWARM_PATH, merged, false)
  writeJsonAtomic(STATUS_PATH, merged, false)
  writeJsonAtomic(FLOW_PATH, flowSum, false)
}

/** Heads and stakes add. The spring is the shared clock, so it stays the max, not a sum. */
export function mergeLanes(rows: SwarmSnapshot[]): SwarmSnapshot {
  const newest = rows.reduce((best, row) => (row.at >= best.at ? row : best))
  const book = rows.reduce((best, row) => (row.book.buyIns >= best.book.buyIns ? row : best)).book
  const bands = new Map<string, number>()
  for (const row of rows) {
    for (const band of row.money.histogram) bands.set(band.band, (bands.get(band.band) ?? 0) + band.count)
  }
  const errors = rows.map((row) => row.lastError).filter((item): item is string => Boolean(item))
  const lags = rows.map((row) => row.bookLagMs).filter((item): item is number => typeof item === "number")
  const lastReject = rows.map((row) => row.book.lastReject).find((item): item is string => Boolean(item)) ?? null
  return {
    ...newest,
    at: newest.at,
    window: [
      rows.reduce((sum, row) => sum + row.window[0], 0),
      rows.reduce((sum, row) => sum + row.window[1], 0),
    ],
    online: rows.reduce((sum, row) => sum + row.online, 0),
    enrolled: rows.reduce((sum, row) => sum + (row.enrolled ?? 0), 0),
    bound: rows.reduce((sum, row) => sum + (row.bound ?? 0), 0),
    // Per-flush row counts add across lanes; the write meter reads the whole
    // process, so the newest lane's numbers stand via the spread above.
    dirtyWallets: rows.reduce((sum, row) => sum + (row.dirtyWallets ?? 0), 0),
    flushedWallets: rows.reduce((sum, row) => sum + (row.flushedWallets ?? 0), 0),
    cosmeticWallets: rows.reduce((sum, row) => sum + (row.cosmeticWallets ?? 0), 0),
    cosmeticFlushed: rows.reduce((sum, row) => sum + (row.cosmeticFlushed ?? 0), 0),
    arrivedMinute: rows.reduce((sum, row) => sum + row.arrivedMinute, 0),
    leftMinute: rows.reduce((sum, row) => sum + row.leftMinute, 0),
    target: rows.reduce((sum, row) => sum + row.target, 0),
    spring: Math.max(...rows.map((row) => row.spring)),
    trace: sumTraces(rows),
    running: rows.some((row) => row.running !== false),
    lastError: errors.length > 0 ? errors.join(" · ") : null,
    bookLagMs: lags.length > 0 ? Math.max(...lags) : null,
    book: {
      ...book,
      botUpMicros: rows.reduce((sum, row) => sum + row.book.botUpMicros, 0),
      botDownMicros: rows.reduce((sum, row) => sum + row.book.botDownMicros, 0),
      buyIns: rows.reduce((sum, row) => sum + row.book.buyIns, 0),
      skips: rows.reduce((sum, row) => sum + row.book.skips, 0),
      attempted: rows.reduce((sum, row) => sum + (row.book.attempted ?? 0), 0),
      rejected: rows.reduce((sum, row) => sum + (row.book.rejected ?? 0), 0),
      lastReject,
    },
    money: {
      seedMicros: rows.reduce((sum, row) => sum + row.money.seedMicros, 0),
      mintMicros: rows.reduce((sum, row) => sum + row.money.mintMicros, 0),
      burnMicros: rows.reduce((sum, row) => sum + row.money.burnMicros, 0),
      stakeMicros: rows.reduce((sum, row) => sum + row.money.stakeMicros, 0),
      histogram: [...bands.entries()].map(([band, count]) => ({ band, count })),
    },
  }
}

function sumTraces(rows: SwarmSnapshot[]): number[] {
  const length = Math.max(...rows.map((row) => row.trace.length))
  const out: number[] = []
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (const row of rows) {
      const value = row.trace[row.trace.length - length + i]
      if (typeof value === "number") sum += value
    }
    out.push(sum)
  }
  return out.slice(-180)
}

if (import.meta.main) await main()
