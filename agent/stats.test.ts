import { expect, test } from "bun:test"
import { histogram, type SwarmSnapshot } from "./status"
import { onlineAverage, publishStats, resetStats, skipRate, startStatsServer, statsBody, statsPort, statsResponse } from "./stats"

function sample(): SwarmSnapshot {
  return {
    at: 1_000,
    manila: "03:15:00",
    phase: "off-peak",
    hour: 3.25,
    window: [300, 600],
    online: 30,
    enrolled: 40,
    pid: 4242,
    running: true,
    spring: 28.4,
    target: 30,
    arrivedMinute: 2,
    leftMinute: 1,
    trace: [10, 20, 30],
    book: {
      roundId: 10,
      upMicros: 12_340_000,
      downMicros: 8_760_000,
      botUpMicros: 3_000_000,
      botDownMicros: 2_000_000,
      buyIns: 4,
      skips: 26,
      p50: 1_230_000,
      p90: 4_560_000,
    },
    money: {
      seedMicros: 80_000_000,
      mintMicros: 1_000_000,
      burnMicros: 250_000,
      stakeMicros: 5_000_000,
      histogram: histogram([4_000_000, 20_000_000]),
    },
    lastError: null,
    bookLagMs: 40,
    buyInPaused: false,
    bleed: true,
    mode: "pin",
    pin: 30,
    apiHost: "quick-market:3001",
    apiIp: "172.19.0.4",
  }
}

test("stats port defaults to 3011 and 0 disables it", () => {
  expect(statsPort({})).toBe(3011)
  expect(statsPort({ STATS_PORT: "" })).toBe(3011)
  expect(statsPort({ STATS_PORT: "0" })).toBe(0)
  expect(statsPort({ STATS_PORT: "3012" })).toBe(3012)
  expect(statsPort({ STATS_PORT: "nope" })).toBe(3011)
  expect(statsPort({ STATS_PORT: "70000" })).toBe(3011)
})

test("a missing snapshot says the runner is still booting", () => {
  resetStats()
  expect(statsBody(null)).toEqual({ ok: true, running: false, at: null })
  expect(statsBody()).toEqual({ ok: true, running: false, at: null })
})

test("the handler returns status, averages, and no secrets", async () => {
  const dirty = {
    ...sample(),
    privateKey: "secret-key",
    address: "0xdeadbeef",
    token: "session-token",
  }
  const body = statsBody(dirty as SwarmSnapshot)
  expect(body.ok).toBe(true)
  if (body.at == null) throw new Error("expected a live snapshot")
  expect(body.running).toBe(true)
  expect(body.online).toBe(30)
  expect(body.enrolled).toBe(40)
  expect(body.phase).toBe("off-peak")
  expect(body.book.p50).toBe(1_230_000)
  expect(body.book.p90).toBe(4_560_000)
  expect(body.onlineAvg).toBe(onlineAverage([10, 20, 30]))
  expect(body.onlineAvg).toBe(20)
  expect(body.skipRate).toBe(skipRate(4, 26))
  expect(body.skipRate).toBeCloseTo(26 / 30)
  expect(body.money.histogram.length).toBeGreaterThan(0)
  const encoded = JSON.stringify(body)
  expect(encoded).not.toContain("secret-key")
  expect(encoded).not.toContain("0xdeadbeef")
  expect(encoded).not.toContain("session-token")
  expect(encoded).not.toContain("privateKey")

  const response = statsResponse(sample())
  expect(response.status).toBe(200)
  expect(response.headers.get("content-type")).toContain("application/json")
  const parsed = (await response.json()) as { online: number }
  expect(parsed.online).toBe(30)
})

test("an empty window has no skip rate", () => {
  const quiet = sample()
  quiet.book.buyIns = 0
  quiet.book.skips = 0
  quiet.trace = []
  const body = statsBody(quiet)
  if (body.at == null) throw new Error("expected a live snapshot")
  expect(body.skipRate).toBeNull()
  expect(body.onlineAvg).toBeNull()
})

test("publishStats is what the listener serves", async () => {
  resetStats()
  publishStats(sample())
  const held = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("busy") })
  const port = held.port
  held.stop(true)
  const server = startStatsServer(port)
  expect(server).not.toBeNull()
  try {
    const health = await fetch(`http://127.0.0.1:${port}/api/health`)
    expect(health.status).toBe(200)
    const body = (await health.json()) as { online: number; onlineAvg: number }
    expect(body.online).toBe(30)
    expect(body.onlineAvg).toBe(20)
    expect((await fetch(`http://127.0.0.1:${port}/keys.json`)).status).toBe(404)
  } finally {
    server?.stop(true)
    resetStats()
  }
})
