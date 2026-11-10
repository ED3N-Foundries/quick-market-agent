import { lerp } from "math"
import { mulberry32 } from "math/random"
import { easing } from "math/time"
import type { BankConfig } from "./config"

export type BankAction =
  | { kind: "none" }
  | { kind: "mint"; amountMicros: number; pocketMicros: number }
  | { kind: "burn"; amountMicros: number; pocketMicros: number }

function pocket(index: number, salt: number, low: number, high: number): number {
  const rng = mulberry32.create(Math.imul(index + 1, salt) >>> 0)
  const skewed = lerp(Math.log(high), Math.log(low), easing.expoOut(mulberry32.sample(rng)))
  return Math.round(Math.exp(skewed))
}

export function seedMicros(index: number, config: BankConfig): number {
  return pocket(index, 0x6a09e667, config.seedMinMicros, config.seedMaxMicros)
}

export function refillPocket(index: number, config: BankConfig): number {
  return pocket(index, 0xbb67ae85, config.refillMinMicros, config.refillMaxMicros)
}

export function burnPocket(index: number, config: BankConfig): number {
  return pocket(index, 0x3c6ef372, config.burnMinMicros, config.burnMaxMicros)
}

export function bankAction(balanceMicros: number, index: number, config: BankConfig, handled: boolean): BankAction {
  if (handled) return { kind: "none" }
  if (balanceMicros < config.floorMicros) {
    const pocketMicros = refillPocket(index, config)
    const amountMicros = pocketMicros - balanceMicros
    if (amountMicros <= 0) return { kind: "none" }
    return { kind: "mint", amountMicros, pocketMicros }
  }
  if (balanceMicros > config.capMicros) {
    const pocketMicros = burnPocket(index, config)
    const amountMicros = balanceMicros - pocketMicros
    if (amountMicros <= 0) return { kind: "none" }
    return { kind: "burn", amountMicros, pocketMicros }
  }
  return { kind: "none" }
}
