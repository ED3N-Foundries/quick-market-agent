import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { createDirector } from "./director"
import { mergeLanes, scaleCrowd } from "./index"
import type { SwarmSnapshot } from "./status"

test("a split scales one crowd across the two markets", () => {
  const view = {
    state: createDirector(100),
    phase: "peak" as const,
    hour: 20,
    center: 400,
    window: [300, 500] as [number, number],
    target: 400,
    online: 400,
    perSecond: 30,
  }
  expect(scaleCrowd(view, 100)).toBe(view)
  expect(scaleCrowd(view, 50)).toMatchObject({ online: 200, target: 200, center: 200, window: [150, 250] })
})

test("merged lanes add the crowds and keep one spring", () => {
  const base = snapshot({ at: 1, online: 100, enrolled: 120, window: [80, 120], target: 100, spring: 200, trace: [40, 80] })
  const near = snapshot({
    at: 2,
    online: 50,
    enrolled: 60,
    window: [40, 60],
    target: 50,
    spring: 190,
    trace: [10],
    buyIns: 3,
    phase: "peak",
  })
  const merged = mergeLanes([base, near])
  expect(merged.online).toBe(150)
  expect(merged.enrolled).toBe(180)
  expect(merged.window).toEqual([120, 180])
  expect(merged.target).toBe(150)
  expect(merged.spring).toBe(200)
  expect(merged.trace).toEqual([40, 90])
  expect(merged.book.buyIns).toBe(3)
  expect(merged.phase).toBe("peak")
})

function snapshot(patch: Partial<SwarmSnapshot> & { buyIns?: number }): SwarmSnapshot {
  return {
    at: patch.at ?? 0,
    manila: "19:00:00",
    phase: patch.phase ?? "rise",
    hour: 19,
    window: patch.window ?? [0, 0],
    online: patch.online ?? 0,
    enrolled: patch.enrolled ?? 0,
    running: true,
    spring: patch.spring ?? 0,
    target: patch.target ?? 0,
    arrivedMinute: 0,
    leftMinute: 0,
    trace: patch.trace ?? [],
    book: {
      roundId: 1,
      upMicros: 0,
      downMicros: 0,
      botUpMicros: 0,
      botDownMicros: 0,
      buyIns: patch.buyIns ?? 0,
      skips: 0,
      p50: 0,
      p90: 0,
    },
    money: { seedMicros: 0, mintMicros: 0, burnMicros: 0, stakeMicros: 0, histogram: [] },
    lastError: null,
    bookLagMs: null,
    buyInPaused: false,
    bleed: true,
    mode: "clock",
    pin: null,
  }
}

test("the runner does not keep the faucet loop", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  expect(source).toContain("The swarm refuses CHAIN=base")
  expect(source).toContain("scaleCrowd")
  expect(source).not.toContain("The swarm does not run on NEAR")
  expect(source).not.toContain("NEAR agent trading is not enabled")
  expect(source).not.toContain("/api/agents")
  expect(source).not.toContain("x-agent-secret")
  expect(source).not.toContain("needsFaucet")
  expect(source).not.toContain("requestFaucet")
  expect(source).not.toContain("balanceOf")
  expect(source).not.toContain("data/quick-market.sqlite")
})
