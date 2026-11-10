import * as z from "zod"
import type { Assert, Equal } from "../shared/exact"

export const USDC = 1_000_000

export type Range = readonly [number, number]

export type TapeStats = {
  absReturn: number
  volatility: number
}

export type ClockConfig = {
  timeZoneOffsetHours: number
  windowWidth: number
  floor: number
  ceiling: number
  smoothTime: number
  perSecond: number
  offPeak: { fromHour: number; toHour: number; box: Range }
  rise: { fromHour: number; toHour: number; fromCenter: number; toCenter: number }
  peak: { fromHour: number; toHour: number; box: Range }
  decline: { fromHour: number; toHour: number; toCenter: number }
  noise: {
    slow: number
    fast: number
    interest: number
    slowHours: number
    fastHours: number
    octaves: number
    lacunarity: number
    gain: number
  }
}

export type PresenceConfig = {
  chronotypeHours: number
  hysteresis: number
  visitMinMs: number
  visitMaxMs: number
  gapMinMs: number
  gapMaxMs: number
  offHoursStretch: number
  tapeStretch: number
  tapeShrink: number
  jitterMs: number
  moodMs: number
  almostMs: number
  backfillMs: number
  offHoursFloor: number
  herdWindowMs: number
  herdDecayMs: number
  herdCap: number
  herdSimilarityHours: number
  earlyVisitMs: number
}

export type BankConfig = {
  floorMicros: number
  capMicros: number
  seedMinMicros: number
  seedMaxMicros: number
  refillMinMicros: number
  refillMaxMicros: number
  burnMinMicros: number
  burnMaxMicros: number
}

export type MindName = "tape" | "fade" | "price" | "restless" | "streak"

export type PersonaConfig = {
  shares: Record<MindName, number>
  secondRate: number
  secondWeight: number
  lookbackMinMs: number
  lookbackMaxMs: number
  slowLookbackMs: number
  edgeMin: number
  edgeMax: number
  restlessEdge: number
  kellyMin: number
  kellyMax: number
  shareMin: number
  shareMax: number
  restlessShare: number
  noiseMin: number
  noiseMax: number
  restlessNoise: number
  tempoMin: number
  tempoMax: number
  restlessTempoMin: number
  restlessTempoMax: number
  burstMin: number
  burstMax: number
  burstFire: number
  hotScale: number
  flatScale: number
  scaleMin: number
  scaleMax: number
  movingBand: number
  flatBand: number
  herdBand: number
  herdWeight: number
  memory: number
  memoryStep: number
  looseRate: number
  gateFire: number
  streakFadeShare: number
  streakNeedWeights: readonly [number, number, number, number]
  streakConvictionMin: number
  streakConvictionMax: number
}

export type StakeConfig = {
  smallMin: number
  smallMax: number
  midMax: number
  smallMass: number
  midMass: number
  offsetMinCents: number
  offsetMaxCents: number
  restlessMax: number
}

export type RunnerConfig = {
  enrollWidth: number
  betChunk: number
  orderCap: number
  auditSlice: number
  auditEveryMs: number
  bankEveryMs: number
  snapshotEveryMs: number
  tapeTailMs: number
  presenceTickMs: number
  keyCap: number
}

export type TimingConfig = {
  historyWindows: number
  thinBars: number
  thinEdge: number
  ewmaLambda: number
  signalScale: number
  priceGain: number
  virtualMicros: number
  marginMs: number
  sliceMs: number
  waveCap: number
  lossScaleMin: number
  crowdGap: number
  tapeSlot: Range
  fadeSlot: Range
  restlessSlot: Range
  streakSlot: Range
  streakLean: number
  streakLeanStep: number
  streakLeanCap: number
  streakNoiseScale: number
}

export type SwarmConfig = {
  clock: ClockConfig
  presence: PresenceConfig
  bank: BankConfig
  persona: PersonaConfig
  stake: StakeConfig
  runner: RunnerConfig
  timing: TimingConfig
}

const range = z.tuple([z.number(), z.number()]).readonly()

const clockSchema = z.strictObject({
  timeZoneOffsetHours: z.number(),
  windowWidth: z.number(),
  floor: z.number(),
  ceiling: z.number(),
  smoothTime: z.number(),
  perSecond: z.number(),
  offPeak: z.strictObject({ fromHour: z.number(), toHour: z.number(), box: range }),
  rise: z.strictObject({
    fromHour: z.number(),
    toHour: z.number(),
    fromCenter: z.number(),
    toCenter: z.number(),
  }),
  peak: z.strictObject({ fromHour: z.number(), toHour: z.number(), box: range }),
  decline: z.strictObject({ fromHour: z.number(), toHour: z.number(), toCenter: z.number() }),
  noise: z.strictObject({
    slow: z.number(),
    fast: z.number(),
    interest: z.number(),
    slowHours: z.number(),
    fastHours: z.number(),
    octaves: z.number(),
    lacunarity: z.number(),
    gain: z.number(),
  }),
})

const presenceSchema = z.strictObject({
  chronotypeHours: z.number(),
  hysteresis: z.number(),
  visitMinMs: z.number(),
  visitMaxMs: z.number(),
  gapMinMs: z.number(),
  gapMaxMs: z.number(),
  offHoursStretch: z.number(),
  tapeStretch: z.number(),
  tapeShrink: z.number(),
  jitterMs: z.number(),
  moodMs: z.number(),
  almostMs: z.number(),
  backfillMs: z.number(),
  offHoursFloor: z.number(),
  herdWindowMs: z.number(),
  herdDecayMs: z.number(),
  herdCap: z.number(),
  herdSimilarityHours: z.number(),
  earlyVisitMs: z.number(),
})

const bankSchema = z.strictObject({
  floorMicros: z.number(),
  capMicros: z.number(),
  seedMinMicros: z.number(),
  seedMaxMicros: z.number(),
  refillMinMicros: z.number(),
  refillMaxMicros: z.number(),
  burnMinMicros: z.number(),
  burnMaxMicros: z.number(),
})

const personaSchema = z.strictObject({
  shares: z.strictObject({
    tape: z.number(),
    fade: z.number(),
    price: z.number(),
    restless: z.number(),
    streak: z.number(),
  }),
  secondRate: z.number(),
  secondWeight: z.number(),
  lookbackMinMs: z.number(),
  lookbackMaxMs: z.number(),
  slowLookbackMs: z.number(),
  edgeMin: z.number(),
  edgeMax: z.number(),
  restlessEdge: z.number(),
  kellyMin: z.number(),
  kellyMax: z.number(),
  shareMin: z.number(),
  shareMax: z.number(),
  restlessShare: z.number(),
  noiseMin: z.number(),
  noiseMax: z.number(),
  restlessNoise: z.number(),
  tempoMin: z.number(),
  tempoMax: z.number(),
  restlessTempoMin: z.number(),
  restlessTempoMax: z.number(),
  burstMin: z.number(),
  burstMax: z.number(),
  burstFire: z.number(),
  hotScale: z.number(),
  flatScale: z.number(),
  scaleMin: z.number(),
  scaleMax: z.number(),
  movingBand: z.number(),
  flatBand: z.number(),
  herdBand: z.number(),
  herdWeight: z.number(),
  memory: z.number(),
  memoryStep: z.number(),
  looseRate: z.number(),
  gateFire: z.number(),
  streakFadeShare: z.number(),
  streakNeedWeights: z.tuple([z.number(), z.number(), z.number(), z.number()]).readonly(),
  streakConvictionMin: z.number(),
  streakConvictionMax: z.number(),
})

const stakeSchema = z.strictObject({
  smallMin: z.number(),
  smallMax: z.number(),
  midMax: z.number(),
  smallMass: z.number(),
  midMass: z.number(),
  offsetMinCents: z.number(),
  offsetMaxCents: z.number(),
  restlessMax: z.number(),
})

const runnerSchema = z.strictObject({
  enrollWidth: z.number(),
  betChunk: z.number(),
  orderCap: z.number(),
  auditSlice: z.number(),
  auditEveryMs: z.number(),
  bankEveryMs: z.number(),
  snapshotEveryMs: z.number(),
  tapeTailMs: z.number(),
  presenceTickMs: z.number(),
  keyCap: z.number(),
})

const timingSchema = z.strictObject({
  historyWindows: z.number(),
  thinBars: z.number(),
  thinEdge: z.number(),
  ewmaLambda: z.number(),
  signalScale: z.number(),
  priceGain: z.number(),
  virtualMicros: z.number(),
  marginMs: z.number(),
  sliceMs: z.number(),
  waveCap: z.number(),
  lossScaleMin: z.number(),
  crowdGap: z.number(),
  tapeSlot: range,
  fadeSlot: range,
  restlessSlot: range,
  streakSlot: range,
  streakLean: z.number(),
  streakLeanStep: z.number(),
  streakLeanCap: z.number(),
  streakNoiseScale: z.number(),
})

const swarmSchema = z.strictObject({
  clock: clockSchema,
  presence: presenceSchema,
  bank: bankSchema,
  persona: personaSchema,
  stake: stakeSchema,
  runner: runnerSchema,
  timing: timingSchema,
})

type _swarm = Assert<Equal<z.infer<typeof swarmSchema>, SwarmConfig>>

const swarmInput: SwarmConfig = {
  clock: {
    timeZoneOffsetHours: 8,
    windowWidth: 300,
    floor: 300,
    ceiling: 6_000,
    smoothTime: 180,
    perSecond: 30,
    offPeak: { fromHour: 2, toHour: 7, box: [300, 600] },
    rise: { fromHour: 7, toHour: 17, fromCenter: 450, toCenter: 3_150 },
    peak: { fromHour: 17, toHour: 23, box: [3_000, 6_000] },
    decline: { fromHour: 23, toHour: 2, toCenter: 450 },
    noise: {
      slow: 0.72,
      fast: 0.2,
      interest: 0.08,
      slowHours: 0.15,
      fastHours: 1.7,
      octaves: 4,
      lacunarity: 2,
      gain: 0.5,
    },
  },
  presence: {
    chronotypeHours: 2,
    hysteresis: 40,
    visitMinMs: 3 * 60_000,
    visitMaxMs: 90 * 60_000,
    gapMinMs: 12 * 60_000,
    gapMaxMs: 5 * 60 * 60_000,
    offHoursStretch: 2.6,
    tapeStretch: 0.22,
    tapeShrink: 0.28,
    jitterMs: 90_000,
    moodMs: 18 * 60_000,
    almostMs: 4 * 60_000,
    backfillMs: 12 * 60_000,
    offHoursFloor: 0.2,
    herdWindowMs: 60_000,
    herdDecayMs: 3 * 60_000,
    herdCap: 4,
    herdSimilarityHours: 0.75,
    earlyVisitMs: 90_000,
  },
  bank: {
    floorMicros: 3 * USDC,
    capMicros: 1_000 * USDC,
    seedMinMicros: 8 * USDC,
    seedMaxMicros: 250 * USDC,
    refillMinMicros: 6 * USDC,
    refillMaxMicros: 24 * USDC,
    burnMinMicros: 80 * USDC,
    burnMaxMicros: 600 * USDC,
  },
  persona: {
    shares: { tape: 0.35, fade: 0.2, price: 0.2, restless: 0.1, streak: 0.15 },
    secondRate: 0.2,
    secondWeight: 0.16,
    lookbackMinMs: 2_000,
    lookbackMaxMs: 12_000,
    slowLookbackMs: 90_000,
    edgeMin: 0.012,
    edgeMax: 0.06,
    restlessEdge: 0.001,
    kellyMin: 0.2,
    kellyMax: 0.55,
    shareMin: 0.01,
    shareMax: 0.08,
    restlessShare: 0.02,
    noiseMin: 0.05,
    noiseMax: 0.18,
    restlessNoise: 0.9,
    tempoMin: 8,
    tempoMax: 36,
    restlessTempoMin: 3,
    restlessTempoMax: 9,
    burstMin: 1,
    burstMax: 3,
    burstFire: 0.58,
    hotScale: 0.84,
    flatScale: 4.8,
    scaleMin: 0.4,
    scaleMax: 6,
    movingBand: 0.55,
    flatBand: 0.18,
    herdBand: 0.04,
    herdWeight: 0.12,
    memory: 32,
    memoryStep: 0.004,
    looseRate: 0.15,
    gateFire: 0.86,
    streakFadeShare: 0.62,
    streakNeedWeights: [0.15, 0.35, 0.35, 0.15],
    streakConvictionMin: 0.65,
    streakConvictionMax: 1.35,
  },
  stake: {
    smallMin: 1,
    smallMax: 8,
    midMax: 40,
    smallMass: 0.78,
    midMass: 0.18,
    offsetMinCents: 3,
    offsetMaxCents: 40,
    restlessMax: 8,
  },
  runner: {
    enrollWidth: 16,
    betChunk: 200,
    orderCap: 800,
    auditSlice: 200,
    auditEveryMs: 4_000,
    bankEveryMs: 5_000,
    snapshotEveryMs: 250,
    tapeTailMs: 90_000,
    presenceTickMs: 1_000,
    keyCap: 6_000,
  },
  timing: {
    historyWindows: 4,
    thinBars: 3,
    thinEdge: 0.02,
    ewmaLambda: 0.55,
    signalScale: 1.2,
    priceGain: 0.01,
    virtualMicros: 10 * USDC,
    marginMs: 400,
    sliceMs: 350,
    waveCap: 80,
    lossScaleMin: 0.35,
    crowdGap: 0.15,
    tapeSlot: [0.08, 0.42],
    fadeSlot: [0.45, 0.9],
    restlessSlot: [0.08, 0.9],
    streakSlot: [0.3, 0.7],
    streakLean: 0.09,
    streakLeanStep: 0.04,
    streakLeanCap: 0.22,
    streakNoiseScale: 0.35,
  },
}

export const swarmConfig: SwarmConfig = swarmSchema.parse(swarmInput)

function rangeOk(range: Range, label: string): string | null {
  if (!(range[0] < range[1])) return `${label} has its low end second`
  return null
}

export function checkConfig(config: SwarmConfig): string | null {
  const shares = Object.values(config.persona.shares)
  const shareSum = shares.reduce((sum, share) => sum + share, 0)
  if (Math.abs(shareSum - 1) > 1e-6) return "Mind shares must sum to 1"
  if (shares.some((share) => share < 0)) return "Mind shares must be positive"

  const pairs: [number, number, string][] = [
    [config.clock.offPeak.box[0], config.clock.offPeak.box[1], "Off-peak box"],
    [config.clock.peak.box[0], config.clock.peak.box[1], "Peak box"],
    [config.clock.rise.fromCenter, config.clock.rise.toCenter, "Morning rise"],
    [config.presence.visitMinMs, config.presence.visitMaxMs, "Visit length"],
    [config.presence.gapMinMs, config.presence.gapMaxMs, "Visit gap"],
    [config.bank.seedMinMicros, config.bank.seedMaxMicros, "Seed"],
    [config.bank.refillMinMicros, config.bank.refillMaxMicros, "Refill pocket"],
    [config.bank.burnMinMicros, config.bank.burnMaxMicros, "Burn pocket"],
    [config.persona.lookbackMinMs, config.persona.lookbackMaxMs, "Lookback"],
    [config.persona.edgeMin, config.persona.edgeMax, "Edge"],
    [config.persona.kellyMin, config.persona.kellyMax, "Kelly"],
    [config.persona.shareMin, config.persona.shareMax, "Bankroll share"],
    [config.persona.noiseMin, config.persona.noiseMax, "Noise"],
    [config.persona.tempoMin, config.persona.tempoMax, "Tempo"],
    [config.persona.restlessTempoMin, config.persona.restlessTempoMax, "Restless tempo"],
    [config.persona.burstMin, config.persona.burstMax, "Burst"],
    [config.persona.scaleMin, config.persona.scaleMax, "Gap scale"],
    [config.stake.smallMin, config.stake.smallMax, "Small stakes"],
    [config.stake.smallMax, config.stake.midMax, "Mid stakes"],
    [config.stake.offsetMinCents, config.stake.offsetMaxCents, "Cent offset"],
    [config.timing.tapeSlot[0], config.timing.tapeSlot[1], "Tape slot"],
    [config.timing.fadeSlot[0], config.timing.fadeSlot[1], "Fade slot"],
    [config.timing.restlessSlot[0], config.timing.restlessSlot[1], "Restless slot"],
    [config.timing.streakSlot[0], config.timing.streakSlot[1], "Streak slot"],
    [config.persona.streakConvictionMin, config.persona.streakConvictionMax, "Streak conviction"],
  ]
  for (const [low, high, label] of pairs) {
    if (!(low < high)) return `${label} has its low end second`
  }

  const { clock } = config
  if (clock.offPeak.box[1] - clock.offPeak.box[0] !== clock.windowWidth) return "Off-peak window does not match its box"
  if (clock.offPeak.box[0] < clock.floor || clock.offPeak.box[1] > clock.ceiling) return "Off-peak window leaves its legal box"
  const half = clock.windowWidth / 2
  if (clock.rise.fromCenter - half < clock.floor || clock.rise.toCenter + half > clock.ceiling) {
    return "Morning window leaves its legal box"
  }
  if (clock.peak.box[1] - clock.peak.box[0] <= clock.windowWidth) return "Peak box has no spare room"
  if (clock.peak.box[0] < clock.floor || clock.peak.box[1] > clock.ceiling) return "Peak window leaves its legal box"
  if (clock.rise.toCenter !== clock.peak.box[0] + half) return "Morning rise misses the low end of the peak box"
  if (clock.decline.toCenter - half < clock.floor) return "Decline window leaves its legal box"

  const weights = [clock.noise.slow, clock.noise.fast, clock.noise.interest]
  if (weights.some((weight) => weight < 0)) return "Noise weights must be positive"
  if (weights.reduce((sum, weight) => sum + weight, 0) > 1) return "Noise weights do not fit in the spare room"

  const bands = [config.persona.flatBand, config.persona.movingBand, config.persona.herdBand, config.persona.herdWeight]
  if (bands.some((band) => band < 0 || band > 1)) return "Gate bands must sit inside 0–1"
  if (!(config.persona.flatBand < config.persona.movingBand)) return "Flat gate sits above the moving gate"
  if (config.bank.floorMicros >= config.bank.capMicros) return "Bank floor sits on the cap"
  if (config.runner.keyCap !== clock.ceiling) return "Key cap and the crowd ceiling differ"

  const { timing } = config
  if (timing.historyWindows < 1) return "History needs a window"
  if (timing.thinBars < 1) return "Thin history needs a bar"
  if (!(timing.ewmaLambda > 0 && timing.ewmaLambda < 1)) return "EWMA lambda sits outside (0, 1)"
  if (!(timing.signalScale > 0)) return "Signal scale must be positive"
  if (!(timing.priceGain > 0)) return "Price gain must be positive"
  if (timing.virtualMicros < USDC) return "Virtual pool is below 1 USDC"
  if (timing.marginMs < 0) return "Window margin is negative"
  if (!(timing.sliceMs > 0)) return "Wave slice must be positive"
  if (timing.waveCap < 1) return "Wave cap must be positive"
  if (!(timing.lossScaleMin > 0 && timing.lossScaleMin <= 1)) return "Loss scale sits outside (0, 1]"
  if (!(timing.crowdGap > 0 && timing.crowdGap <= 1)) return "Crowd gap sits outside (0, 1]"
  const slots = [timing.tapeSlot, timing.fadeSlot, timing.restlessSlot, timing.streakSlot]
  if (slots.some((slot) => slot[0] < 0 || slot[1] > 1)) return "Fire slots leave 0–1"
  if (timing.tapeSlot[1] > timing.fadeSlot[0]) return "Tape slot overlaps the late slot"
  if (!(timing.streakLean > 0)) return "Streak lean must be positive"
  if (!(timing.streakLeanStep > 0)) return "Streak lean step must be positive"
  if (!(timing.streakLeanCap >= timing.streakLean)) return "Streak lean cap sits under the base lean"
  if (!(timing.streakNoiseScale > 0 && timing.streakNoiseScale <= 1)) return "Streak noise sits outside (0, 1]"
  const needWeights = config.persona.streakNeedWeights
  const needSum = needWeights.reduce((sum, weight) => sum + weight, 0)
  if (Math.abs(needSum - 1) > 1e-6) return "Streak lengths must sum to 1"
  if (needWeights.some((weight) => weight < 0)) return "Streak lengths must be positive"
  if (!(config.persona.streakFadeShare > 0 && config.persona.streakFadeShare < 1)) {
    return "Streak fade share sits outside (0, 1)"
  }
  return rangeOk(clock.offPeak.box, "Off-peak")
}
