import { Database } from "bun:sqlite"
import { existsSync, mkdirSync } from "node:fs"
import { dirname, join, resolve } from "node:path"
import type { ChainKey } from "../shared/chain"
import { isNearAccountId } from "../shared/near"
import { loadEnv } from "./env"

const CHAIN_TABLES: Record<string, string> = {
  users: `CREATE TABLE IF NOT EXISTS users (
    chain_key TEXT NOT NULL,
    address TEXT NOT NULL,
    balance_micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    is_bot INTEGER NOT NULL DEFAULT 0,
    grant_at INTEGER,
    grant_pending_at INTEGER,
    grant_tx TEXT,
    PRIMARY KEY (chain_key, address)
  )`,
  rounds: `CREATE TABLE IF NOT EXISTS rounds (
    chain_key TEXT NOT NULL,
    id INTEGER NOT NULL,
    starts_at INTEGER NOT NULL,
    ends_at INTEGER NOT NULL,
    strike TEXT,
    settle TEXT,
    status TEXT NOT NULL,
    fee_micros INTEGER NOT NULL DEFAULT 0,
    winning_side TEXT,
    resolution TEXT,
    pool_up_micros INTEGER NOT NULL DEFAULT 0,
    pool_down_micros INTEGER NOT NULL DEFAULT 0,
    source TEXT,
    PRIMARY KEY (chain_key, id)
  )`,
  buy_ins: `CREATE TABLE IF NOT EXISTS buy_ins (
    chain_key TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    round_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    side TEXT NOT NULL,
    stake_micros INTEGER NOT NULL,
    payout_micros INTEGER,
    created_at INTEGER NOT NULL,
    UNIQUE(chain_key, round_id, address)
  )`,
  sessions: `CREATE TABLE IF NOT EXISTS sessions (
    chain_key TEXT NOT NULL,
    token TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  login_sigs: `CREATE TABLE IF NOT EXISTS login_sigs (
    chain_key TEXT NOT NULL,
    signature TEXT PRIMARY KEY,
    expires_at INTEGER NOT NULL
  )`,
  deposits: `CREATE TABLE IF NOT EXISTS deposits (
    chain_key TEXT NOT NULL,
    tx_hash TEXT NOT NULL,
    log_index INTEGER NOT NULL,
    address TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (chain_key, tx_hash, log_index)
  )`,
  withdrawals: `CREATE TABLE IF NOT EXISTS withdrawals (
    chain_key TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    tx_hash TEXT,
    raw_tx TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  burns: `CREATE TABLE IF NOT EXISTS burns (
    chain_key TEXT NOT NULL,
    id TEXT PRIMARY KEY,
    address TEXT NOT NULL,
    amount_micros INTEGER NOT NULL,
    tx_hash TEXT,
    raw_tx TEXT,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  wallets: `CREATE TABLE IF NOT EXISTS wallets (
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
    token TEXT,
    PRIMARY KEY (chain_key, address)
  )`,
  windows: `CREATE TABLE IF NOT EXISTS windows (
    chain_key TEXT NOT NULL,
    id INTEGER NOT NULL,
    buy_ins INTEGER,
    skips INTEGER,
    up_micros INTEGER,
    down_micros INTEGER,
    at INTEGER,
    PRIMARY KEY (chain_key, id)
  )`,
  stakes: `CREATE TABLE IF NOT EXISTS stakes (
    chain_key TEXT NOT NULL,
    round_id INTEGER NOT NULL,
    address TEXT NOT NULL,
    side TEXT NOT NULL,
    stake_micros INTEGER NOT NULL,
    PRIMARY KEY (chain_key, round_id, address)
  )`,
}

const SHARED_TABLES = `
CREATE TABLE IF NOT EXISTS ticks (
  second_ts INTEGER PRIMARY KEY,
  price TEXT NOT NULL,
  source TEXT NOT NULL,
  exchange_ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`

const SCHEMA = `${Object.values(CHAIN_TABLES).join(";\n")};\n${SHARED_TABLES}`

let database: Database | null = null

/** Connection settings only. Does not migrate or write schema. */
export function tuneDatabase(db: Database, options: { readonly?: boolean; memory?: boolean } = {}) {
  if (!options.readonly && !options.memory) db.exec("PRAGMA journal_mode = WAL;")
  db.exec("PRAGMA foreign_keys = ON;")
  db.exec("PRAGMA busy_timeout = 5000;")
  db.exec("PRAGMA synchronous = NORMAL;")
  db.exec("PRAGMA temp_store = MEMORY;")
  db.exec("PRAGMA cache_size = -20000;")
  db.exec("PRAGMA mmap_size = 268435456;")
  if (!options.readonly && !options.memory) db.exec("PRAGMA wal_autocheckpoint = 1000;")
}

function openDatabase(path: string): Database {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true })
  const db = new Database(path)
  tuneDatabase(db, { memory: path === ":memory:" })
  migrateBuyIns(db)
  db.exec(SCHEMA)
  migrateChainSchema(db)
  ensureBuyInIndexes(db)
  migrateRoundSource(db)
  ensureRoundIndexes(db)
  migrateCustody(db)
  return db
}

function tableNames(db: Database, schema = "main"): Set<string> {
  const rows = db.query(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table'`).all() as { name: string }[]
  return new Set(rows.map((row) => row.name))
}

function tableColumns(db: Database, table: string, schema = "main"): string[] {
  const rows = db.query(`PRAGMA ${schema}.table_info(${table})`).all() as { name: string }[]
  return rows.map((row) => row.name)
}

/** The ledger table was `bets`. Rename it before the schema creates `buy_ins`. */
function migrateBuyIns(db: Database) {
  const tables = tableNames(db)
  if (tables.has("bets") && !tables.has("buy_ins")) db.exec("ALTER TABLE bets RENAME TO buy_ins")
}

function legacyChain(db: Database): ChainKey {
  if (tableNames(db).has("users")) {
    const rows = db.query("SELECT address FROM users").all() as { address: string }[]
    if (rows.some((row) => !row.address.startsWith("0x") && isNearAccountId(row.address))) return "near-testnet"
  }
  if (tableNames(db).has("meta")) {
    const near = db.query("SELECT value FROM meta WHERE key = 'near_deposit_height'").get()
    if (near) return "near-testnet"
  }
  return "base-sepolia"
}

function dropTableIndexes(db: Database, table: string) {
  const indexes = db.query(`SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL`).all(table) as {
    name: string
  }[]
  for (const index of indexes) db.exec(`DROP INDEX IF EXISTS ${index.name}`)
}

function migrateChainSchema(db: Database) {
  const marked = db.query("SELECT value FROM meta WHERE key = 'chain_schema_v1'").get()
  if (marked) return
  const chain = legacyChain(db)
  const migrate = db.transaction(() => {
    for (const [table, definition] of Object.entries(CHAIN_TABLES)) {
      const columns = tableColumns(db, table)
      if (columns.includes("chain_key")) continue
      const legacy = `${table}_before_chain`
      dropTableIndexes(db, table)
      db.exec(`ALTER TABLE ${table} RENAME TO ${legacy}`)
      db.exec(definition)
      const names = columns.join(", ")
      db.query(`INSERT INTO ${table} (chain_key, ${names}) SELECT ?, ${names} FROM ${legacy}`).run(chain)
      db.exec(`DROP TABLE ${legacy}`)
    }
    for (const key of ["deposit_block", "near_deposit_height", "qm_usdc_v1"]) {
      const row = db.query("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | null
      if (row) db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)").run(`${chain}:${key}`, row.value)
    }
    db.query("INSERT INTO meta (key, value) VALUES ('chain_schema_v1', '1')").run()
  })
  migrate()
}

function indexColumns(db: Database, indexName: string): string[] {
  const rows = db.query(`PRAGMA index_info(${indexName})`).all() as { seqno: number; name: string }[]
  return [...rows].sort((a, b) => a.seqno - b.seqno).map((row) => row.name)
}

function hasIndexPrefix(db: Database, table: string, columns: string[]): boolean {
  const indexes = db.query(`PRAGMA index_list(${table})`).all() as { name: string }[]
  return indexes.some((index) => {
    const have = indexColumns(db, index.name)
    return columns.every((column, i) => have[i] === column)
  })
}

/** Create a missing buy-in index. Skip it when an existing index covers those columns. */
function ensureBuyInIndexes(db: Database) {
  const wanted: { name: string; columns: string[] }[] = [
    { name: "buy_ins_round", columns: ["chain_key", "round_id"] },
    { name: "buy_ins_round_time", columns: ["chain_key", "round_id", "created_at"] },
    { name: "buy_ins_address", columns: ["chain_key", "address"] },
  ]
  for (const index of wanted) {
    if (hasIndexPrefix(db, "buy_ins", index.columns)) continue
    db.exec(`CREATE INDEX IF NOT EXISTS ${index.name} ON buy_ins(${index.columns.join(", ")})`)
  }
}

/** Closed markets are read by start time. Round ids are not time order across a window change. */
function ensureRoundIndexes(db: Database) {
  db.exec("CREATE INDEX IF NOT EXISTS rounds_closed_starts ON rounds(chain_key, starts_at DESC) WHERE status != 'open'")
}

function migrateRoundSource(db: Database) {
  const missing = db.query("SELECT chain_key, id, starts_at, ends_at FROM rounds WHERE source IS NULL").all() as {
    chain_key: ChainKey
    id: number
    starts_at: number
    ends_at: number
  }[]
  if (missing.length === 0) return
  const pick = db.query(
    `SELECT source FROM ticks
     WHERE second_ts BETWEEN ? AND ?
     ORDER BY ABS(second_ts - ?)
     LIMIT 1`,
  )
  const write = db.query("UPDATE rounds SET source = ? WHERE chain_key = ? AND id = ? AND source IS NULL")
  const fill = db.transaction(() => {
    for (const row of missing) {
      const start = Math.floor(row.starts_at / 1000)
      const end = Math.floor(row.ends_at / 1000)
      const tick = pick.get(start - 60, end, start) as { source: string } | null
      if (tick) write.run(tick.source, row.chain_key, row.id)
    }
  })
  fill()
}

/** Demo balances were minted. Drop them once so they cannot be withdrawn as USDC. */
export function migrateCustody(db: Database) {
  const row = db.query("SELECT value FROM meta WHERE key = ?").get("custody_v1") as { value: string } | null
  if (row) return
  const tx = db.transaction(() => {
    db.exec("UPDATE users SET balance_micros = 0")
    db.exec(`DELETE FROM buy_ins WHERE EXISTS (
      SELECT 1 FROM rounds WHERE rounds.chain_key = buy_ins.chain_key AND rounds.id = buy_ins.round_id AND rounds.status = 'open'
    )`)
    db.query("INSERT INTO meta (key, value) VALUES ('custody_v1', '1')").run()
  })
  tx()
}

export function importLegacySwarm(
  db: Database,
  mainPath: string,
  legacyPath = join(process.cwd(), "agent", "swarm.sqlite"),
) {
  const done = db.query("SELECT value FROM meta WHERE key = 'agent_swarm_v1'").get()
  if (done) return
  if (!existsSync(legacyPath) || resolve(legacyPath) === resolve(mainPath)) {
    db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('agent_swarm_v1', '1')").run()
    return
  }
  const escaped = legacyPath.replace(/'/g, "''")
  db.exec(`ATTACH DATABASE '${escaped}' AS legacy_swarm`)
  try {
    const names = tableNames(db, "legacy_swarm")
    const rows = names.has("wallets")
      ? (db.query("SELECT address FROM legacy_swarm.wallets").all() as { address: string }[])
      : []
    const chain: ChainKey = rows.some((row) => !row.address.startsWith("0x") && isNearAccountId(row.address)) ? "near-testnet" : "base-sepolia"
    const copy = db.transaction(() => {
      for (const table of ["wallets", "windows", "stakes"]) {
        if (!names.has(table)) continue
        const columns = tableColumns(db, table, "legacy_swarm").filter((column) => column !== "chain_key")
        const namesSql = columns.join(", ")
        db.query(
          `INSERT OR IGNORE INTO ${table} (chain_key, ${namesSql})
           SELECT ?, ${namesSql} FROM legacy_swarm.${table}`,
        ).run(chain)
      }
      if (names.has("meta")) {
        const metaRows = db.query("SELECT key, value FROM legacy_swarm.meta").all() as { key: string; value: string }[]
        const write = db.query("INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)")
        for (const row of metaRows) write.run(`${chain}:agent:${row.key}`, row.value)
      }
      db.query("INSERT OR IGNORE INTO meta (key, value) VALUES ('agent_swarm_v1', '1')").run()
    })
    copy()
  } finally {
    db.exec("DETACH DATABASE legacy_swarm")
  }
}

export function getDb(): Database {
  if (!database) {
    const path = loadEnv().dbPath
    database = openDatabase(path)
  }
  return database
}

export function useDatabase(path: string) {
  database?.close()
  database = openDatabase(path)
}
