import { Database } from "bun:sqlite"
import { expect, test } from "bun:test"
import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { tuneDatabase } from "../server/db"
import {
  loadWalletMap,
  metaGet,
  metaSet,
  metaSetMany,
  noteWindow,
  openSwarm,
  pruneStakes,
  resetWindowEpoch,
  saveCosmetics,
  saveStakes,
  saveWallets,
  stakesFor,
  type CosmeticWalletRow,
  type WalletRow,
} from "./swarmdb"

function pragma(db: Database, name: string): number {
  const row = db.query(`PRAGMA ${name}`).get() as Record<string, number>
  return Number(Object.values(row)[0])
}

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

test("a diagnostic meta batch lands in one transaction", () => {
  const db = openSwarm(":memory:")
  try {
    metaSetMany(
      db,
      [
        ["spring", "100"],
        ["velocity", "2"],
        ["settle_cursor", "9"],
        ["trace", "[1,2]"],
        ["book_join", "9"],
        ["book_at", "1000"],
        ["last_error", ""],
        ["bound", "500"],
      ],
      "base-sepolia",
    )
    for (const [key, value] of [
      ["spring", "100"],
      ["velocity", "2"],
      ["settle_cursor", "9"],
      ["trace", "[1,2]"],
      ["book_join", "9"],
      ["book_at", "1000"],
      ["last_error", ""],
      ["bound", "500"],
    ]) {
      expect(metaGet(db, key!, "base-sepolia")).toBe(value!)
    }
  } finally {
    db.close()
  }
})

test("the agent DB checkpoints the WAL every 10k pages and caps the journal at 64 MB", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-"))
  const db = openSwarm(join(dir, "swarm.sqlite"))
  try {
    expect(pragma(db, "wal_autocheckpoint")).toBe(10_000)
    expect(pragma(db, "journal_size_limit")).toBe(64 * 1024 * 1024)
  } finally {
    db.close()
  }
})

test("a handle opened with the market defaults still gets the agent tuning", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-"))
  const opened = new Database(join(dir, "swarm.sqlite"))
  tuneDatabase(opened)
  expect(pragma(opened, "wal_autocheckpoint")).toBe(1000)
  const db = openSwarm(opened)
  try {
    expect(pragma(db, "wal_autocheckpoint")).toBe(10_000)
    expect(pragma(db, "journal_size_limit")).toBe(64 * 1024 * 1024)
  } finally {
    db.close()
  }
})

test("tuneDatabase defaults keep the market settings and memory DBs skip WAL", () => {
  const dir = mkdtempSync(join(tmpdir(), "swarm-"))
  const file = new Database(join(dir, "swarm.sqlite"))
  try {
    tuneDatabase(file)
    expect((file.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("wal")
    expect(pragma(file, "wal_autocheckpoint")).toBe(1000)
    expect(pragma(file, "journal_size_limit")).toBe(-1)
  } finally {
    file.close()
  }
  const memory = new Database(":memory:")
  try {
    tuneDatabase(memory, { memory: true })
    expect((memory.query("PRAGMA journal_mode").get() as { journal_mode: string }).journal_mode).toBe("memory")
  } finally {
    memory.close()
  }
})

function cosmetic(address: string, online: number, lastSkip: string | null): CosmeticWalletRow {
  return {
    address,
    online,
    lastSkip,
    rngA: 7,
    gateJson: '{"rngA":7}',
    cursor: 11,
    visitStart: 10,
    visitEnd: 20,
    gapEnd: 30,
    wokeAt: 99,
    sleptAt: null,
    updatedAt: 100,
  }
}

test("cosmetic persistence updates only the cosmetic columns and never inserts", () => {
  const db = openSwarm(":memory:")
  try {
    saveWallets(db, [wallet("0xabc", 100)], "base-sepolia")
    saveCosmetics(db, [cosmetic("0xabc", 0, "flat")], "base-sepolia")
    const row = loadWalletMap(db, "base-sepolia").get("0xabc")
    expect(row?.online).toBe(0)
    expect(row?.lastSkip).toBe("flat")
    expect(row?.gateJson).toBe('{"rngA":7}')
    expect(row?.cursor).toBe(11)
    expect(row?.wokeAt).toBe(99)
    // Critical columns never pass through the cosmetic path.
    expect(row?.bankroll).toBe(100)
    expect(row?.enrolled).toBe(1)
    expect(row?.handled).toBe(0)

    // A cosmetic row for a wallet with no stored row is a no-op, not an insert.
    saveCosmetics(db, [cosmetic("0xghost", 1, "waiting")], "base-sepolia")
    expect(loadWalletMap(db, "base-sepolia").get("0xghost")).toBeUndefined()

    // The critical full-row write still carries the cosmetic columns with it.
    const saved = wallet("0xabc", 250)
    saveWallets(db, [saved], "base-sepolia")
    expect(loadWalletMap(db, "base-sepolia").get("0xabc")?.bankroll).toBe(250)
  } finally {
    db.close()
  }
})
