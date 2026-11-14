import { describe, expect, test } from "bun:test"
import { AGENT_LATENCY_WINDOW_MS, AgentOrderLatency } from "./latency"

const NOW = 1_800_000_000_000

describe("AgentOrderLatency", () => {
  test("aggregates scheduling and response samples with call outcomes", () => {
    const metrics = new AgentOrderLatency()
    metrics.note({ scheduledMs: 200, responseMs: 30, acceptedOrders: 80, failed: false, now: NOW })
    metrics.note({ scheduledMs: 400, responseMs: 90, acceptedOrders: 0, failed: true, now: NOW })
    const snapshot = metrics.snapshot(NOW)
    expect(snapshot.calls).toBe(2)
    expect(snapshot.acceptedOrders).toBe(80)
    expect(snapshot.failedCalls).toBe(1)
    expect(snapshot.scheduledMs?.count).toBe(2)
    expect(snapshot.scheduledMs?.maxMs).toBe(400)
    expect(snapshot.responseMs?.avgMs).toBe(60)
  })

  test("expires old samples and returns null for an idle window", () => {
    const metrics = new AgentOrderLatency()
    metrics.note({ scheduledMs: 200, responseMs: 30, acceptedOrders: 80, failed: false, now: NOW - AGENT_LATENCY_WINDOW_MS - 10_000 })
    const snapshot = metrics.snapshot(NOW)
    expect(snapshot.calls).toBe(0)
    expect(snapshot.scheduledMs).toBeNull()
    expect(snapshot.responseMs).toBeNull()
  })
})
