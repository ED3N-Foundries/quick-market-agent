import { clamp, lerp } from "math"
import { mulberry32, type Mulberry32 } from "math/random"
import { easing } from "math/time"
import { USDC, type PersonaConfig, type StakeConfig, type TimingConfig } from "./config"
import { ewmaSignal, windowBars, type WindowBar } from "./history"
import type { Persona } from "./persona"
import { shapeStake } from "./stake"

export type Side = "up" | "down"
export type SkipReason = "waiting" | "refractory" | "flat" | "no edge"

export type PrintPoint = {
  t: number
  price: number
}

export type GateState = {
  readyWindow: number
  burstLeft: number
  refractory: boolean
  results: boolean[]
  edgeNudge: number
  tempoNudge: number
  bias: number
  rngA: number
}

export type WalletMind = {
  index: number
  address: string
  persona: Persona
  bankroll: number
  gate: GateState
  paused: boolean
}

export type Order = {
  address: string
  side: Side
  stakeMicros: number
  pUp: number
}

export type Skip = {
  address: string
  reason: SkipReason
}

export function freshGate(index: number, windowId: number, persona: Persona, config: PersonaConfig): GateState {
  const rng = mulberry32.create(Math.imul(index + 1, 0x27d4eb2d) >>> 0)
  const gap = drawGap(persona, 1, rng, config)
  return {
    readyWindow: windowId + gap,
    burstLeft: 0,
    refractory: false,
    results: [],
    edgeNudge: 0,
    tempoNudge: 0,
    bias: 0,
    rngA: rng.a,
  }
}

function drawGap(persona: Persona, scale: number, rng: Mulberry32, _config: PersonaConfig): number {
  const tempo = Math.max(1, persona.tempoWindows)
  const drawn = lerp(tempo * 2.4, Math.max(1, tempo * 0.55), easing.expoOut(mulberry32.sample(rng)))
  return clamp(Math.round(drawn * scale), 1, 96)
}

export function tapeActivity(points: readonly PrintPoint[], now: number, lookbackMs: number): { ret: number; vol: number; activity: number } {
  const from = now - lookbackMs
  const window = points.filter((point) => point.t >= from && point.t <= now)
  if (window.length < 2) return { ret: 0, vol: 0, activity: 0 }
  const first = window[0]!.price
  const last = window[window.length - 1]!.price
  const ret = first === 0 ? 0 : (last - first) / first
  let vol = 0
  for (let i = 1; i < window.length; i++) {
    const prev = window[i - 1]!.price
    if (prev !== 0) vol += Math.abs(window[i]!.price - prev) / prev
  }
  vol /= window.length - 1
  const activity = Math.abs(ret) / (Math.abs(ret) + Math.max(vol, 1e-6))
  return { ret, vol, activity }
}

function regime(activity: number, config: PersonaConfig): "moving" | "flat" | "calm" {
  if (activity >= config.movingBand) return "moving"
  if (activity <= config.flatBand) return "flat"
  return "calm"
}

function sigmoid(value: number): number {
  if (value > 30) return 1
  if (value < -30) return 0
  return 1 / (1 + Math.exp(-value))
}

export function drawdownScale(results: readonly boolean[], floor: number): number {
  if (results.length === 0) return 1
  let losses = 0
  for (const won of results) if (!won) losses += 1
  return clamp(1 - losses / results.length, floor, 1)
}

export function impliedUp(poolUp: number, poolDown: number): number {
  const total = poolUp + poolDown
  if (total <= 0) return 0.5
  return poolUp / total
}

export function exhaustStake(probability: number, poolSame: number, poolOther: number, virtualMicros: number): number {
  if (!(probability > 0 && probability < 1)) return 0
  const same = poolSame + virtualMicros
  const other = poolOther + virtualMicros
  const room = probability * (same + other) - same
  if (room <= 0) return 0
  return Math.floor(room / (1 - probability))
}

type GateInput = {
  wallet: WalletMind
  windowId: number
  now: number
  windowMs: number
  points: readonly PrintPoint[]
  config: PersonaConfig
}

export type Admission =
  | { action: "skip"; reason: SkipReason; gate: GateState }
  | { action: "due"; gate: GateState; inBurst: boolean }

export function admitWallet(input: GateInput): Admission {
  const persona = input.wallet.persona
  const gate: GateState = {
    ...input.wallet.gate,
    results: input.wallet.gate.results.slice(-input.config.memory),
  }
  const rng = { a: gate.rngA }
  const finish = (reason: SkipReason): Admission => {
    gate.rngA = rng.a
    return { action: "skip", reason, gate }
  }
  if (input.wallet.paused || input.wallet.bankroll < USDC) return finish("waiting")

  const look = tapeActivity(input.points, input.now, Math.max(persona.lookbackMs, input.windowMs * 4))
  const state = regime(look.activity, input.config)
  let scale = 1
  if (state === "moving") scale = input.config.hotScale
  if (state === "flat") scale = input.config.flatScale
  scale = clamp(scale * (1 + gate.tempoNudge), input.config.scaleMin, input.config.scaleMax)

  const due = input.windowId >= gate.readyWindow
  const inBurst = gate.burstLeft > 0
  if (gate.refractory && !due && !inBurst) return finish("refractory")
  if (inBurst) {
    const fire = mulberry32.sample(rng) < input.config.burstFire
    gate.burstLeft -= 1
    if (!fire) {
      if (gate.burstLeft === 0) armRefractory(gate, persona, scale, rng, input.config, input.windowId)
      return finish("waiting")
    }
  } else if (!due) {
    return finish(gate.refractory ? "refractory" : "waiting")
  } else if (mulberry32.sample(rng) > input.config.gateFire) {
    gate.readyWindow = input.windowId + 1
    return finish("waiting")
  }

  gate.rngA = rng.a
  return { action: "due", gate, inBurst }
}

const STREAK_LOOK = 5

function settledRun(settles: readonly Side[]): { side: Side; length: number } | null {
  if (settles.length === 0) return null
  const side = settles[settles.length - 1]!
  let length = 0
  for (let index = settles.length - 1; index >= 0 && length < STREAK_LOOK; index--) {
    if (settles[index] !== side) break
    length += 1
  }
  return { side, length }
}

function streakBelief(persona: Persona, settles: readonly Side[], rng: { a: number }, timing: TimingConfig): number | null {
  const run = settledRun(settles)
  if (!run || run.length < persona.streakNeed) return null
  const extra = run.length - persona.streakNeed
  const lean = clamp((timing.streakLean + extra * timing.streakLeanStep) * persona.streakConviction, 0, timing.streakLeanCap)
  const noise = (mulberry32.sample(rng) - 0.5) * persona.noise * timing.streakNoiseScale
  const towardUp = persona.streakFade ? run.side === "down" : run.side === "up"
  return clamp((towardUp ? 0.5 + lean : 0.5 - lean) + noise, 0.02, 0.98)
}

function belief(
  persona: Persona,
  bars: readonly WindowBar[],
  settles: readonly Side[],
  rng: { a: number },
  timing: TimingConfig,
): number | null {
  if (persona.mind === "streak") return streakBelief(persona, settles, rng, timing)
  const noise = (mulberry32.sample(rng) - 0.5) * persona.noise
  if (persona.mind === "restless") return clamp(0.5 + noise, 0.02, 0.98)
  if (bars.length === 0) return null
  const z = clamp(ewmaSignal(bars.map((bar) => bar.ret), timing.ewmaLambda).z, -8, 8)
  if (persona.mind === "price") {
    const drift = clamp(z * timing.priceGain, -0.06, 0.06)
    return clamp(0.5 + drift + noise * 0.15, 0.05, 0.95)
  }
  const sign = persona.mind === "fade" ? -1 : 1
  return clamp(sigmoid(sign * Math.abs(persona.momentum) * z * timing.signalScale + noise), 0.02, 0.98)
}

export type MindDecision =
  | { action: "buy-in"; side: Side; stakeMicros: number; pUp: number; gate: GateState }
  | { action: "skip"; reason: SkipReason; pUp: number; gate: GateState }

type PriceInput = {
  wallet: WalletMind
  inBurst: boolean
  windowId: number
  now: number
  windowMs: number
  points: readonly PrintPoint[]
  poolUp: number
  poolDown: number
  settles?: readonly Side[]
  config: PersonaConfig
  stake: StakeConfig
  timing: TimingConfig
}

type Ungated = Omit<Extract<MindDecision, { action: "buy-in" }>, "gate"> | Omit<Extract<MindDecision, { action: "skip" }>, "gate">

export function decideOpen(input: PriceInput): MindDecision {
  const persona = input.wallet.persona
  const gate: GateState = {
    ...input.wallet.gate,
    results: input.wallet.gate.results.slice(-input.config.memory),
  }
  const rng = { a: gate.rngA }
  const finish = (decision: Ungated): MindDecision => {
    gate.rngA = rng.a
    return { ...decision, gate }
  }
  if (input.wallet.paused || input.wallet.bankroll < USDC) return finish({ action: "skip", reason: "waiting", pUp: 0.5 })

  const look = tapeActivity(input.points, input.now, Math.max(persona.lookbackMs, input.windowMs * 4))
  const state = regime(look.activity, input.config)
  let scale = 1
  if (state === "moving") scale = input.config.hotScale
  if (state === "flat") scale = input.config.flatScale
  scale = clamp(scale * (1 + gate.tempoNudge), input.config.scaleMin, input.config.scaleMax)

  const bars = windowBars(input.points, input.now, input.windowMs, input.timing.historyWindows)
  const settles = input.settles ?? []
  let pUp = belief(persona, bars, settles, rng, input.timing)
  const implied = impliedUp(input.poolUp, input.poolDown)
  let edge = input.config.memoryStep === 0 ? persona.edge : persona.edge + gate.edgeNudge
  if (persona.mind !== "streak" && bars.length < input.timing.thinBars) edge += input.timing.thinEdge

  if (pUp === null) {
    armQuiet(gate, persona, scale, rng, input.config, input.windowId)
    return finish({ action: "skip", reason: Math.abs(implied - 0.5) < edge ? "flat" : "no edge", pUp: 0.5 })
  }
  if (persona.second && persona.secondWeight > 0) {
    const other = belief({ ...persona, mind: persona.second, noise: persona.noise * 0.4 }, bars, settles, rng, input.timing)
    if (other !== null) pUp = lerp(pUp, other, persona.secondWeight)
  }
  pUp = clamp(pUp + gate.bias, 0.02, 0.98)

  if (
    state === "flat" &&
    (persona.mind === "tape" || persona.mind === "fade") &&
    Math.abs(pUp - 0.5) < 0.08 &&
    Math.abs(pUp - implied) < input.timing.crowdGap
  ) {
    armQuiet(gate, persona, scale, rng, input.config, input.windowId)
    return finish({ action: "skip", reason: "flat", pUp })
  }

  let side: Side | null = null
  if (pUp > implied + edge) side = "up"
  else if (pUp < implied - edge) side = "down"
  if (!side) {
    armQuiet(gate, persona, scale, rng, input.config, input.windowId)
    return finish({ action: "skip", reason: "no edge", pUp })
  }

  const price = side === "up" ? implied : 1 - implied
  const prob = side === "up" ? pUp : 1 - pUp
  const advantage = prob - price
  const odds = (1 - price) / Math.max(price, 0.05)
  const kelly =
    persona.kelly * (advantage / Math.max(odds, 0.05)) * input.wallet.bankroll * drawdownScale(gate.results, input.timing.lossScaleMin)
  const same = side === "up" ? input.poolUp : input.poolDown
  const other = side === "up" ? input.poolDown : input.poolUp
  const sStar = exhaustStake(prob, same, other, input.timing.virtualMicros)
  const smallFloor = Math.min(input.stake.smallMax * USDC, Math.floor(input.wallet.bankroll * 0.5))
  const shareCap = Math.min(
    input.wallet.bankroll,
    Math.max(Math.floor(input.wallet.bankroll * persona.bankrollShare), smallFloor, USDC),
  )
  let raw = Math.floor(Math.min(sStar, Math.max(0, kelly), shareCap, input.wallet.bankroll))
  if (raw < USDC && sStar >= USDC && input.wallet.bankroll >= USDC) raw = USDC
  const stakeMicros = raw < USDC ? null : shapeStake(raw, persona, (rng.a ^ input.windowId) >>> 0, input.wallet.bankroll, input.stake)
  if (stakeMicros === null) {
    armQuiet(gate, persona, scale, rng, input.config, input.windowId)
    return finish({ action: "skip", reason: "no edge", pUp })
  }
  if (!input.inBurst) gate.burstLeft = Math.max(0, persona.burstWindows - 1)
  gate.refractory = false
  gate.readyWindow = input.windowId + 1
  if (gate.burstLeft === 0) armRefractory(gate, persona, scale, rng, input.config, input.windowId)
  return finish({ action: "buy-in", side, stakeMicros, pUp })
}

export function decideWallet(input: GateInput & {
  poolUp: number
  poolDown: number
  settles?: readonly Side[]
  stake: StakeConfig
  timing: TimingConfig
}): MindDecision {
  const admitted = admitWallet(input)
  if (admitted.action === "skip") return { action: "skip", reason: admitted.reason, pUp: 0.5, gate: admitted.gate }
  return decideOpen({
    ...input,
    wallet: { ...input.wallet, gate: admitted.gate },
    inBurst: admitted.inBurst,
  })
}

function armQuiet(gate: GateState, persona: Persona, scale: number, rng: Mulberry32, config: PersonaConfig, windowId: number) {
  gate.refractory = false
  const step = Math.max(1, Math.round(drawGap(persona, Math.min(scale, 1.6), rng, config) * 0.25))
  gate.readyWindow = windowId + step
}

function armRefractory(gate: GateState, persona: Persona, scale: number, rng: Mulberry32, config: PersonaConfig, windowId: number) {
  gate.refractory = true
  gate.burstLeft = 0
  gate.readyWindow = windowId + Math.max(1, drawGap(persona, scale, rng, config))
}

export function noteResult(gate: GateState, won: boolean, persona: Persona, config: PersonaConfig): GateState {
  const results = [...gate.results, won].slice(-config.memory)
  let edgeNudge = gate.edgeNudge
  let tempoNudge = gate.tempoNudge
  let bias = gate.bias
  const step = config.memoryStep
  if (!won) {
    edgeNudge = clamp(edgeNudge + step, -0.02, 0.03)
    tempoNudge = clamp(tempoNudge + step * 4, -0.2, 0.5)
  } else if ((gate.rngA & 255) / 255 < config.looseRate) {
    edgeNudge = clamp(edgeNudge - step * 0.5, -0.02, 0.03)
    tempoNudge = clamp(tempoNudge - step, -0.2, 0.5)
  }
  bias = clamp(bias + (won ? step * 0.25 : -step * 0.25) * (persona.mind === "fade" ? -1 : 1), -0.02, 0.02)
  return { ...gate, results, edgeNudge, tempoNudge, bias }
}

export function decideWindow(input: {
  roundId: number
  now: number
  windowMs: number
  points: readonly PrintPoint[]
  poolUp: number
  poolDown: number
  settles?: readonly Side[]
  wallets: readonly WalletMind[]
  config: PersonaConfig
  stake: StakeConfig
  timing: TimingConfig
  cap: number
}): { orders: Order[]; skips: Skip[]; gates: Map<string, GateState> } {
  const rng = mulberry32.create(input.roundId >>> 0)
  const wallets = input.wallets.slice()
  for (let i = wallets.length - 1; i > 0; i--) {
    const j = Math.floor(mulberry32.sample(rng) * (i + 1))
    const swap = wallets[i]!
    wallets[i] = wallets[j]!
    wallets[j] = swap
  }
  let up = input.poolUp
  let down = input.poolDown
  const orders: Order[] = []
  const skips: Skip[] = []
  const gates = new Map<string, GateState>()
  for (const wallet of wallets) {
    if (orders.length >= input.cap) {
      skips.push({ address: wallet.address, reason: "waiting" })
      gates.set(wallet.address, wallet.gate)
      continue
    }
    const decision = decideWallet({
      wallet,
      windowId: input.roundId,
      now: input.now,
      windowMs: input.windowMs,
      points: input.points,
      poolUp: up,
      poolDown: down,
      settles: input.settles,
      config: input.config,
      stake: input.stake,
      timing: input.timing,
    })
    gates.set(wallet.address, decision.gate)
    if (decision.action === "skip") {
      skips.push({ address: wallet.address, reason: decision.reason })
      continue
    }
    orders.push({
      address: wallet.address,
      side: decision.side,
      stakeMicros: decision.stakeMicros,
      pUp: decision.pUp,
    })
    if (decision.side === "up") up += decision.stakeMicros
    else down += decision.stakeMicros
  }
  return { orders, skips, gates }
}
