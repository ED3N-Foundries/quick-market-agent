import type { SwarmSnapshot } from "./status"

export type AgentHealthBook = {
  roundId: number | null
  upMicros: number
  downMicros: number
  botUpMicros: number
  botDownMicros: number
  buyIns: number
  skips: number
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
    onlineAvg: onlineAverage(trace),
    skipRate: skipRate(book.buyIns, book.skips),
  }
}

export function statsResponse(snapshot?: SwarmSnapshot | null): Response {
  return Response.json(statsBody(snapshot))
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
