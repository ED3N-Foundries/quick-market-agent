import { Database } from "bun:sqlite"
import { existsSync } from "node:fs"
import { loadEnv } from "../server/env"
import { activeChainKey } from "../server/activeChain"
import { rosterAggregates, rosterSorted, type RosterDir, type RosterFilter, type RosterSort } from "./swarmdb"
import { shortAddress, type SwarmSnapshot } from "./status"

export type AgentHealthBook = {
  roundId: number | null
  upMicros: number
  downMicros: number
  botUpMicros: number
  botDownMicros: number
  buyIns: number
  skips: number
  attempted?: number
  rejected?: number
  lastReject?: string | null
  p50: number
  p90: number
}

export type AgentHealthMoney = {
  seedMicros: number
  mintMicros: number
  burnMicros: number
  stakeMicros: number
  histogram: { band: string; count: number }[]
}

export type AgentHealthLive = {
  ok: true
  running: boolean
  at: number
  manila: string
  phase: string
  hour: number
  window: [number, number]
  online: number
  enrolled: number | null
  bound: number | null
  pid: number | null
  spring: number
  target: number
  arrivedMinute: number
  leftMinute: number
  trace: number[]
  book: AgentHealthBook
  money: AgentHealthMoney
  lastError: string | null
  bookLagMs: number | null
  buyInPaused: boolean
  bleed: boolean
  mode: string
  pin: number | null
  apiHost: string | null
  apiIp: string | null
  /** Whole-process write rate from /proc/self/io; null until a second sample exists. */
  writeBytesPerMin: number | null
  /** Agent DB and WAL file sizes in bytes. */
  dbBytes: number
  walBytes: number
  /** Wallet rows the latest flush found dirty, and the rows it wrote back. */
  dirtyWallets: number
  flushedWallets: number
  onlineAvg: number | null
  skipRate: number | null
}

export type AgentHealthBody = { ok: true; running: false; at: null } | AgentHealthLive

let latest: SwarmSnapshot | null = null

export function publishStats(snapshot: SwarmSnapshot) {
  latest = snapshot
}

export function resetStats() {
  latest = null
}

/** Mean of the per-minute online trace. Null when the trace is empty. */
export function onlineAverage(trace: number[]): number | null {
  if (trace.length === 0) return null
  return trace.reduce((sum, value) => sum + value, 0) / trace.length
}

/** Skip share of this window. Null when nobody has bought in or skipped. */
export function skipRate(buyIns: number, skips: number): number | null {
  const total = buyIns + skips
  if (!(total > 0)) return null
  return skips / total
}

export function statsPort(env: { STATS_PORT?: string } = process.env): number {
  const raw = env.STATS_PORT?.trim() ?? ""
  if (raw === "") return 3011
  if (raw === "0") return 0
  const port = Number(raw)
  if (!Number.isInteger(port) || port < 0 || port > 65535) return 3011
  return port
}

/** Public snapshot. Extra fields on the input, including keys and addresses, are dropped. */
export function statsBody(snapshot: SwarmSnapshot | null = latest): AgentHealthBody {
  if (!snapshot) return { ok: true, running: false, at: null }
  const trace = snapshot.trace.filter((value) => typeof value === "number" && Number.isFinite(value)).slice(-180)
  const book: AgentHealthBook = {
    roundId: typeof snapshot.book.roundId === "number" ? snapshot.book.roundId : null,
    upMicros: finite(snapshot.book.upMicros),
    downMicros: finite(snapshot.book.downMicros),
    botUpMicros: finite(snapshot.book.botUpMicros),
    botDownMicros: finite(snapshot.book.botDownMicros),
    buyIns: finite(snapshot.book.buyIns),
    skips: finite(snapshot.book.skips),
    attempted: finite(snapshot.book.attempted ?? 0),
    rejected: finite(snapshot.book.rejected ?? 0),
    lastReject: typeof snapshot.book.lastReject === "string" ? snapshot.book.lastReject.slice(0, 300) : null,
    p50: finite(snapshot.book.p50),
    p90: finite(snapshot.book.p90),
  }
  return {
    ok: true,
    running: snapshot.running === true,
    at: snapshot.at,
    manila: snapshot.manila,
    phase: snapshot.phase,
    hour: finite(snapshot.hour),
    window: [finite(snapshot.window[0]), finite(snapshot.window[1])],
    online: finite(snapshot.online),
    enrolled: typeof snapshot.enrolled === "number" && Number.isFinite(snapshot.enrolled) ? snapshot.enrolled : null,
    bound: typeof snapshot.bound === "number" && Number.isFinite(snapshot.bound) ? snapshot.bound : null,
    pid: typeof snapshot.pid === "number" && Number.isFinite(snapshot.pid) ? snapshot.pid : null,
    spring: finite(snapshot.spring),
    target: finite(snapshot.target),
    arrivedMinute: finite(snapshot.arrivedMinute),
    leftMinute: finite(snapshot.leftMinute),
    trace,
    book,
    money: {
      seedMicros: finite(snapshot.money.seedMicros),
      mintMicros: finite(snapshot.money.mintMicros),
      burnMicros: finite(snapshot.money.burnMicros),
      stakeMicros: finite(snapshot.money.stakeMicros),
      histogram: snapshot.money.histogram.slice(0, 8).flatMap((row) => {
        if (!row || typeof row.band !== "string" || typeof row.count !== "number" || !Number.isFinite(row.count)) return []
        return [{ band: row.band.slice(0, 32), count: row.count }]
      }),
    },
    lastError: typeof snapshot.lastError === "string" ? snapshot.lastError.slice(0, 300) : null,
    bookLagMs: typeof snapshot.bookLagMs === "number" && Number.isFinite(snapshot.bookLagMs) ? snapshot.bookLagMs : null,
    buyInPaused: snapshot.buyInPaused === true,
    bleed: snapshot.bleed !== false,
    mode: snapshot.mode,
    pin: typeof snapshot.pin === "number" && Number.isFinite(snapshot.pin) ? snapshot.pin : null,
    apiHost: typeof snapshot.apiHost === "string" ? snapshot.apiHost.slice(0, 200) : null,
    apiIp: typeof snapshot.apiIp === "string" ? snapshot.apiIp.slice(0, 200) : null,
    writeBytesPerMin:
      typeof snapshot.writeBytesPerMin === "number" && Number.isFinite(snapshot.writeBytesPerMin) ? snapshot.writeBytesPerMin : null,
    dbBytes: finite(snapshot.dbBytes ?? 0),
    walBytes: finite(snapshot.walBytes ?? 0),
    dirtyWallets: finite(snapshot.dirtyWallets ?? 0),
    flushedWallets: finite(snapshot.flushedWallets ?? 0),
    onlineAvg: onlineAverage(trace),
    skipRate: skipRate(book.buyIns, book.skips),
  }
}

export function statsResponse(snapshot?: SwarmSnapshot | null): Response {
  return Response.json(statsBody(snapshot))
}

export type AgentRosterRow = {
  idx: number
  address: string
  short: string
  online: boolean
  mind: string
  bankrollMicros: number
  lastSide: string | null
  lastStakeMicros: number | null
  lastSkip: string | null
  wins: number
  losses: number
  wokeAt: number | null
  sleptAt: number | null
  updatedAt: number
}

export type AgentRosterBody =
  | { ok: false; error: string }
  | {
      ok: true
      chain: string
      filter: RosterFilter
      sort: RosterSort
      dir: RosterDir
      offset: number
      limit: number
      requestedLimit: number
      capped: boolean
      total: number
      returned: number
      truncated: boolean
      hidden: { count: number; bankrollMicros: number; online: number } | null
      rows: AgentRosterRow[]
      at: number
    }

/** Hard caps keep a 12k-wallet table from ever overloading the runner. */
export const ROSTER_MAX_LIMIT = 50
export const ROSTER_MAX_OFFSET = 10_000
export const ROSTER_CACHE_MS = 4_000
const ROSTER_CHAINS = ["base-sepolia", "near-testnet"] as const
const ROSTER_FILTERS: readonly RosterFilter[] = ["all", "woke", "richest", "stuck", "slept"]
const ROSTER_SORTS: readonly RosterSort[] = ["bankroll", "wins", "updated", "idx", "woke", "slept"]

const rosterCache = new Map<string, { at: number; body: AgentRosterBody }>()

export function parseRosterQuery(url: URL): {
  chain: string
  filter: RosterFilter
  sort: RosterSort
  dir: RosterDir
  offset: number
  limit: number
  requestedLimit: number
  capped: boolean
} {
  const params = url.searchParams
  const rawChain = params.get("chain")?.trim() ?? ""
  const chain = (ROSTER_CHAINS as readonly string[]).includes(rawChain) ? rawChain : activeChainKey()
  const rawFilter = params.get("filter")?.trim() as RosterFilter | null
  const filter: RosterFilter = ROSTER_FILTERS.includes(rawFilter as RosterFilter) ? (rawFilter as RosterFilter) : "all"
  const rawSort = params.get("sort")?.trim() as RosterSort | null
  const sort: RosterSort = ROSTER_SORTS.includes(rawSort as RosterSort) ? (rawSort as RosterSort) : "bankroll"
  const rawDir = params.get("dir")?.trim().toLowerCase()
  const dir: RosterDir = rawDir === "asc" ? "asc" : "desc"
  const rawOffset = Number(params.get("offset") ?? "0")
  const rawLimit = Number(params.get("limit") ?? "25")
  const requestedLimit = Number.isFinite(rawLimit) ? Math.max(1, Math.floor(rawLimit)) : 25
  const limit = Math.min(requestedLimit, ROSTER_MAX_LIMIT)
  const offset = Number.isFinite(rawOffset) ? Math.min(Math.max(0, Math.floor(rawOffset)), ROSTER_MAX_OFFSET) : 0
  const capped = requestedLimit !== limit || (Number.isFinite(rawOffset) && Math.floor(rawOffset) !== offset)
  return { chain, filter, sort, dir, offset, limit, requestedLimit, capped }
}

export function rosterBody(query: ReturnType<typeof parseRosterQuery>): AgentRosterBody {
  const key = `${query.chain}|${query.filter}|${query.sort}|${query.dir}|${query.offset}|${query.limit}`
  const now = Date.now()
  const cached = rosterCache.get(key)
  if (cached && now - cached.at < ROSTER_CACHE_MS) return cached.body
  const path = loadEnv().dbPath
  if (!existsSync(path)) {
    const body: AgentRosterBody = {
      ok: true, chain: query.chain, filter: query.filter, sort: query.sort, dir: query.dir,
      offset: query.offset, limit: query.limit, requestedLimit: query.requestedLimit, capped: query.capped,
      total: 0, returned: 0, truncated: false, hidden: null, rows: [], at: now,
    }
    rosterCache.set(key, { at: now, body })
    return body
  }
  const db = new Database(path, { readonly: true })
  try {
    const agg = rosterAggregates(db, query.filter, query.chain as "base-sepolia" | "near-testnet")
    const stored = rosterSorted(db, query.filter, query.sort, query.dir, query.offset, query.limit, query.chain as "base-sepolia" | "near-testnet")
    const rows: AgentRosterRow[] = stored.map((row) => ({
      idx: row.idx,
      address: row.address,
      short: shortAddress(row.address),
      online: row.online === 1,
      mind: row.mind,
      bankrollMicros: row.bankroll,
      lastSide: row.lastSide,
      lastStakeMicros: row.lastStake,
      lastSkip: row.lastSkip,
      wins: row.wins,
      losses: row.losses,
      wokeAt: row.wokeAt,
      sleptAt: row.sleptAt,
      updatedAt: row.updatedAt,
    }))
    const pageBankroll = rows.reduce((sum, row) => sum + row.bankrollMicros, 0)
    const pageOnline = rows.filter((row) => row.online).length
    // Hidden = everything not on this page (head skipped by offset + tail past the page).
    const hidden = agg.total > rows.length ? {
      count: agg.total - rows.length,
      bankrollMicros: agg.bankrollMicros - pageBankroll,
      online: agg.online - pageOnline,
    } : null
    const body: AgentRosterBody = {
      ok: true, chain: query.chain, filter: query.filter, sort: query.sort, dir: query.dir,
      offset: query.offset, limit: query.limit, requestedLimit: query.requestedLimit, capped: query.capped,
      total: agg.total, returned: rows.length, truncated: hidden !== null, hidden, rows, at: now,
    }
    rosterCache.set(key, { at: now, body })
    // Keep the cache bounded: one entry per distinct page, cap at 40 pages.
    if (rosterCache.size > 40) {
      const oldest = [...rosterCache.entries()].sort((a, b) => a[1].at - b[1].at)[0]
      if (oldest) rosterCache.delete(oldest[0])
    }
    return body
  } finally {
    db.close()
  }
}

export function rosterResponse(url: URL): Response {
  try {
    return Response.json(rosterBody(parseRosterQuery(url)))
  } catch (error) {
    return Response.json({ ok: false, error: error instanceof Error ? error.message : "roster failed" }, { status: 500 })
  }
}

/** Test hook: clear the 4s roster cache. */
export function resetRosterCacheForTest(): void {
  rosterCache.clear()
}

/** Bind the stats listener. `STATS_PORT=0` (and an explicit port of 0) leaves it off. */
export function startStatsServer(port = statsPort()): ReturnType<typeof Bun.serve> | null {
  if (port <= 0) return null
  try {
    return Bun.serve({
      port,
      hostname: "0.0.0.0",
      fetch(req) {
        const url = new URL(req.url)
        if (req.method === "GET" && url.pathname === "/api/health") return statsResponse()
        if (req.method === "GET" && url.pathname === "/api/roster") return rosterResponse(url)
        return Response.json({ error: "Not found" }, { status: 404 })
      },
    })
  } catch (error) {
    console.error(`agent stats listener failed: ${error instanceof Error ? error.message : error}`)
    return null
  }
}

function finite(value: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}
