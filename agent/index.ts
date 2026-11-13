import * as ed from "@noble/ed25519"
import bs58 from "bs58"
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { privateKeyToAccount } from "viem/accounts"
import { requireSepoliaToken } from "../shared/chain"
import { loginMessage, nearLoginMessage } from "../shared/login"
import { loadMarket, marketPreferences, requireExplicitChain } from "../shared/market"
import { parseAgentSplit } from "../shared/split"
import { requireNearToken } from "../shared/near"
import { accountFromSecret, NEP413_RECIPIENT, nep413Bytes, publicKeyBytes, seedFromSecret, sha256Bytes } from "../shared/nearKey"
import { feeBps, windowMs } from "../server/config"
import { configuredChain, loadEnv } from "../server/env"
import { getDb, importLegacySwarm } from "../server/db"
import { assertQmMetadata, fundedAgents, inspectNear, NearConfigError, readTokenMetadata } from "../server/nearInspect"
import { bankAction } from "./bank"
import { callMarket, liveBook, openMarket, recentRounds, settledRounds, type ToolReply } from "./mcp"
import { checkConfig, swarmConfig, type TapeStats } from "./config"
import { admitWallet, decideOpen, freshGate, noteResult, tapeActivity, type GateState, type PrintPoint, type Side } from "./decide"
import { fireAt, releaseWave, type FireSlot } from "./schedule"
import { createDirector, manilaHour, stepDirector, type DirectorState, type DirectorView } from "./director"
import { growKeys, growNearKeys, type NearStoredKey, type StoredKey } from "./keys"
import { personaFor, type Persona } from "./persona"
import { openClock, stepPresence, type Arrival, type WalletClock } from "./presence"
import { replayPayouts } from "./replay"
import { peekApiEndpoint, refreshApiEndpoint } from "./endpoint"
import { histogram, manilaClock, parseControl, parseFlow, percentiles, type FlowFile, type SwarmSnapshot } from "./status"
import { publishStats, startStatsServer } from "./stats"
import { CONTROL_PATH, FLOW_PATH, KEYS_PATH, NEAR_KEYS_PATH, STATUS_PATH, SWARM_PATH, readJson, writeJsonAtomic } from "./store"
import {
  loadWalletMap,
  metaGet,
  metaSet,
  minStakeRoundAfter,
  noteWindow,
  openSwarm,
  pruneUnenrolled,
  saveStakes,
  saveWallets,
  stakesFor,
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
  if (split.near !== 0) {
    console.error("NEAR agent trading is not enabled. Set AGENT_SPLIT_NEAR=0.")
    process.exit(1)
  }
  if (marketPreferences.chain === "near-testnet") {
    console.error("The swarm does not run on NEAR.")
    process.exit(1)
  }
  const problem = checkConfig(swarmConfig)
  if (problem) {
    console.error(problem)
    process.exit(1)
  }
  const stats = startStatsServer()
  if (stats) console.log(`agent stats on http://0.0.0.0:${stats.port}/api/health`)
  const chain = configuredChain()
  const near = marketPreferences.chain === "near-testnet"
  let funded: Set<string> | null = null
  if (near) {
    requireNearToken(chain.key, loadEnv().tokenAccount)
    const treasury = await accountFromSecret(loadEnv().treasuryPrivateKey)
    if (!treasury) {
      console.error("TREASURY_PRIVATE_KEY must be an ed25519 NEAR secret key")
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
    funded = fundedAgents(report)
  } else {
    requireSepoliaToken(chain)
  }

  const db = getDb()
  importLegacySwarm(db, loadEnv().dbPath)
  openSwarm(db)
  pruneUnenrolled(db)
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
    await openMarket(loadEnv().apiUrl, marketPreferences.chain)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
  }
  await pool(
    [...wallets.values()].filter((wallet) => wallet.enrolled),
    swarmConfig.runner.enrollWidth,
    async (wallet) => {
      await bindWallet(wallets, wallet, chain.id, (message) => {
        console.error(message)
      })
    },
  )
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
  let enrolling = false
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
  let flow = parseFlow(readJson(FLOW_PATH))
  let lastError: string | null = null
  let windowStats = { roundId: null as number | null, buyIns: 0, skips: 0, up: 0, down: 0, stakes: [] as number[] }
  let lastView: DirectorView | null = null
  let stopping = false

  const flush = (running = !stopping) => {
    const dirty = [...wallets.values()].filter((wallet) => wallet.dirty && wallet.enrolled).map((wallet) => toRow(wallet))
    saveWallets(db, dirty)
    for (const wallet of wallets.values()) if (wallet.enrolled) wallet.dirty = false
    metaSet(db, "spring", String(director.value))
    metaSet(db, "velocity", String(director.velocity))
    metaSet(db, "settle_cursor", String(cursor))
    metaSet(db, "trace", JSON.stringify(trace.slice(-180)))
    const snapshot = buildSnapshot({
      now: Date.now(),
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
      running,
    })
    publishStats(snapshot)
    writeJsonAtomic(SWARM_PATH, snapshot)
    writeJsonAtomic(STATUS_PATH, snapshot)
    writeJsonAtomic(FLOW_PATH, flow)
  }

  const stop = () => {
    if (stopping) return
    stopping = true
    flush(false)
    process.exit(0)
  }
  process.on("SIGINT", stop)
  process.on("SIGTERM", stop)

  const takeBook = (): Promise<Book | null> =>
    loadBook(db, wallets, () => cursor, (value) => {
      cursor = value
    })

  const dropQueued = (closing: Wave) => {
    for (const slot of closing.queue) {
      const wallet = wallets.get(slot.address)
      if (!wallet) continue
      wallet.lastSkip = "waiting"
      wallet.dirty = true
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

  while (!stopping) {
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
      const view = stepDirector(director, {
        now,
        dtSec: dt,
        tape,
        config: swarmConfig.clock,
        pin: steered.pin,
        hold: steered.hold,
      })
      lastView = view
      const room = Math.max(0, Math.floor(swarmConfig.clock.perSecond * Math.max(dt, 0)))
      const wanted = Math.min(
        swarmConfig.runner.keyCap,
        Math.max(Math.ceil(view.window[1]) + 15, Math.ceil(view.window[1] * 1.4)),
      )
      if (keys.length < wanted && room > 0) {
        if (marketPreferences.chain === "near-testnet") {
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
        perSecond: swarmConfig.clock.perSecond,
      })
      const byAddress = new Map(step.clocks.map((clock) => [clock.address, clock]))
      for (const wallet of enrolledWallets) {
        const clock = byAddress.get(wallet.address)
        if (!clock) continue
        if (clock.cursor !== wallet.clock.cursor || clock.visitEnd !== wallet.clock.visitEnd || clock.gapEnd !== wallet.clock.gapEnd) {
          wallet.dirty = true
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
        wallet.dirty = true
        arrivedMinute += 1
        recent.push({ index: wallet.index, at: now })
      }
      for (const address of step.left) {
        const wallet = wallets.get(address)
        if (!wallet || !wallet.online) continue
        wallet.online = false
        wallet.sleptAt = now
        wallet.dirty = true
        leftMinute += 1
      }
      while (recent.length > 0 && now - recent[0]!.at > swarmConfig.presence.herdWindowMs) recent.shift()

      flush()
      const needsSignIn = [...wallets.values()].some((wallet) => wallet.enrolled && !wallet.bound && wallet.nextEnroll <= now)
      if (!enrolling && (needsSignIn || enrolledWallets.length < Math.min(swarmConfig.runner.keyCap, Math.ceil(view.online)))) {
        enrolling = true
        void enrollDue(wallets, chain.id, now, Math.ceil(view.online), flow, (message) => {
          lastError = message
        }).finally(() => {
          enrolling = false
        })
      }

      if (lastJoin !== joinId) {
        const loaded = await takeBook()
        if (loaded) {
          book = loaded
          bookAt = Date.now()
          lastError = null
          lastJoin = joinId
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
          wallet.gate = admitted.gate
          wallet.dirty = true
          if (admitted.action === "skip") {
            wallet.lastSkip = admitted.reason
            skips += 1
            continue
          }
          queue.push({
            address: wallet.address,
            inBurst: admitted.inBurst,
            fireAt: fireAt(wallet.index, wallet.persona.mind, book.joinId, openAt, book.windowEndsAt, swarmConfig.timing),
          })
        }
        windowStats = { roundId: book.joinId, buyIns: 0, skips, up: 0, down: 0, stakes: [] }
        builtJoin = joinId
        if (queue.length === 0) {
          noteWindow(db, { id: book.joinId, buyIns: 0, skips, upMicros: 0, downMicros: 0, at: now })
        } else {
          wave = { roundId: book.joinId, openAt, endsAt: book.windowEndsAt, queue, taken: 0 }
        }
      } else if (book && book.joinId === joinId && now >= book.windowEndsAt - marginMs && wave === null) {
        builtJoin = joinId
      }

      if (wave && !buyInPaused && now < wave.endsAt - 150) {
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
              wallet.lastSkip = "waiting"
              wallet.dirty = true
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
                wallet.lastSkip = "unfunded"
                wallet.dirty = true
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
              wallet.gate = decision.gate
              wallet.dirty = true
              if (decision.action === "skip") {
                wallet.lastSkip = decision.reason
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
                wallet.lastSkip = "waiting"
                wallet.dirty = true
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
      } else if (wave && now >= wave.endsAt - 150) {
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
        }).finally(() => {
          banking = false
        })
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : "Swarm tick failed"
    }
    void refreshApiEndpoint(loadEnv().apiUrl)
    flush()
    const remain = book ? book.windowEndsAt - Date.now() : swarmConfig.runner.presenceTickMs
    const wait = Math.min(swarmConfig.runner.snapshotEveryMs, Math.max(40, remain))
    await sleep(wait)
  }
}

function steering(): { pin: number | null; hold: "off-peak" | "peak" | null; control: ReturnType<typeof parseControl> } {
  const control = parseControl(readJson(CONTROL_PATH))
  const pin = loadEnv().swarmPin
  if (pin !== null) return { pin: Math.max(1, Math.round(pin)), hold: null, control }
  if (control.mode === "pin") return { pin: control.pin ?? 1, hold: null, control }
  if (control.mode === "off-peak") return { pin: null, hold: "off-peak", control }
  if (control.mode === "peak") return { pin: null, hold: "peak", control }
  return { pin: null, hold: null, control }
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
      readyWindow: parsed.readyWindow < nowWindow - 20 ? nowWindow + stagger : parsed.readyWindow,
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

async function enrollDue(
  wallets: Map<string, LiveWallet>,
  chainId: number,
  now: number,
  wantedOnline: number,
  _flow: FlowFile,
  fail: (message: string) => void,
) {
  const repair = [...wallets.values()].filter((wallet) => wallet.enrolled && !wallet.bound && wallet.nextEnroll <= now)
  const enrolledCount = walletsEnrolled(wallets)
  const needed = Math.max(0, Math.min(swarmConfig.runner.keyCap, wantedOnline) - enrolledCount)
  const fresh =
    needed === 0
      ? []
      : [...wallets.values()]
          .filter((wallet) => !wallet.enrolled && wallet.nextEnroll <= now)
          .sort((left, right) => left.index - right.index)
          .slice(0, Math.min(needed, swarmConfig.runner.enrollWidth))
  const due = repair.length > swarmConfig.runner.enrollWidth ? repair : [...repair, ...fresh].slice(0, swarmConfig.runner.enrollWidth)
  if (due.length === 0) return
  await pool(due, swarmConfig.runner.enrollWidth, async (wallet) => {
    await bindWallet(wallets, wallet, chainId, fail)
  })
}

async function bindWallet(wallets: Map<string, LiveWallet>, wallet: LiveWallet, chainId: number, fail: (message: string) => void) {
  if (wallet.token) {
    const rebound = await callMarket("sign_in", { token: wallet.token })
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
  const opened = await callMarket("sign_in", {
    address: wallet.address,
    signature: signed.signature,
    issued,
    ...(signed.nonce ? { nonce: signed.nonce, publicKey: signed.publicKey } : {}),
  })
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
  if (marketPreferences.chain === "near-testnet") {
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

function noteTransport(wallets: Map<string, LiveWallet>, reply: ToolReply) {
  if (!reply.transport) return
  for (const wallet of wallets.values()) {
    wallet.bound = false
    wallet.nextEnroll = 0
  }
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
  const live = await callMarket("book", { tailMs: swarmConfig.runner.tapeTailMs })
  if (live.transport) {
    noteTransport(wallets, live)
    return null
  }
  if (!live.ok) return null
  const board = liveBook(live.body)
  if (!board) return null
  const settled: Book["settled"] = []
  let scan = readCursor()
  for (;;) {
    const page = await callMarket("rounds", { limit: 100, after: scan })
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
  const recentPage = await callMarket("rounds", { limit: 8 })
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
): Promise<{ done: boolean; count: number; up: number; down: number; stakes: number[] }> {
  let count = 0
  let up = 0
  let down = 0
  const stakes: number[] = []
  const accepted: { address: string; side: Side; stakeMicros: number }[] = []
  while (pending.sent < pending.orders.length) {
    if (Date.now() >= pending.endsAt - 150) return { done: false, count, up, down, stakes }
    const part = pending.orders.slice(pending.sent, pending.sent + swarmConfig.runner.betChunk)
    const response = await callMarket("place_buy_ins", { orders: part, roundId: pending.roundId })
    if (response.transport) noteTransport(wallets, response)
    const results = Array.isArray(response.body.results)
      ? (response.body.results as { address?: unknown; ok?: unknown; balanceMicros?: unknown }[])
      : null
    if (!response.ok || !results) {
      const error = typeof response.body.error === "string" ? response.body.error : "Buy-in chunk failed"
      fail(error)
      if (response.body.code === "late" || error === "Buy-in is closed" || error === "Price feed is delayed") {
        return { done: true, count, up, down, stakes }
      }
      return { done: false, count, up, down, stakes }
    }
    for (const result of results) {
      if (result.ok !== true || typeof result.address !== "string") continue
      const order = part.find((item) => item.address === result.address)
      const wallet = wallets.get(result.address)
      if (!order || !wallet) continue
      wallet.bankroll = typeof result.balanceMicros === "number" ? result.balanceMicros : wallet.bankroll - order.stakeMicros
      wallet.lastSide = order.side
      wallet.lastStake = order.stakeMicros
      wallet.lastSkip = null
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
  return { done: true, count, up, down, stakes }
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
      wallet.bankroll = response.body.balanceMicros
      wallet.dirty = true
    }
  })
  const next = start + slice.length
  setCursor(next >= enrolled.length ? 0 : next)
}

async function bankPass(wallets: Map<string, LiveWallet>, flow: FlowFile, fail: (message: string) => void) {
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
    if (!response.ok || typeof response.body.balanceMicros !== "number") {
      fail(typeof response.body.error === "string" ? response.body.error : "Withdrawal failed")
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
  windowStats: { roundId: number | null; buyIns: number; skips: number; up: number; down: number; stakes: number[] }
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

if (import.meta.main) await main()
