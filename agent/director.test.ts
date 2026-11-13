import { expect, test } from "bun:test"
import { swarmConfig } from "./config"
import { createDirector, scheduleAt, stepDirector, type DirectorState } from "./director"

const clock = swarmConfig.clock
const neutral = { absReturn: 1, volatility: 1 }
const hot = { absReturn: 4, volatility: 1 }
const flat = { absReturn: 0, volatility: 1 }

function manila(hour: number, minute = 0): number {
  return Date.UTC(2026, 5, 15, hour - clock.timeZoneOffsetHours, minute, 0)
}

function viewAt(hour: number, tape = neutral, state?: DirectorState) {
  return stepDirector(state ?? createDirector(450), {
    now: manila(hour),
    dtSec: 0,
    tape,
    config: clock,
    pin: null,
    hold: null,
  })
}

test("Manila 03:00 is the off-peak window", () => {
  const view = viewAt(3)
  expect(view.phase).toBe("off-peak")
  expect(view.window).toEqual([600, 1_200])
  const hotView = viewAt(3, hot)
  expect(hotView.window[0]).toBeGreaterThanOrEqual(600)
  expect(hotView.window[1]).toBeLessThanOrEqual(1_200)
})

test("Manila 21:00 is a 600-wide window inside the peak box", () => {
  const view = viewAt(21)
  expect(view.phase).toBe("peak")
  expect(view.window[1] - view.window[0]).toBe(clock.windowWidth)
  expect(view.window[0]).toBeGreaterThanOrEqual(clock.peak.box[0])
  expect(view.window[1]).toBeLessThanOrEqual(clock.peak.box[1])
})

test("the morning center rises from 07:00 to 17:00", () => {
  let previous = -Infinity
  for (let hour = 7; hour <= 17; hour += 0.5) {
    const point = scheduleAt(manila(hour), neutral, clock)
    expect(point.center).toBeGreaterThanOrEqual(previous - 1e-6)
    previous = point.center
  }
  expect(scheduleAt(manila(17), neutral, clock).center).toBeGreaterThan(scheduleAt(manila(7), neutral, clock).center)
})

test("a spring stepped across ten minutes does not teleport", () => {
  const now = manila(21)
  const target = scheduleAt(now, neutral, clock).center
  let state = createDirector(400)
  let previous = state.value
  let maxStep = 0
  for (let i = 0; i < 600; i++) {
    const view = stepDirector(state, { now, dtSec: 1, tape: neutral, config: clock, pin: null, hold: null })
    state = view.state
    maxStep = Math.max(maxStep, Math.abs(state.value - previous))
    previous = state.value
  }
  expect(maxStep).toBeLessThan(clock.perSecond + 0.01)
  expect(state.value).toBeGreaterThan(1_000)
  expect(Math.abs(state.value - target)).toBeLessThan(Math.abs(400 - target))
})

test("a hot tape and a flat tape move the peak target in opposite directions", () => {
  const now = manila(21)
  const calm = scheduleAt(now, neutral, clock).center
  const heated = scheduleAt(now, hot, clock).center
  const quiet = scheduleAt(now, flat, clock).center
  expect(heated).toBeGreaterThan(calm)
  expect(quiet).toBeLessThan(calm)
  const spare = (clock.peak.box[1] - clock.peak.box[0] - clock.windowWidth) / 2
  expect(Math.abs(heated - calm)).toBeLessThanOrEqual(spare + 1e-6)
  expect(Math.abs(quiet - calm)).toBeLessThanOrEqual(spare + 1e-6)
  expect(scheduleAt(now, hot, clock).window[0]).toBeGreaterThanOrEqual(clock.peak.box[0])
  expect(scheduleAt(now, flat, clock).window[1]).toBeLessThanOrEqual(clock.peak.box[1])
})

test("ramp pace aims at the peak box and outruns the glide", () => {
  const now = manila(3)
  const glide = stepDirector(createDirector(clock.floor), {
    now,
    dtSec: 1,
    tape: neutral,
    config: clock,
    pin: null,
    hold: null,
    pace: "glide",
  })
  const ramp = stepDirector(createDirector(clock.floor), {
    now,
    dtSec: 1,
    tape: neutral,
    config: clock,
    pin: null,
    hold: null,
    pace: "ramp",
  })
  expect(ramp.phase).toBe("ramp")
  expect(ramp.target).toBeGreaterThanOrEqual(clock.peak.box[0])
  expect(ramp.target).toBeLessThanOrEqual(clock.peak.box[1])
  expect(ramp.perSecond).toBe(clock.ramp.perSecond)
  expect(Math.abs(ramp.state.value - clock.floor)).toBeGreaterThan(Math.abs(glide.state.value - clock.floor))
  expect(Math.abs(ramp.state.value - clock.floor)).toBeLessThanOrEqual(clock.ramp.perSecond + 0.01)
})

test("a pin keeps the glide pace", () => {
  const view = stepDirector(createDirector(100), {
    now: manila(3),
    dtSec: 1,
    tape: neutral,
    config: clock,
    pin: 40,
    hold: null,
    pace: "ramp",
  })
  expect(view.phase).toBe("pin")
  expect(view.target).toBe(40)
  expect(view.perSecond).toBe(clock.perSecond)
})
