import type { Database } from "bun:sqlite"
import type { ChainKey } from "../shared/chain"
import { activeChainKey } from "../server/activeChain"
import { personaFor } from "./persona"
import { swarmConfig } from "./config"
import { loadWalletMap, metaGet, metaSet, weeklyTradeStats } from "./swarmdb"

export const ACTIVE_KEEP = 5
export const ACTIVE_WEEK_MS = 7 * 24 * 3_600_000

export function activeWeekId(now: number): number {
  return Math.floor(now / ACTIVE_WEEK_MS)
}

export type ActiveCandidate = {
  address: string
  idx: number
  mind: string
  tempo: number
  momentum: number
  trades: number
  volume: number
  lastRound: number
  updatedAt: number
  bankroll: number
}

/** Real-strategy lean: momentum sign. Tape is +abs, fade is -abs by construction. */
export function leanOf(mind: string, momentum: number, idx: number): 1 | -1 | 0 {
  if (Number.isFinite(momentum) && momentum !== 0) return momentum > 0 ? 1 : -1
  if (mind === "tape") return 1
  if (mind === "fade") return -1
  // restless/price/streak with zero momentum: alternate by idx so a fresh
  // deployment still starts split across sides instead of herding one way.
  return idx % 2 === 0 ? 1 : -1
}

function compareCandidates(left: ActiveCandidate, right: ActiveCandidate): number {
  if (left.trades !== right.trades) return right.trades - left.trades
  if (left.volume !== right.volume) return right.volume - left.volume
  if (left.lastRound !== right.lastRound) return right.lastRound - left.lastRound
  if (left.updatedAt !== right.updatedAt) return right.updatedAt - left.updatedAt
  const leftRestless = left.mind === "restless" ? 0 : 1
  const rightRestless = right.mind === "restless" ? 0 : 1
  if (leftRestless !== rightRestless) return leftRestless - rightRestless
  if (left.tempo !== right.tempo) return left.tempo - right.tempo
  if (left.bankroll !== right.bankroll) return right.bankroll - left.bankroll
  return left.idx - right.idx
}

/**
 * Top-5 most-active with opposing views. Sorts by weekly trades, then
 * enforces at least 2 positive + 2 negative lean so one side is never empty.
 * Swaps the lowest-ranked majority wallet for the best opposite-lean wallet
 * outside the cut — both are still real active traders, no forced sides.
 */
export function pickActiveFive(candidates: ActiveCandidate[], keep = ACTIVE_KEEP): string[] {
  if (candidates.length === 0 || keep <= 0) return []
  const ranked = [...candidates].sort(compareCandidates)
  const top = ranked.slice(0, keep)
  const needEachSide = keep >= 4 ? 2 : 1
  const leans = top.map((item) => leanOf(item.mind, item.momentum, item.idx))
  const longs = leans.filter((lean) => lean >= 0).length
  const shorts = leans.filter((lean) => lean < 0).length
  if (longs >= needEachSide && shorts >= needEachSide) return top.map((item) => item.address)
  const majorityLong = longs > shorts
  // Lowest-ranked majority wallet is the swap-out candidate.
  let swapOut = -1
  for (let index = top.length - 1; index >= 0; index--) {
    const lean = leans[index]!
    if (majorityLong ? lean >= 0 : lean < 0) {
      swapOut = index
      break
    }
  }
  // Best-ranked opposite-lean wallet outside the cut is the swap-in.
  const swapIn = ranked.slice(keep).find((item) => {
    const lean = leanOf(item.mind, item.momentum, item.idx)
    return majorityLong ? lean < 0 : lean >= 0
  })
  if (swapOut >= 0 && swapIn) top[swapOut] = swapIn
  return top.map((item) => item.address)
}

export type ActiveFiveState = { week: number; addresses: string[]; at: number }

export function readActiveFive(db: Database, chainKey = activeChainKey()): ActiveFiveState | null {
  try {
    const raw = metaGet(db, "active_five", chainKey)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<ActiveFiveState>
    if (typeof parsed.week !== "number" || !Array.isArray(parsed.addresses)) return null
    return { week: parsed.week, addresses: parsed.addresses.filter((item): item is string => typeof item === "string").slice(0, 24), at: typeof parsed.at === "number" ? parsed.at : 0 }
  } catch {
    return null
  }
}

function candidatesFromDb(db: Database, chainKey: ChainKey, now: number, windowMsValue: number): ActiveCandidate[] {
  const wallets = [...loadWalletMap(db, chainKey).values()].filter((row) => row.enrolled === 1)
  // Fall back to unenrolled wallets on a fresh deployment so restless get
  // funded first even before anything is enrolled.
  const pool = wallets.length > 0 ? wallets : [...loadWalletMap(db, chainKey).values()]
  const minRound = Math.floor((now - ACTIVE_WEEK_MS) / Math.max(1, windowMsValue))
  const stats = weeklyTradeStats(db, minRound, chainKey)
  return pool.map((row) => {
    const stat = stats.get(row.address)
    let momentum = 0
    let mind = row.mind
    try {
      const persona = personaFor(row.idx, swarmConfig.persona)
      momentum = persona.momentum
      if (!mind) mind = persona.mind
    } catch {
      // keep DB mind on config errors
    }
    return {
      address: row.address,
      idx: row.idx,
      mind,
      tempo: row.tempo || 36,
      momentum,
      trades: stat?.trades ?? 0,
      volume: stat?.volume ?? 0,
      lastRound: stat?.lastRound ?? 0,
      updatedAt: row.updatedAt ?? 0,
      bankroll: row.bankroll ?? 0,
    }
  })
}

/**
 * Weekly dynamic pin. Recomputes when the week rolls over or the cache is
 * empty; otherwise returns the stored addresses. Persisted per chain in meta.
 */
export function loadActiveFive(db: Database, now: number, windowMsValue: number, chainKey = activeChainKey(), keep = ACTIVE_KEEP): string[] {
  const week = activeWeekId(now)
  const cached = readActiveFive(db, chainKey)
  if (cached && cached.week === week && cached.addresses.length > 0) return cached.addresses.slice(0, keep)
  const picked = pickActiveFive(candidatesFromDb(db, chainKey, now, windowMsValue), keep)
  // Fresh DB with no wallets yet: no addresses to pin; caller falls back to
  // restless-first ordering for the first grants.
  if (picked.length > 0) {
    metaSet(db, "active_five", JSON.stringify({ week, addresses: picked, at: now } satisfies ActiveFiveState), chainKey)
  }
  return picked
}

/** Test hook: force a specific active-five without waiting a week. */
export function writeActiveFiveForTest(db: Database, state: ActiveFiveState, chainKey = activeChainKey()): void {
  metaSet(db, "active_five", JSON.stringify(state), chainKey)
}
