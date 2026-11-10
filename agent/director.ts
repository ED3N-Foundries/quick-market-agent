import { clamp, lerp } from "math"
import { fbm, simplex2d } from "math/noise"
import { easing, spring } from "math/time"
import type { ClockConfig, TapeStats } from "./config"

const slowNoise = simplex2d.create(0x51a7)
const fastNoise = simplex2d.create(0x17c3)

export type DirectorState = {
  value: number
  velocity: number
}

export type CrowdPhase = "off-peak" | "rise" | "peak" | "decline" | "pin"

export type DirectorView = {
  state: DirectorState
  phase: CrowdPhase
  hour: number
  center: number
  window: readonly [number, number]
  target: number
  online: number
}

export function createDirector(value: number): DirectorState {
  const created = spring.create(value)
  return { value: created.value, velocity: created.velocity }
}

export function manilaHour(now: number, offsetHours: number): number {
  const shifted = now + offsetHours * 3_600_000
  const date = new Date(shifted)
  return date.getUTCHours() + date.getUTCMinutes() / 60 + date.getUTCSeconds() / 3600 + date.getUTCMilliseconds() / 3_600_000
}

function interestOf(tape: TapeStats): number {
  const ratio = tape.absReturn / Math.max(tape.volatility, 1e-9)
  return clamp(ratio - 1, -1, 1)
}

function noiseUnit(now: number, tape: TapeStats, config: ClockConfig): number {
  const hours = now / 3_600_000
  const slow = fbm(
    (frequency) => simplex2d.sample(slowNoise, hours * config.noise.slowHours * frequency, 0.37),
    config.noise.octaves,
    config.noise.lacunarity,
    config.noise.gain,
  )
  const fast = simplex2d.sample(fastNoise, hours * config.noise.fastHours, 2.4)
  const interest = interestOf(tape)
  return clamp(
    config.noise.slow * slow + config.noise.fast * fast + config.noise.interest * interest,
    -1,
    1,
  )
}

function peakCenter(now: number, tape: TapeStats, config: ClockConfig): number {
  const half = config.windowWidth / 2
  const low = config.peak.box[0] + half
  const high = config.peak.box[1] - half
  const mid = (low + high) / 2
  const amplitude = (high - low) / 2
  return clamp(mid + noiseUnit(now, tape, config) * amplitude, low, high)
}

export type SchedulePoint = {
  phase: Exclude<CrowdPhase, "pin">
  hour: number
  center: number
  window: readonly [number, number]
}

export function scheduleAt(now: number, tape: TapeStats, config: ClockConfig): SchedulePoint {
  const hour = manilaHour(now, config.timeZoneOffsetHours)
  const half = config.windowWidth / 2
  if (hour >= config.offPeak.fromHour && hour < config.offPeak.toHour) {
    const box = config.offPeak.box
    return { phase: "off-peak", hour, center: (box[0] + box[1]) / 2, window: [box[0], box[1]] }
  }
  if (hour >= config.rise.fromHour && hour < config.rise.toHour) {
    const span = config.rise.toHour - config.rise.fromHour
    const t = easing.cubicInOut((hour - config.rise.fromHour) / span)
    const center = lerp(config.rise.fromCenter, config.rise.toCenter, t)
    return { phase: "rise", hour, center, window: [center - half, center + half] }
  }
  if (hour >= config.peak.fromHour && hour < config.peak.toHour) {
    const raw = peakCenter(now, tape, config)
    const into = (hour - config.peak.fromHour) / (config.peak.toHour - config.peak.fromHour)
    const blend = easing.cubicInOut(clamp(into / (0.5 / 6), 0, 1))
    const center = lerp(config.rise.toCenter, raw, blend)
    return { phase: "peak", hour, center, window: [center - half, center + half] }
  }
  const since = hour >= config.decline.fromHour ? hour - config.decline.fromHour : hour + (24 - config.decline.fromHour)
  const declineHours = (24 - config.decline.fromHour + config.decline.toHour) % 24
  const t = easing.cubicInOut(clamp(since / declineHours, 0, 1))
  const from = peakCenter(now - since * 3_600_000, tape, config)
  const center = lerp(from, config.decline.toCenter, t)
  const low = clamp(center - half, config.floor, config.ceiling)
  const high = clamp(center + half, config.floor, config.ceiling)
  return { phase: "decline", hour, center, window: [low, Math.max(low, high)] }
}

export function stepDirector(
  state: DirectorState,
  input: {
    now: number
    dtSec: number
    tape: TapeStats
    config: ClockConfig
    pin: number | null
    hold: "off-peak" | "peak" | null
  },
): DirectorView {
  let point = scheduleAt(input.now, input.tape, input.config)
  if (input.hold === "off-peak") {
    const box = input.config.offPeak.box
    point = { phase: "off-peak", hour: point.hour, center: (box[0] + box[1]) / 2, window: [box[0], box[1]] }
  } else if (input.hold === "peak") {
    const held = scheduleAt(input.now, input.tape, input.config)
    const hour = input.config.peak.fromHour + (input.config.peak.toHour - input.config.peak.fromHour) / 2
    const shifted = input.now + (hour - held.hour) * 3_600_000
    point = scheduleAt(shifted, input.tape, input.config)
  }

  let center = point.center
  let window = point.window
  let phase: CrowdPhase = point.phase
  let target = center
  if (input.pin !== null && Number.isFinite(input.pin)) {
    target = clamp(input.pin, 1, input.config.ceiling)
    center = target
    window = [target, target]
    phase = "pin"
  }

  const springState = { value: state.value, velocity: state.velocity }
  if (input.dtSec > 0) {
    const before = springState.value
    spring.damp(springState, target, input.config.smoothTime, input.dtSec)
    const cap = input.config.perSecond * input.dtSec
    const delta = springState.value - before
    if (Math.abs(delta) > cap) {
      springState.value = before + Math.sign(delta) * cap
      springState.velocity = Math.sign(delta) * input.config.perSecond
    }
    if ((before <= target && springState.value >= target) || (before >= target && springState.value <= target)) {
      springState.value = target
      springState.velocity = 0
    }
  }
  state.value = springState.value
  state.velocity = springState.velocity
  const low = input.pin === null ? input.config.floor : 1
  const online = clamp(Math.round(springState.value), low, input.config.ceiling)
  return { state, phase, hour: point.hour, center, window, target, online }
}
