import { mulberry32 } from "math/random"
import type { MindName, TimingConfig } from "./config"

export type FireSlot = {
  address: string
  fireAt: number
  inBurst: boolean
}

export function slotSpan(mind: MindName, timing: TimingConfig): readonly [number, number] {
  if (mind === "tape") return timing.tapeSlot
  if (mind === "restless") return timing.restlessSlot
  if (mind === "streak") return timing.streakSlot
  return timing.fadeSlot
}

export function fireAt(
  index: number,
  mind: MindName,
  windowId: number,
  openAt: number,
  closeAt: number,
  timing: TimingConfig,
): number {
  const span = Math.max(0, closeAt - openAt)
  const margin = Math.min(timing.marginMs, Math.floor(span / 4))
  const usable = span - 2 * margin
  const [low, high] = slotSpan(mind, timing)
  const rng = mulberry32.create((Math.imul(index + 1, 0x9e3779b1) ^ Math.imul(windowId + 1, 0x85ebca6b)) >>> 0)
  const slot = low + (high - low) * mulberry32.sample(rng)
  if (usable <= 0) return openAt + margin
  return openAt + margin + slot * usable
}

export function releaseWave(input: {
  queue: readonly FireSlot[]
  now: number
  closeAt: number
  timing: TimingConfig
}): { due: FireSlot[]; queue: FireSlot[]; dropped: FireSlot[] } {
  const latest = input.closeAt - input.timing.marginMs
  const sorted = [...input.queue].sort((left, right) => left.fireAt - right.fireAt || (left.address < right.address ? -1 : 1))
  const due: FireSlot[] = []
  const queue: FireSlot[] = []
  const dropped: FireSlot[] = []
  for (const slot of sorted) {
    if (slot.fireAt > input.now) {
      queue.push(slot)
      continue
    }
    if (due.length < input.timing.waveCap) {
      due.push(slot)
      continue
    }
    const slipped = slot.fireAt + input.timing.sliceMs
    if (slipped < latest) queue.push({ ...slot, fireAt: slipped })
    else dropped.push(slot)
  }
  return { due, queue, dropped }
}
