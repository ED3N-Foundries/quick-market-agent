import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import { dirname } from "node:path"
import type { ChainKey } from "../shared/chain"
import { activeChainKey } from "../server/activeChain"
import { tuneDatabase } from "../server/db"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS wallets (
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
);
CREATE TABLE IF NOT EXISTS windows (
  chain_key TEXT NOT NULL,
  id INTEGER NOT NULL,
  buy_ins INTEGER,
  skips INTEGER,
  up_micros INTEGER,
  down_micros INTEGER,
  at INTEGER,
  PRIMARY KEY (chain_key, id)
);
CREATE TABLE IF NOT EXISTS stakes (
  chain_key TEXT NOT NULL,
  round_id INTEGER NOT NULL,
  address TEXT NOT NULL,
  side TEXT NOT NULL,
  stake_micros INTEGER NOT NULL,
  PRIMARY KEY (chain_key, round_id, address)
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

export type WalletRow = {
  address: string
  idx: number
  online: number
  phase: string
  bankroll: number
  lastSide: string | null
  lastStake: number | null
  lastSkip: string | null
  wins: number
  losses: number
  mind: string
  tempo: number
  visitEnd: number
  enrolled: number
  rngA: number
  gateJson: string
  cursor: number
  visitStart: number
  gapEnd: number
  handled: number
  wokeAt: number | null
  sleptAt: number | null
  updatedAt: number
}

export type RosterFilter = "all" | "stuck" | "richest" | "woke" | "slept"

export function openSwarm(source: string | Database): Database {
  if (typeof source !== "string") return source
  if (source !== ":memory:") mkdirSync(dirname(source), { recursive: true })
  const db = new Database(source)
  tuneDatabase(db, { memory: source === ":memory:" })
  db.exec(SCHEMA)
  return db
}

function agentMetaKey(key: string, chainKey: ChainKey): string {
  return `${chainKey}:agent:${key}`
}

export function metaGet(db: Database, key: string, chainKey = activeChainKey()): string | null {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get(agentMetaKey(key, chainKey)) as { value: string } | null
  return row?.value ?? null
}

export function metaSet(db: Database, key: string, value: string, chainKey = activeChainKey()) {
  db.query(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(agentMetaKey(key, chainKey), value)
}

export function loadWalletMap(db: Database, chainKey = activeChainKey()): Map<string, WalletRow> {
  const rows = db.query("SELECT * FROM wallets WHERE chain_key = ?").all(chainKey) as Record<string, unknown>[]
  const map = new Map<string, WalletRow>()
  for (const row of rows) {
    const mapped = mapRow(row)
    map.set(mapped.address, mapped)
  }
  return map
}

export function saveWallets(db: Database, rows: WalletRow[], chainKey = activeChainKey()) {
  if (rows.length === 0) return
  const tx = db.transaction(() => {
    const statement = db.query(
      `INSERT INTO wallets (
         chain_key, address, idx, online, phase, bankroll, last_side, last_stake, last_skip, wins, losses,
         mind, tempo, visit_end, enrolled, rng_a, gate_json, cursor, visit_start, gap_end,
         handled, woke_at, slept_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(chain_key, address) DO UPDATE SET
         idx = excluded.idx, online = excluded.online, phase = excluded.phase, bankroll = excluded.bankroll,
         last_side = excluded.last_side, last_stake = excluded.last_stake, last_skip = excluded.last_skip,
         wins = excluded.wins, losses = excluded.losses, mind = excluded.mind, tempo = excluded.tempo,
         visit_end = excluded.visit_end, enrolled = excluded.enrolled, rng_a = excluded.rng_a,
         gate_json = excluded.gate_json, cursor = excluded.cursor, visit_start = excluded.visit_start,
         gap_end = excluded.gap_end, handled = excluded.handled, woke_at = excluded.woke_at,
         slept_at = excluded.slept_at, updated_at = excluded.updated_at`,
    )
    for (const row of rows) {
      statement.run(
        chainKey,
        row.address,
        row.idx,
        row.online,
        row.phase,
        row.bankroll,
        row.lastSide,
        row.lastStake,
        row.lastSkip,
        row.wins,
        row.losses,
        row.mind,
        row.tempo,
        row.visitEnd,
        row.enrolled,
        row.rngA,
        row.gateJson,
        row.cursor,
        row.visitStart,
        row.gapEnd,
        row.handled,
        row.wokeAt,
        row.sleptAt,
        row.updatedAt,
      )
    }
  })
  tx()
}

export function noteWindow(
  db: Database,
  row: { id: number; buyIns: number; skips: number; upMicros: number; downMicros: number; at: number },
  chainKey = activeChainKey(),
) {
  db.query(
    `INSERT INTO windows (chain_key, id, buy_ins, skips, up_micros, down_micros, at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(chain_key, id) DO UPDATE SET buy_ins = excluded.buy_ins, skips = excluded.skips, up_micros = excluded.up_micros,
       down_micros = excluded.down_micros, at = excluded.at`,
  ).run(chainKey, row.id, row.buyIns, row.skips, row.upMicros, row.downMicros, row.at)
  db.query(
    `DELETE FROM windows WHERE chain_key = ? AND id NOT IN (
       SELECT id FROM windows WHERE chain_key = ? ORDER BY id DESC LIMIT 200
     )`,
  ).run(chainKey, chainKey)
}

export function saveStakes(
  db: Database,
  roundId: number,
  stakes: { address: string; side: string; stakeMicros: number }[],
  chainKey = activeChainKey(),
) {
  const tx = db.transaction(() => {
    const statement = db.query(
      `INSERT INTO stakes (chain_key, round_id, address, side, stake_micros) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(chain_key, round_id, address) DO NOTHING`,
    )
    for (const stake of stakes) statement.run(chainKey, roundId, stake.address, stake.side, stake.stakeMicros)
  })
  tx()
}

export function stakesFor(db: Database, roundId: number, chainKey = activeChainKey()): { address: string; side: "up" | "down"; stakeMicros: number }[] {
  const rows = db.query("SELECT address, side, stake_micros FROM stakes WHERE chain_key = ? AND round_id = ?").all(chainKey, roundId) as {
    address: string
    side: string
    stake_micros: number
  }[]
  return rows.flatMap((row) =>
    row.side === "up" || row.side === "down" ? [{ address: row.address, side: row.side, stakeMicros: row.stake_micros }] : [],
  )
}

export function minStakeRoundAfter(db: Database, sinceId: number, chainKey = activeChainKey()): number | null {
  const row = db.query("SELECT MIN(round_id) AS min_id FROM stakes WHERE chain_key = ? AND round_id > ?").get(chainKey, sinceId) as {
    min_id: number | null
  }
  return row?.min_id ?? null
}

export function pruneUnenrolled(db: Database, chainKey = activeChainKey()): void {
  db.query("DELETE FROM wallets WHERE chain_key = ? AND enrolled = 0").run(chainKey)
}

export function roster(db: Database, filter: RosterFilter, offset: number, limit: number, chainKey = activeChainKey()): WalletRow[] {
  const conditions = {
    richest: "enrolled = 1",
    woke: "enrolled = 1 AND online = 1",
    slept: "enrolled = 1 AND online = 0",
    stuck: "enrolled = 1 AND online = 1 AND last_skip IN ('refractory', 'flat')",
    all: "enrolled = 1",
  }
  const order = {
    richest: "bankroll DESC, idx ASC",
    woke: "woke_at DESC, idx ASC",
    slept: "slept_at DESC, idx ASC",
    stuck: "idx ASC",
    all: "online DESC, idx ASC",
  }
  return (
    db
      .query(`SELECT * FROM wallets WHERE chain_key = ? AND ${conditions[filter]} ORDER BY ${order[filter]} LIMIT ? OFFSET ?`)
      .all(chainKey, limit, offset) as Record<string, unknown>[]
  ).map(mapRow)
}

export function rosterCount(db: Database, filter: RosterFilter, chainKey = activeChainKey()): number {
  const condition = {
    richest: "enrolled = 1",
    woke: "enrolled = 1 AND online = 1",
    slept: "enrolled = 1 AND online = 0",
    stuck: "enrolled = 1 AND online = 1 AND last_skip IN ('refractory', 'flat')",
    all: "enrolled = 1",
  }[filter]
  const row = db.query(`SELECT COUNT(*) AS n FROM wallets WHERE chain_key = ? AND ${condition}`).get(chainKey) as { n: number }
  return row.n
}

function mapRow(row: Record<string, unknown>): WalletRow {
  return {
    address: String(row.address),
    idx: Number(row.idx),
    online: Number(row.online),
    phase: String(row.phase ?? ""),
    bankroll: Number(row.bankroll),
    lastSide: row.last_side == null ? null : String(row.last_side),
    lastStake: row.last_stake == null ? null : Number(row.last_stake),
    lastSkip: row.last_skip == null ? null : String(row.last_skip),
    wins: Number(row.wins),
    losses: Number(row.losses),
    mind: String(row.mind ?? ""),
    tempo: Number(row.tempo ?? 0),
    visitEnd: Number(row.visit_end ?? 0),
    enrolled: Number(row.enrolled),
    rngA: Number(row.rng_a ?? 0),
    gateJson: String(row.gate_json ?? ""),
    cursor: Number(row.cursor ?? 0),
    visitStart: Number(row.visit_start ?? 0),
    gapEnd: Number(row.gap_end ?? 0),
    handled: Number(row.handled),
    wokeAt: row.woke_at == null ? null : Number(row.woke_at),
    sleptAt: row.slept_at == null ? null : Number(row.slept_at),
    updatedAt: Number(row.updated_at ?? 0),
  }
}
