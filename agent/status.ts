import type { AgentOrderLatencySnapshot } from "./latency"

export type ControlMode = "clock" | "off-peak" | "peak" | "ramp" | "pin"

export type ControlFile = {
  mode: ControlMode
  pin: number | null
  buyInPaused: boolean
  paused: string[]
  bleed: boolean
}

export type FlowFile = {
  seedMicros: number
  mintMicros: number
  burnMicros: number
  stakeMicros: number
}

export type BookSnap = {
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

export type MoneySnap = {
  seedMicros: number
  mintMicros: number
  burnMicros: number
  stakeMicros: number
  histogram: { band: string; count: number }[]
}

export type SwarmSnapshot = {
  at: number
  manila: string
  phase: string
  hour: number
  window: [number, number]
  online: number
  enrolled?: number
  pid?: number | null
  running?: boolean
  spring: number
  target: number
  arrivedMinute: number
  leftMinute: number
  trace: number[]
  book: BookSnap
  money: MoneySnap
  lastError: string | null
  bookLagMs: number | null
  orderLatency?: AgentOrderLatencySnapshot
  buyInPaused: boolean
  bleed: boolean
  mode: string
  pin: number | null
  /** Host the runner is requesting, including the port. */
  apiHost?: string
  /** Addresses that host resolved to. Null until DNS answers. */
  apiIp?: string | null
}

export function emptyControl(): ControlFile {
  return { mode: "clock", pin: null, buyInPaused: false, paused: [], bleed: true }
}

export function parseControl(value: unknown): ControlFile {
  const empty = emptyControl()
  if (!value || typeof value !== "object") return empty
  const row = value as Record<string, unknown>
  const mode =
    row.mode === "off-peak" || row.mode === "peak" || row.mode === "ramp" || row.mode === "pin" || row.mode === "clock"
      ? row.mode
      : "clock"
  const pin = typeof row.pin === "number" && Number.isFinite(row.pin) ? Math.max(1, Math.round(row.pin)) : null
  const paused = Array.isArray(row.paused)
    ? row.paused.filter((item): item is string => typeof item === "string").map((item) => item.toLowerCase())
    : []
  return {
    mode,
    pin,
    buyInPaused: typeof row.buyInPaused === "boolean" ? row.buyInPaused : row.bettingPaused === true,
    paused,
    bleed: row.bleed !== false,
  }
}

export function emptyFlow(): FlowFile {
  return { seedMicros: 0, mintMicros: 0, burnMicros: 0, stakeMicros: 0 }
}

export function parseFlow(value: unknown): FlowFile {
  const empty = emptyFlow()
  if (!value || typeof value !== "object") return empty
  const row = value as Partial<FlowFile>
  return {
    seedMicros: numberOr(row.seedMicros, 0),
    mintMicros: numberOr(row.mintMicros, 0),
    burnMicros: numberOr(row.burnMicros, 0),
    stakeMicros: numberOr(row.stakeMicros, 0),
  }
}

export function histogram(balances: number[]): { band: string; count: number }[] {
  const bands = [
    { band: "$3–10", count: 0 },
    { band: "$10–50", count: 0 },
    { band: "$50–200", count: 0 },
    { band: "$200–1000", count: 0 },
    { band: "outside", count: 0 },
  ]
  for (const micros of balances) {
    const dollars = micros / 1_000_000
    if (dollars >= 3 && dollars < 10) bands[0]!.count += 1
    else if (dollars >= 10 && dollars < 50) bands[1]!.count += 1
    else if (dollars >= 50 && dollars < 200) bands[2]!.count += 1
    else if (dollars >= 200 && dollars <= 1000) bands[3]!.count += 1
    else bands[4]!.count += 1
  }
  return bands
}

export function percentiles(stakes: number[]): { p50: number; p90: number } {
  if (stakes.length === 0) return { p50: 0, p90: 0 }
  const sorted = [...stakes].sort((left, right) => left - right)
  const at = (fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(fraction * (sorted.length - 1)))] ?? 0
  return { p50: at(0.5), p90: at(0.9) }
}

export function formatMicros(micros: number): string {
  const sign = micros < 0 ? "-" : ""
  const abs = Math.abs(Math.trunc(micros))
  const dollars = Math.floor(abs / 1_000_000)
  const cents = Math.floor((abs % 1_000_000) / 10_000)
  return `${sign}$${dollars.toLocaleString("en-US")}.${String(cents).padStart(2, "0")}`
}

export function shortAddress(address: string): string {
  if (address.length < 12) return address
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

export function manilaClock(now: number, offsetHours = 8): string {
  const shifted = new Date(now + offsetHours * 3_600_000)
  const hh = String(shifted.getUTCHours()).padStart(2, "0")
  const mm = String(shifted.getUTCMinutes()).padStart(2, "0")
  const ss = String(shifted.getUTCSeconds()).padStart(2, "0")
  return `${hh}:${mm}:${ss}`
}

export function spark(values: number[]): string {
  const ticks = "▁▂▃▄▅▆▇█"
  if (values.length === 0) return ""
  const recent = values.slice(-48)
  const low = Math.min(...recent)
  const high = Math.max(...recent)
  const span = high - low || 1
  return recent.map((value) => ticks[Math.min(7, Math.floor(((value - low) / span) * 7))] ?? "▁").join("")
}

export function parseSnapshot(value: unknown): SwarmSnapshot | null {
  if (!value || typeof value !== "object") return null
  const row = value as Partial<SwarmSnapshot> & { bettingPaused?: unknown }
  if (typeof row.at !== "number" || typeof row.manila !== "string" || typeof row.phase !== "string") return null
  if (!row.book || !row.money || !Array.isArray(row.window) || !Array.isArray(row.trace)) return null
  const book = row.book as BookSnap & { bets?: unknown }
  const buyIns = typeof book.buyIns === "number" ? book.buyIns : typeof book.bets === "number" ? book.bets : 0
  return {
    ...(row as SwarmSnapshot),
    buyInPaused: typeof row.buyInPaused === "boolean" ? row.buyInPaused : row.bettingPaused === true,
    book: { ...book, buyIns },
  }
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback
}
