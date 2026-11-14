import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { runOnChain } from "../server/activeChain"
import { openSwarm, saveStakes, saveWallets, type WalletRow } from "./swarmdb"
import { ACTIVE_KEEP, activeWeekId, leanOf, loadActiveFive, pickActiveFive, type ActiveCandidate } from "./active"

function candidate(patch: Partial<ActiveCandidate> & { address: string }): ActiveCandidate {
  return {
    idx: 0,
    mind: "tape",
    tempo: 10,
    momentum: 0.5,
    trades: 0,
    volume: 0,
    lastRound: 0,
    updatedAt: 0,
    bankroll: 0,
    ...patch,
  }
}

function row(address: string, idx: number, mind: string, tempo: number): WalletRow {
  return {
    address,
    idx,
    online: 1,
    phase: "",
    bankroll: 10_000_000,
    lastSide: null,
    lastStake: null,
    lastSkip: null,
    wins: 0,
    losses: 0,
    mind,
    tempo,
    visitEnd: 0,
    enrolled: 1,
    rngA: 1,
    gateJson: "{}",
    cursor: 0,
    visitStart: 0,
    gapEnd: 0,
    handled: 0,
    wokeAt: null,
    sleptAt: null,
    updatedAt: Date.now(),
    token: null,
  }
}

test("fresh deployment ranks restless first so frequent traders fund first", () => {
  const pool = [
    candidate({ address: "safe", mind: "tape", tempo: 30, momentum: 0.4, idx: 10 }),
    candidate({ address: "active", mind: "restless", tempo: 4, momentum: -0.2, idx: 11 }),
    candidate({ address: "mid", mind: "price", tempo: 12, momentum: 0.1, idx: 12 }),
  ]
  const picked = pickActiveFive(pool, 2)
  expect(picked[0]).toBe("active")
})

test("active-five enforces opposing views with real leans", () => {
  // 5 tape bulls would leave one side empty; the 5th swaps for the best bear.
  const bulls = Array.from({ length: 6 }, (_, i) =>
    candidate({ address: `bull${i}`, mind: "tape", momentum: 0.5, trades: 10 - i, volume: 100, idx: i }),
  )
  const bear = candidate({ address: "bear", mind: "fade", momentum: -0.6, trades: 1, volume: 10, idx: 99 })
  const picked = pickActiveFive([...bulls, bear], 5)
  expect(picked).toContain("bear")
  expect(picked.length).toBe(5)
})

test("weekly pin recomputes when activity shifts", async () => {
  await runOnChain("near-testnet", async () => {
    const db = openSwarm(":memory:")
    try {
      const wallets = [
        row("aaa", 0, "tape", 10),
        row("bbb", 1, "fade", 10),
        row("ccc", 2, "restless", 4),
        row("ddd", 3, "price", 12),
        row("eee", 4, "streak", 20),
        row("fff", 5, "restless", 3),
      ]
      saveWallets(db, wallets, "near-testnet")
      const now = Date.now()
      const windowMs = 10_000
      const first = loadActiveFive(db, now, windowMs, "near-testnet", 5)
      expect(first.length).toBe(5)
      // Make fff the most active this week with 3 settled stakes.
      const round = Math.floor(now / windowMs)
      saveStakes(db, round - 1, [{ address: "fff", side: "up", stakeMicros: 5_000_000 }], "near-testnet")
      saveStakes(db, round - 2, [{ address: "fff", side: "down", stakeMicros: 5_000_000 }], "near-testnet")
      saveStakes(db, round - 3, [{ address: "fff", side: "up", stakeMicros: 5_000_000 }], "near-testnet")
      // Force recompute by faking a new week.
      const nextWeek = (activeWeekId(now) + 1) * 7 * 24 * 3_600_000 + 1_000
      const second = loadActiveFive(db, nextWeek, windowMs, "near-testnet", 5)
      expect(second).toContain("fff")
      expect(second.length).toBe(ACTIVE_KEEP)
    } finally {
      db.close()
    }
  })
})

test("lean alternates on zero momentum so fresh deploys split sides", () => {
  expect(leanOf("restless", 0, 0)).toBe(1)
  expect(leanOf("restless", 0, 1)).toBe(-1)
  expect(leanOf("tape", 0.3, 7)).toBe(1)
  expect(leanOf("fade", -0.3, 7)).toBe(-1)
})
