import { expect, test } from "bun:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { swarmConfig } from "./config"
import { growKeys, type StoredKey } from "./keys"
import { openClock, stepPresence, type WalletClock } from "./presence"

const presence = swarmConfig.presence
const quiet = { moving: false, flat: false }

function address(index: number): string {
  return `0x${index.toString(16).padStart(40, "0")}`
}

function clock(index: number, visitStart: number, visitEnd: number, gapEnd: number): WalletClock {
  return { index, address: address(index), cursor: 1, visitStart, visitEnd, gapEnd }
}

function run(input: {
  clocks: WalletClock[]
  seated?: string[]
  target: number
  window?: readonly [number, number]
  tape?: { moving: boolean; flat: boolean }
  now?: number
  dtSec?: number
  recent?: { index: number; at: number }[]
  config?: typeof presence
}) {
  return stepPresence({
    clocks: input.clocks,
    seated: new Set(input.seated ?? []),
    now: input.now ?? 1_000_000,
    dtSec: input.dtSec ?? 1,
    hour: 20,
    target: input.target,
    window: input.window ?? [0, 100],
    tape: input.tape ?? quiet,
    recentArrivals: input.recent ?? [],
    config: input.config ?? presence,
    perSecond: 30,
  })
}

test("raising the target wakes that many and only that many", () => {
  const now = 1_000_000
  const clocks = Array.from({ length: 12 }, (_, index) => clock(index, now - 60_000, now + 30 * 60_000, now + 60 * 60_000))
  const step = run({ clocks, target: 5, window: [0, 12] })
  expect(step.online).toHaveLength(5)
  expect(step.arrived).toHaveLength(5)
})

test("hysteresis keeps a wallet seated when the cutoff jitters", () => {
  const now = 1_000_000
  const clocks = Array.from({ length: 8 }, (_, index) => clock(index, now - 10 * 60_000, now + 40 * 60_000, now + 80 * 60_000))
  const seated = clocks.map((item) => item.address)
  const step = run({ clocks, seated, target: 5, window: [0, 20] })
  expect(step.online).toHaveLength(8)
  expect(step.left).toHaveLength(0)
})

test("an ended visit is first out and a visit about to start is first in", () => {
  const now = 1_000_000
  const seatedClocks = Array.from({ length: 4 }, (_, index) => clock(index, now - 20 * 60_000, now + 20 * 60_000, now + 50 * 60_000))
  const ended = clock(4, now - 30 * 60_000, now - 1_000, now + 40 * 60_000)
  const soon = clock(5, now + 2_000, now + 20 * 60_000, now + 40 * 60_000)
  const later = clock(6, now + 30 * 60_000, now + 50 * 60_000, now + 80 * 60_000)
  const clocks = [...seatedClocks, ended, soon, later]
  const seated = [...seatedClocks.map((item) => item.address), ended.address]
  const shrunk = run({ clocks, seated, target: 4, window: [0, 10] })
  expect(shrunk.online).not.toContain(ended.address)
  expect(shrunk.left).toContain(ended.address)
  const grown = run({
    clocks: [...seatedClocks, soon, later],
    seated: seatedClocks.map((item) => item.address),
    target: 5,
    window: [0, 10],
  })
  expect(grown.online).toContain(soon.address)
  expect(grown.online).not.toContain(later.address)
})

test("a flat tape can end a visit and the next wallets backfill inside the window", () => {
  const now = 1_000_000
  const ending = [0, 1, 2].map((index) => clock(index, now - 50_000, now + 4_000, now + 80 * 60_000))
  const staying = [3, 4].map((index) => clock(index, now - 2_000, now + 80_000, now + 90 * 60_000))
  const seated = [...ending, ...staying]
  const due = [5, 6, 7].map((index) => clock(index, now + 3_000, now + 20 * 60_000, now + 40 * 60_000))
  const step = run({
    clocks: [...seated, ...due],
    seated: seated.map((item) => item.address),
    target: 5,
    window: [4, 6],
    tape: { moving: false, flat: true },
    config: { ...presence, tapeShrink: 0.95, almostMs: 10_000, backfillMs: 20_000 },
  })
  expect(step.online.length).toBeGreaterThanOrEqual(4)
  expect(step.online.length).toBeLessThanOrEqual(6)
  expect(step.arrived.length).toBeGreaterThan(0)
})

test("the same seed repeats arrivals", () => {
  const first = Array.from({ length: 6 }, (_, index) => openClock(index, address(index), 50_000, 21, presence))
  const second = Array.from({ length: 6 }, (_, index) => openClock(index, address(index), 50_000, 21, presence))
  const left = run({ clocks: first, target: 3, window: [0, 6], now: 50_000 })
  const right = run({ clocks: second, target: 3, window: [0, 6], now: 50_000 })
  expect(left.online).toEqual(right.online)
  expect(left.clocks.map((item) => item.visitStart)).toEqual(right.clocks.map((item) => item.visitStart))
})

test("the key file never shrinks and the first wallets stay themselves", () => {
  const first = growKeys([], 2, 6_000)
  expect(growKeys(first, 1, 6_000)).toEqual(first)
  const more = growKeys(first, 3, 6_000)
  expect(more.slice(0, 2)).toEqual(first)
  expect(more).toHaveLength(3)
  const broken = [{ address: "0x0", privateKey: "0x123" }] as StoredKey[]
  const repaired = growKeys(broken, 1, 6_000)
  expect(repaired).toHaveLength(1)
  expect(repaired[0]!.privateKey).not.toBe("0x123")
  const kept = growKeys(first, 2, 6_000)
  expect(kept.map((key) => privateKeyToAccount(key.privateKey).address.toLowerCase())).toEqual(first.map((key) => key.address.toLowerCase()))
  expect(generatePrivateKey()).toMatch(/^0x[0-9a-f]{64}$/)
})
