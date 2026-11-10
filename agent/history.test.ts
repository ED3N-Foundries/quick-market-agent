import { expect, test } from "bun:test"
import { ewmaSignal, windowBars } from "./history"

const WINDOW = 5_000

test("four covered windows become four bars and the open window is left out", () => {
  const now = 50_000
  const points = []
  for (const id of [6, 7, 8, 9, 10]) {
    points.push({ t: id * WINDOW + 100, price: 100 + id })
    points.push({ t: id * WINDOW + 4_000, price: 101 + id })
  }
  const bars = windowBars(points, now, WINDOW, 4)
  expect(bars.map((bar) => bar.windowId)).toEqual([6, 7, 8, 9])
  expect(bars.every((bar) => bar.ret > 0)).toBe(true)
  expect(windowBars(points, now, WINDOW, 4)).toEqual(bars)
})

test("a short tape keeps the windows it has", () => {
  const now = 50_000
  const points = [
    { t: 8 * WINDOW + 100, price: 100 },
    { t: 8 * WINDOW + 4_000, price: 101 },
    { t: 9 * WINDOW + 100, price: 101 },
    { t: 9 * WINDOW + 4_000, price: 100 },
    { t: 7 * WINDOW + 100, price: 99 },
  ]
  const bars = windowBars(points, now, WINDOW, 4)
  expect(bars.map((bar) => bar.windowId)).toEqual([8, 9])
  expect(bars[1]!.ret).toBeLessThan(0)
})

test("an empty tape has no bars", () => {
  expect(windowBars([], 50_000, WINDOW, 4)).toEqual([])
})

test("a rising series has a positive signal and an empty series does not", () => {
  const rising = ewmaSignal([0.01, 0.012, 0.011, 0.013], 0.55)
  expect(rising.z).toBeGreaterThan(0)
  expect(ewmaSignal([], 0.55)).toEqual({ mean: 0, variance: 0, z: 0 })
  expect(ewmaSignal([-0.02, -0.01], 0.55).mean).toBeLessThan(0)
})
