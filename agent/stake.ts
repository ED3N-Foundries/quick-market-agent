import { clamp, lerp } from "math"
import { mulberry32, type Mulberry32 } from "math/random"
import { easing } from "math/time"
import { USDC, type StakeConfig } from "./config"
import type { Persona } from "./persona"

const MIN = USDC

function skewLow(rng: Mulberry32, low: number, high: number): number {
  return lerp(high, low, easing.expoOut(mulberry32.sample(rng)))
}

function drawDollars(rng: Mulberry32, cap: number, restless: boolean, config: StakeConfig): number {
  const ceiling = restless ? Math.min(cap, config.restlessMax) : cap
  const roll = mulberry32.sample(rng)
  if (restless || roll < config.smallMass || ceiling <= config.smallMax) {
    return skewLow(rng, config.smallMin, Math.min(config.smallMax, ceiling))
  }
  if (roll < config.smallMass + config.midMass || ceiling <= config.midMax) {
    return skewLow(rng, Math.min(config.smallMax, ceiling), Math.min(config.midMax, ceiling))
  }
  return skewLow(rng, Math.min(config.midMax, ceiling), ceiling)
}

function poster(cents: number): boolean {
  const dollars = Math.floor(cents / 100)
  const part = cents % 100
  if (part === 0) return true
  return dollars % 10 === 0 && dollars !== 0 && part === 50
}

export function shapeStake(
  kellyMicros: number,
  persona: Persona,
  seed: number,
  balanceMicros: number,
  config: StakeConfig,
): number | null {
  if (kellyMicros < MIN || balanceMicros < MIN) return null
  const rng = mulberry32.create(seed >>> 0)
  const capMicros = Math.min(kellyMicros, balanceMicros)
  const capDollars = capMicros / USDC
  if (capDollars < config.smallMin) return null
  let dollars = drawDollars(rng, capDollars, persona.mind === "restless", config)
  dollars = clamp(dollars, config.smallMin, capDollars)
  const maxCents = Math.floor(balanceMicros / 10_000)
  const capCents = Math.floor(capMicros / 10_000)
  if (maxCents < 100 || capCents < 100) return null
  let cents = clamp(Math.round(dollars * 100), 100, capCents)
  if (poster(cents) || cents < 100 + config.offsetMinCents) {
    const offset = Math.round(lerp(config.offsetMinCents, config.offsetMaxCents, mulberry32.sample(rng)))
    const canDown = cents - offset >= 100 + config.offsetMinCents
    const canUp = cents + offset <= maxCents
    if (canDown && canUp) {
      cents += (mulberry32.sample(rng) < 0.5 ? -1 : 1) * offset
    } else if (canUp) {
      cents += offset
    } else if (canDown) {
      cents -= offset
    }
  }
  const micros = cents * 10_000
  if (micros < MIN || micros > balanceMicros) return null
  return micros
}
