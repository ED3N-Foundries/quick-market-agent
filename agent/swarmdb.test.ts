import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadWalletMap,
  metaGet,
  metaSet,
  noteWindow,
  openSwarm,
  pruneStakes,
  resetWindowEpoch,
  saveStakes,
  saveWallets,
  stakesFor,
  type WalletRow,
} from "./swarmdb"

function wallet(address: string, bankroll: number): WalletRow {
  return {
    address,
    idx: 1,
    online: 1,
    phase: "",
    bankroll,
    lastSide: null,
    lastStake: null,
    lastSkip: null,
    wins: 0,
    losses: 0,
    mind: "tape",
    tempo: 10,
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
    updatedAt: 1,
    token: null,
  }
}

test("agent wallets, stakes, and cursors are chain-scoped in one database", () => {
  const db = openSwarm(":memory:")
  try {
    saveWallets(db, [wallet("0xabc", 100)], "base-sepolia")
    saveWallets(db, [wallet("near.testnet", 200)], "near-testnet")
    saveStakes(db, 7, [{ address: "0xabc", side: "up", stakeMicros: 10 }], "base-sepolia")
    saveStakes(db, 7, [{ address: "near.testnet", side: "down", stakeMicros: 20 }], "near-testnet")
    metaSet(db, "settle_cursor", "7", "base-sepolia")
    metaSet(db, "settle_cursor", "9", "near-testnet")

    expect(loadWalletMap(db, "base-sepolia").get("0xabc")?.bankroll).toBe(100)
    expect(loadWalletMap(db, "near-testnet").get("near.testnet")?.bankroll).toBe(200)
    expect(stakesFor(db, 7, "base-sepolia")).toEqual([{ address: "0xabc", side: "up", stakeMicros: 10 }])
    expect(stakesFor(db, 7, "near-testnet")).toEqual([{ address: "near.testnet", side: "down", stakeMicros: 20 }])
    expect(metaGet(db, "settle_cursor", "base-sepolia")).toBe("7")
    expect(metaGet(db, "settle_cursor", "near-testnet")).toBe("9")
    const saved = wallet("0xabc", 100)
    saved.token = "abc"
    saveWallets(db, [saved], "base-sepolia")
    expect(loadWalletMap(db, "base-sepolia").get("0xabc")?.token).toBe("abc")
  } finally {
    db.close()
  }
})

test("rolling cleanup drops old stakes and an epoch reset clears the round tables", () => {
  const db = openSwarm(":memory:")
  try {
    saveStakes(db, 10, [{ address: "old", side: "up", stakeMicros: 10 }], "base-sepolia")
    saveStakes(db, 100, [{ address: "new", side: "down", stakeMicros: 20 }], "base-sepolia")
    pruneStakes(db, 50, "base-sepolia")
    expect(stakesFor(db, 10, "base-sepolia")).toEqual([])
    expect(stakesFor(db, 100, "base-sepolia")).toHaveLength(1)

    for (let index = 0; index < 200; index++) {
      noteWindow(
        db,
        { id: 1_000 + index, buyIns: 0, skips: 0, upMicros: 0, downMicros: 0, at: 1_000 + index },
        "base-sepolia",
      )
    }
    // A window-length change moves ids backwards. Wall time, not id, keeps the new row.
    noteWindow(db, { id: 5, buyIns: 1, skips: 0, upMicros: 0, downMicros: 0, at: 999_999 }, "base-sepolia")
    const kept = db.query("SELECT id FROM windows WHERE chain_key = ? ORDER BY at DESC LIMIT 1").get("base-sepolia") as {
      id: number
    }
    expect(kept.id).toBe(5)
    expect((db.query("SELECT COUNT(*) AS n FROM windows WHERE chain_key = ?").get("base-sepolia") as { n: number }).n).toBe(200)

    resetWindowEpoch(db, "base-sepolia")
    expect(stakesFor(db, 100, "base-sepolia")).toEqual([])
    expect((db.query("SELECT COUNT(*) AS n FROM windows WHERE chain_key = ?").get("base-sepolia") as { n: number }).n).toBe(0)
  } finally {
    db.close()
  }
})

test("opening an older swarm database adds the session token column", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-"))
  const path = join(dir, "swarm.sqlite")
  const created = new Database(path)
  created.exec(`CREATE TABLE wallets (
    chain_key TEXT NOT NULL,
    address TEXT NOT NULL,
    idx INTEGER NOT NULL,
    online INTEGER NOT NULL,
    phase TEXT,
    bankroll INTEGER NOT NULL,
    last_side TEXT,
    last_stake INTEGER,
    last_skip TEXT,
    wins INTEGER NOT NULL,
    losses INTEGER NOT NULL,
    mind TEXT,
    tempo INTEGER,
    visit_end INTEGER,
    enrolled INTEGER NOT NULL,
    rng_a INTEGER,
    gate_json TEXT,
    cursor INTEGER,
    visit_start INTEGER,
    gap_end INTEGER,
    handled INTEGER NOT NULL DEFAULT 0,
    woke_at INTEGER,
    slept_at INTEGER,
    updated_at INTEGER,
    PRIMARY KEY (chain_key, address)
  )`)
  created.exec(`INSERT INTO wallets (
    chain_key, address, idx, online, bankroll, wins, losses, enrolled, handled, updated_at
  ) VALUES ('base-sepolia', '0xabc', 1, 1, 42, 0, 0, 1, 0, 1)`)
  created.close()
  const db = openSwarm(path)
  try {
    expect(loadWalletMap(db, "base-sepolia").get("0xabc")).toMatchObject({ bankroll: 42, token: null })
  } finally {
    db.close()
  }
})
