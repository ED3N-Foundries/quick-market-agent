export const AGENT_LATENCY_WINDOW_MS = 5 * 60 * 1000
const BUCKET_MS = 10_000
const BOUNDS = [1, 2, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000]

export type AgentLatencyTail = {
  count: number
  avgMs: number
  maxMs: number
  p50: number
  p90: number
  p95: number
  p99: number
}

export type AgentOrderLatencySnapshot = {
  at: number
  windowMs: number
  calls: number
  acceptedOrders: number
  failedCalls: number
  scheduledMs: AgentLatencyTail | null
  responseMs: AgentLatencyTail | null
}

type Agg = { count: number; totalMs: number; maxMs: number; hist: number[] }
type Bucket = { at: number; scheduled: Agg; response: Agg; calls: number; acceptedOrders: number; failedCalls: number }

function newAgg(): Agg {
  return { count: 0, totalMs: 0, maxMs: 0, hist: new Array<number>(BOUNDS.length + 1).fill(0) }
}

function add(agg: Agg, ms: number): void {
  if (!Number.isFinite(ms) || ms < 0) return
  let index = 0
  while (index < BOUNDS.length && ms > BOUNDS[index]!) index += 1
  agg.count += 1
  agg.totalMs += ms
  agg.maxMs = Math.max(agg.maxMs, ms)
  agg.hist[index]! += 1
}

function merge(target: Agg, source: Agg): void {
  target.count += source.count
  target.totalMs += source.totalMs
  target.maxMs = Math.max(target.maxMs, source.maxMs)
  for (let index = 0; index < target.hist.length; index += 1) target.hist[index]! += source.hist[index]!
}

function percentile(hist: number[], q: number): number {
  const total = hist.reduce((sum, count) => sum + count, 0)
  const rank = Math.ceil((q / 100) * total)
  let seen = 0
  for (let index = 0; index < hist.length; index += 1) {
    seen += hist[index]!
    if (seen >= rank) return BOUNDS[index] ?? BOUNDS[BOUNDS.length - 1]! * 2
  }
  return 0
}

function tail(agg: Agg): AgentLatencyTail | null {
  if (agg.count === 0) return null
  return {
    count: agg.count,
    avgMs: agg.totalMs / agg.count,
    maxMs: agg.maxMs,
    p50: percentile(agg.hist, 50),
    p90: percentile(agg.hist, 90),
    p95: percentile(agg.hist, 95),
    p99: percentile(agg.hist, 99),
  }
}

export class AgentOrderLatency {
  private buckets = new Map<number, Bucket>()

  note(input: { scheduledMs: number; responseMs: number; acceptedOrders: number; failed: boolean; now?: number }): void {
    const now = input.now ?? Date.now()
    this.prune(now)
    const at = Math.floor(now / BUCKET_MS) * BUCKET_MS
    let bucket = this.buckets.get(at)
    if (!bucket) {
      bucket = { at, scheduled: newAgg(), response: newAgg(), calls: 0, acceptedOrders: 0, failedCalls: 0 }
      this.buckets.set(at, bucket)
    }
    bucket.calls += 1
    bucket.acceptedOrders += Math.max(0, Math.floor(input.acceptedOrders))
    if (input.failed) bucket.failedCalls += 1
    add(bucket.scheduled, input.scheduledMs)
    add(bucket.response, input.responseMs)
  }

  snapshot(now = Date.now()): AgentOrderLatencySnapshot {
    this.prune(now)
    const scheduled = newAgg()
    const response = newAgg()
    let calls = 0
    let acceptedOrders = 0
    let failedCalls = 0
    for (const bucket of this.buckets.values()) {
      if (bucket.at > now || bucket.at + BUCKET_MS <= now - AGENT_LATENCY_WINDOW_MS) continue
      merge(scheduled, bucket.scheduled)
      merge(response, bucket.response)
      calls += bucket.calls
      acceptedOrders += bucket.acceptedOrders
      failedCalls += bucket.failedCalls
    }
    return { at: now, windowMs: AGENT_LATENCY_WINDOW_MS, calls, acceptedOrders, failedCalls, scheduledMs: tail(scheduled), responseMs: tail(response) }
  }

  private prune(now: number): void {
    const oldest = Math.floor((now - AGENT_LATENCY_WINDOW_MS) / BUCKET_MS) * BUCKET_MS
    for (const at of this.buckets.keys()) if (at < oldest) this.buckets.delete(at)
  }
}

export const agentOrderLatency = new AgentOrderLatency()
