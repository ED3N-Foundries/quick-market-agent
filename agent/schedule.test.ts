import { expect, test } from "bun:test"
import { swarmConfig } from "./config"
import { fireAt, releaseWave, type FireSlot } from "./schedule"

const timing = swarmConfig.timing

test("tape fires before fade and every fire sits inside the window", () => {
  const open = 1_000_000
  const close = open + 5_000
  for (let index = 0; index < 40; index++) {
    const tape = fireAt(index, "tape", 3, open, close, timing)
    const fade = fireAt(index, "fade", 3, open, close, timing)
    const price = fireAt(index, "price", 3, open, close, timing)
    const restless = fireAt(index, "restless", 3, open, close, timing)
    const streak = fireAt(index, "streak", 3, open, close, timing)
    for (const at of [tape, fade, price, restless, streak]) {
      expect(at).toBeGreaterThan(open + timing.marginMs)
      expect(at).toBeLessThan(close - timing.marginMs)
    }
    const span = close - open
    const margin = Math.min(timing.marginMs, Math.floor(span / 4))
    const usable = span - 2 * margin
    expect(streak).toBeGreaterThanOrEqual(open + margin + timing.streakSlot[0] * usable)
    expect(streak).toBeLessThanOrEqual(open + margin + timing.streakSlot[1] * usable)
    expect(tape).toBeLessThan(fade)
    expect(tape).toBeLessThan(price)
    expect(fireAt(index, "tape", 3, open, close, timing)).toBe(tape)
  }
})

test("a full wave slips the overflow by one slice", () => {
  const queue: FireSlot[] = Array.from({ length: timing.waveCap + 5 }, (_, index) => ({
    address: `a${index.toString().padStart(3, "0")}`,
    fireAt: 1_000,
    inBurst: false,
  }))
  const released = releaseWave({ queue, now: 1_500, closeAt: 10_000, timing })
  expect(released.due).toHaveLength(timing.waveCap)
  expect(released.queue).toHaveLength(5)
  expect(released.dropped).toHaveLength(0)
  expect(released.queue.every((slot) => slot.fireAt === 1_000 + timing.sliceMs)).toBe(true)
})

test("overflow past the margin is dropped", () => {
  const queue: FireSlot[] = [
    { address: "early", fireAt: 1_000, inBurst: false },
    { address: "late", fireAt: 9_500, inBurst: true },
  ]
  const released = releaseWave({
    queue,
    now: 9_600,
    closeAt: 10_000,
    timing: { ...timing, waveCap: 1 },
  })
  expect(released.due.map((slot) => slot.address)).toEqual(["early"])
  expect(released.queue).toHaveLength(0)
  expect(released.dropped.map((slot) => slot.address)).toEqual(["late"])
})
