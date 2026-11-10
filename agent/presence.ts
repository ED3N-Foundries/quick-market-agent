import { clamp, lerp } from "math"
import { simplex2d } from "math/noise"
import { mulberry32 } from "math/random"
import { easing } from "math/time"
import type { PresenceConfig } from "./config"

export type WalletClock = {
  index: number
  address: string
  cursor: number
  visitStart: number
  visitEnd: number
  gapEnd: number
}

export type TapeBend = {
  moving: boolean
  flat: boolean
}

export type Arrival = {
  index: number
  at: number
}

export type PresenceStep = {
  clocks: WalletClock[]
  online: string[]
  arrived: string[]
  left: string[]
}

function skewLow(rng: { a: number }, low: number, high: number): number {
  return lerp(high, low, easing.expoOut(mulberry32.sample(rng)))
}

export function chronotype(index: number, config: PresenceConfig): { offsetHours: number; preferredHour: number } {
  const rng = mulberry32.create(Math.imul(index + 1, 0x9e3779b1) >>> 0)
  const offsetHours = (mulberry32.sample(rng) * 2 - 1) * config.chronotypeHours
  const skew = 1 - easing.expoOut(mulberry32.sample(rng))
  const preferredHour = (16 + skew * 8 + offsetHours + 24) % 24
  return { offsetHours, preferredHour }
}

function hourDistance(left: number, right: number): number {
  const raw = Math.abs(left - right) % 24
  return Math.min(raw, 24 - raw)
}

export function chronotypeFit(index: number, hour: number, config: PresenceConfig): number {
  const preferred = chronotype(index, config).preferredHour
  return clamp(1 - hourDistance(hour, preferred) / 6, 0, 1)
}

function moodBias(index: number, now: number, config: PresenceConfig): number {
  const noise = simplex2d.sample(simplex2d.create(index + 11), now / 3_600_000, 0.4)
  return noise * config.moodMs
}

function drawVisit(index: number, cursor: number, hour: number, config: PresenceConfig): {
  cursor: number
  visit: number
  gap: number
} {
  const rng = { a: cursor }
  const visit = skewLow(rng, config.visitMinMs, config.visitMaxMs)
  let gap = skewLow(rng, config.gapMinMs, config.gapMaxMs)
  if (chronotypeFit(index, hour, config) < 0.45) gap = Math.min(config.gapMaxMs, gap * config.offHoursStretch)
  const jitter = (mulberry32.sample(rng) - 0.5) * 2 * config.jitterMs
  return { cursor: rng.a, visit, gap: Math.max(config.gapMinMs, gap + Math.max(0, jitter)) }
}

export function openClock(index: number, address: string, now: number, hour: number, config: PresenceConfig): WalletClock {
  const rng = mulberry32.create(Math.imul(index + 1, 0x85ebca6b) >>> 0)
  const drawn = drawVisit(index, rng.a, hour, config)
  const cycle = drawn.visit + drawn.gap
  const into = mulberry32.sample({ a: drawn.cursor }) * cycle
  const mood = clamp(moodBias(index, now, config), -config.jitterMs, config.jitterMs)
  const start = now - into + mood
  return {
    index,
    address,
    cursor: drawn.cursor,
    visitStart: start,
    visitEnd: start + drawn.visit,
    gapEnd: start + cycle,
  }
}

export function rollClock(clock: WalletClock, now: number, hour: number, config: PresenceConfig): WalletClock {
  let current = clock
  let guard = 0
  while (now >= current.gapEnd && guard < 64) {
    const drawn = drawVisit(clock.index, current.cursor, hour, config)
    const visitStart = current.gapEnd
    current = {
      index: clock.index,
      address: clock.address,
      cursor: drawn.cursor,
      visitStart,
      visitEnd: visitStart + drawn.visit,
      gapEnd: visitStart + drawn.visit + drawn.gap,
    }
    guard += 1
  }
  return current
}

export function effectiveVisit(
  clock: WalletClock,
  now: number,
  tape: TapeBend,
  config: PresenceConfig,
): { start: number; end: number; inVisit: boolean; ended: boolean; dueIn: number; startedAgo: number } {
  const length = Math.max(1, clock.visitEnd - clock.visitStart)
  let end = clock.visitEnd
  if (tape.moving) end += length * config.tapeStretch
  if (tape.flat) end -= length * config.tapeShrink
  end = clamp(end, clock.visitStart + 1_000, clock.gapEnd)
  const inVisit = now >= clock.visitStart && now < end
  const ended = now >= end && now < clock.gapEnd
  const dueIn = inVisit ? 0 : now < clock.visitStart ? clock.visitStart - now : Math.max(0, clock.gapEnd - now)
  const startedAgo = inVisit ? now - clock.visitStart : 0
  return { start: clock.visitStart, end, inVisit, ended, dueIn, startedAgo }
}

type Row = ReturnType<typeof effectiveVisit> & {
  address: string
  index: number
  fit: number
}

function herdPull(index: number, recent: readonly Arrival[], now: number, config: PresenceConfig): boolean {
  const mine = chronotype(index, config).offsetHours
  let weight = 0
  for (const arrival of recent) {
    const age = now - arrival.at
    if (age < 0 || age > config.herdDecayMs) continue
    const other = chronotype(arrival.index, config).offsetHours
    if (Math.abs(mine - other) > config.herdSimilarityHours) continue
    weight += 1 - age / config.herdDecayMs
  }
  return weight >= 2
}

export function stepPresence(input: {
  clocks: readonly WalletClock[]
  seated: ReadonlySet<string>
  now: number
  dtSec: number
  hour: number
  target: number
  window: readonly [number, number]
  tape: TapeBend
  recentArrivals: readonly Arrival[]
  config: PresenceConfig
  perSecond: number
}): PresenceStep {
  const clocks = input.clocks.map((clock) => rollClock(clock, input.now, input.hour, input.config))
  const rows: Row[] = clocks.map((clock) => ({
    ...effectiveVisit(clock, input.now, input.tape, input.config),
    address: clock.address,
    index: clock.index,
    fit: chronotypeFit(clock.index, input.hour, input.config),
  }))
  const byAddress = new Map(rows.map((row) => [row.address, row]))
  const goal = Math.max(0, Math.round(input.target))
  const floor = Math.min(goal, input.window[0])
  const ceiling = Math.max(goal, input.window[1])
  const cap = Math.max(0, Math.floor(input.perSecond * Math.max(0, input.dtSec)))
  const next = new Set(input.seated)
  let arrived = 0
  let left = 0

  const outRank = (row: Row) => {
    if (row.ended) return 0
    if (row.startedAgo > 0 && row.startedAgo < input.config.earlyVisitMs) return 1
    if (row.fit < 0.5) return 2
    return 3 + row.fit
  }
  const seatedRows = () =>
    [...next]
      .map((address) => byAddress.get(address))
      .filter((row): row is Row => row !== undefined)
      .sort((leftRow, rightRow) => outRank(leftRow) - outRank(rightRow) || leftRow.startedAgo - rightRow.startedAgo)

  const shrinking = next.size > goal
  const replacements = rows.filter(
    (row) => !next.has(row.address) && (row.inVisit || row.dueIn <= input.config.backfillMs || row.fit >= input.config.offHoursFloor),
  ).length
  if (shrinking || replacements > 0) {
    let swapBudget = shrinking ? cap : Math.min(cap, replacements)
    for (const row of seatedRows()) {
      if (!row.ended || left >= cap || swapBudget <= 0) break
      next.delete(row.address)
      left += 1
      swapBudget -= 1
    }
  }
  while (next.size > goal + input.config.hysteresis && left < cap) {
    const victim = seatedRows()[0]
    if (!victim) break
    next.delete(victim.address)
    left += 1
  }

  const waiting = rows
    .filter((row) => !next.has(row.address))
    .map((row) => {
      const pulled = herdPull(row.index, input.recentArrivals, input.now, input.config)
      const dueIn = pulled ? Math.max(0, row.dueIn - input.config.almostMs) : row.dueIn
      return { ...row, dueIn, inVisit: row.inVisit || (pulled && dueIn === 0) }
    })
    .filter((row) => {
      if (row.inVisit) return true
      if (row.dueIn > input.config.almostMs) return false
      if (row.fit < input.config.offHoursFloor && row.dueIn > input.config.almostMs / 5) return false
      return true
    })
    .sort((leftRow, rightRow) => leftRow.dueIn - rightRow.dueIn || leftRow.start - rightRow.start)

  let herded = 0
  for (const row of waiting) {
    if (next.size >= goal || arrived >= cap) break
    const pulled = !rows.find((item) => item.address === row.address)?.inVisit && row.inVisit
    if (pulled) {
      if (herded >= input.config.herdCap) continue
      herded += 1
    }
    next.add(row.address)
    arrived += 1
  }

  if (next.size < goal && arrived < cap) {
    const soonest = rows
      .filter(
        (row) =>
          !next.has(row.address) &&
          !input.seated.has(row.address) &&
          (row.fit >= input.config.offHoursFloor || row.dueIn <= input.config.backfillMs),
      )
      .sort((leftRow, rightRow) => leftRow.dueIn - rightRow.dueIn || leftRow.start - rightRow.start)
    for (const row of soonest) {
      if (next.size >= goal || arrived >= cap) break
      next.add(row.address)
      arrived += 1
    }
  }

  if (next.size < floor) {
    const backfill = rows
      .filter((row) => !next.has(row.address) && !input.seated.has(row.address))
      .sort((leftRow, rightRow) => leftRow.dueIn - rightRow.dueIn || leftRow.start - rightRow.start)
    for (const row of backfill) {
      if (next.size >= floor || arrived >= cap) break
      next.add(row.address)
      arrived += 1
    }
  }

  while (next.size > ceiling && left < cap) {
    const victim = seatedRows()[0]
    if (!victim) break
    next.delete(victim.address)
    left += 1
  }

  const online = [...next]
  const arrivedAddresses = online.filter((address) => !input.seated.has(address))
  const leftAddresses = [...input.seated].filter((address) => !next.has(address))
  const arrivedSet = new Set(arrivedAddresses)
  const leftSet = new Set(leftAddresses)
  const updatedClocks = clocks.map((clock) => {
    const row = byAddress.get(clock.address)
    if (arrivedSet.has(clock.address) && (!row || !row.inVisit)) {
      const drawn = drawVisit(clock.index, clock.cursor, input.hour, input.config)
      return {
        index: clock.index,
        address: clock.address,
        cursor: drawn.cursor,
        visitStart: input.now,
        visitEnd: input.now + drawn.visit,
        gapEnd: input.now + drawn.visit + drawn.gap,
      }
    }
    if (leftSet.has(clock.address) && clock.visitEnd > input.now) {
      return {
        ...clock,
        visitEnd: input.now,
      }
    }
    return clock
  })
  return { clocks: updatedClocks, online, arrived: arrivedAddresses, left: leftAddresses }
}

export function countTurnover(
  config: PresenceConfig,
  minutes: number,
  wallets = 40,
): { leaves: number; arrivals: number } {
  let clocks = Array.from({ length: wallets }, (_, index) =>
    openClock(index, index.toString(16).padStart(8, "0"), 0, 20, config),
  )
  let leaves = 0
  let arrivals = 0
  const step = 30_000
  for (let now = step; now <= minutes * 60_000; now += step) {
    for (let index = 0; index < clocks.length; index++) {
      const before = clocks[index]!
      const after = rollClock(before, now, 20, config)
      if (after.visitStart !== before.visitStart) arrivals += 1
      const wasOpen = before.visitEnd > now - step && before.visitStart < now
      const still = after.visitStart === before.visitStart && now < before.visitEnd
      if (wasOpen && !still && now >= before.visitEnd) leaves += 1
      clocks[index] = after
    }
  }
  return { leaves, arrivals }
}
