import { lerp } from "math"
import { mulberry32 } from "math/random"
import { easing } from "math/time"
import type { MindName, PersonaConfig } from "./config"

export type Persona = {
  index: number
  mind: MindName
  second: MindName | null
  secondWeight: number
  momentum: number
  lookbackMs: number
  slowLookbackMs: number
  edge: number
  kelly: number
  bankrollShare: number
  noise: number
  tempoWindows: number
  burstWindows: number
  streakNeed: 2 | 3 | 4 | 5
  streakFade: boolean
  streakConviction: number
}

const ORDER: MindName[] = ["tape", "fade", "price", "restless", "streak"]
const STREAK_NEEDS = [2, 3, 4, 5] as const

function skewLow(rng: { a: number }, low: number, high: number): number {
  return lerp(high, low, easing.expoOut(mulberry32.sample(rng)))
}

function mindAt(sample: number, shares: PersonaConfig["shares"]): MindName {
  let cursor = sample
  for (const mind of ORDER) {
    cursor -= shares[mind]
    if (cursor <= 0) return mind
  }
  return "streak"
}

function streakNeedAt(sample: number, weights: readonly number[]): 2 | 3 | 4 | 5 {
  let cursor = sample
  for (let index = 0; index < STREAK_NEEDS.length; index++) {
    cursor -= weights[index] ?? 0
    if (cursor <= 0) return STREAK_NEEDS[index]!
  }
  return 5
}

export function personaFor(index: number, config: PersonaConfig): Persona {
  const rng = mulberry32.create(Math.imul(index + 1, 0xa24baed) >>> 0)
  const mind = mindAt(mulberry32.sample(rng), config.shares)
  let second: MindName | null = null
  if (mulberry32.sample(rng) < config.secondRate) {
    const other = mindAt(mulberry32.sample(rng), config.shares)
    second = other === mind ? null : other
  }
  const restless = mind === "restless"
  const momentum = lerp(-1, 1, mulberry32.sample(rng))
  const streakNeed = streakNeedAt(mulberry32.sample(rng), config.streakNeedWeights)
  const streakFade = mulberry32.sample(rng) < config.streakFadeShare
  const streakConviction = lerp(config.streakConvictionMin, config.streakConvictionMax, mulberry32.sample(rng))
  return {
    index,
    mind,
    second,
    secondWeight: second ? config.secondWeight : 0,
    momentum: mind === "fade" ? -Math.abs(momentum) : mind === "tape" ? Math.abs(momentum) : momentum * 0.25,
    lookbackMs: skewLow(rng, config.lookbackMinMs, config.lookbackMaxMs),
    slowLookbackMs: lerp(config.lookbackMaxMs, config.slowLookbackMs, mulberry32.sample(rng)),
    edge: restless ? config.restlessEdge : skewLow(rng, config.edgeMin, config.edgeMax),
    kelly: skewLow(rng, config.kellyMin, config.kellyMax),
    bankrollShare: restless ? config.restlessShare : skewLow(rng, config.shareMin, config.shareMax),
    noise: restless ? config.restlessNoise : skewLow(rng, config.noiseMin, config.noiseMax),
    tempoWindows: restless
      ? skewLow(rng, config.restlessTempoMin, config.restlessTempoMax)
      : skewLow(rng, config.tempoMin, config.tempoMax),
    burstWindows: Math.round(skewLow(rng, config.burstMin, config.burstMax)),
    streakNeed,
    streakFade,
    streakConviction,
  }
}
