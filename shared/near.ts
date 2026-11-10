import type { ChainKey } from "./chain"

/** 0.05 NEAR. Covers an implicit account plus one fungible-token storage deposit. */
export const AGENT_FLOOR_YOCTO = 50_000_000_000_000_000_000_000n

/** 0.5 NEAR left on the treasury after it funds agent accounts. */
export const TREASURY_RESERVE_YOCTO = 500_000_000_000_000_000_000_000n

const YOCTO = 1_000_000_000_000_000_000_000_000n
const MICROS = 1_000_000n
const EVM_ADDRESS = /^0x[0-9a-f]{40}$/
const ACCOUNT_ID = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

export type Holding = {
  exists: boolean
  nearYocto: bigint
  tokenMicros: bigint
}

export type AgentHolding = {
  account: string
  holding: Holding
}

export type SeedTransfer = {
  to: string
  yocto: bigint
}

export type SeedPlan = {
  mintMicros: bigint
  transfers: SeedTransfer[]
}

export type ShortAgent = {
  account: string
  near: string
  need: string
  missing: boolean
}

export type TreasuryReport = {
  ok: boolean
  account: string
  near: string
  nearNeed: string
  token: string
  tokenNeed: string
  treasuryReady: boolean
  agentsReady: number
  agentsTotal: number
  shortAgents: ShortAgent[]
  lines: string[]
}

export type ReportPhrases = {
  treasury: (account: string) => string
  near: (have: string, need: string) => string
  qm: (have: string, need: string) => string
  treasuryReady: string
  agentsReady: string
  agentsCount: (ready: number, total: number) => string
  agentNear: (account: string, have: string, need: string) => string
  agentMissing: (account: string) => string
}

export const englishReport: ReportPhrases = {
  treasury: (account) => `near-testnet treasury ${account}`,
  near: (have, need) => `NEAR ${have} (need ${need})`,
  qm: (have, need) => `QM ${have} (need ${need})`,
  treasuryReady: "treasury ready",
  agentsReady: "agents ready",
  agentsCount: (ready, total) => `agents ${ready}/${total}`,
  agentNear: (account, have, need) => `${account} NEAR ${have} (need ${need})`,
  agentMissing: (account) => `${account} missing`,
}

export function isNearAccountId(value: string): boolean {
  if (EVM_ADDRESS.test(value)) return false
  return value.length >= 2 && value.length <= 64 && ACCOUNT_ID.test(value)
}

export function isImplicitAccount(value: string): boolean {
  return /^[0-9a-f]{64}$/.test(value)
}

/** Whole tokens, then up to 6 decimal places, with trailing zeros removed. */
export function formatToken(units: bigint, scale: bigint, places: number): string {
  const negative = units < 0n
  const abs = negative ? -units : units
  const whole = abs / scale
  const frac = abs % scale
  if (frac === 0n) return negative ? `-${whole}` : whole.toString()
  const width = scale.toString().length - 1
  const digits = frac.toString().padStart(width, "0").slice(0, places).replace(/0+$/, "")
  const body = digits.length === 0 ? whole.toString() : `${whole}.${digits}`
  return negative ? `-${body}` : body
}

export function formatYocto(yocto: bigint): string {
  return formatToken(yocto, YOCTO, 6)
}

export function formatQm(micros: bigint): string {
  return formatToken(micros, MICROS, 6)
}

export function planSeed(input: {
  treasury: Holding
  ledgerMicros: bigint
  agents: AgentHolding[]
  agentFloorYocto?: bigint
  treasuryReserveYocto?: bigint
}): SeedPlan {
  const floor = input.agentFloorYocto ?? AGENT_FLOOR_YOCTO
  const reserve = input.treasuryReserveYocto ?? TREASURY_RESERVE_YOCTO
  const mintMicros =
    input.treasury.exists && input.treasury.nearYocto > 0n && input.ledgerMicros > input.treasury.tokenMicros
      ? input.ledgerMicros - input.treasury.tokenMicros
      : 0n
  let available = input.treasury.exists && input.treasury.nearYocto > reserve ? input.treasury.nearYocto - reserve : 0n
  const transfers: SeedTransfer[] = []
  const needy = [...input.agents].sort((left, right) => (left.account < right.account ? -1 : left.account > right.account ? 1 : 0))
  for (const agent of needy) {
    const have = agent.holding.exists ? agent.holding.nearYocto : 0n
    if (agent.holding.exists && have >= floor) continue
    const need = floor - have
    if (need <= 0n || need > available) continue
    transfers.push({ to: agent.account, yocto: need })
    available -= need
  }
  return { mintMicros, transfers }
}

export function reportLines(report: Pick<TreasuryReport, "account" | "near" | "nearNeed" | "token" | "tokenNeed" | "treasuryReady" | "agentsReady" | "agentsTotal" | "shortAgents">, phrases: ReportPhrases): string[] {
  const lines = [phrases.treasury(report.account), phrases.near(report.near, report.nearNeed), phrases.qm(report.token, report.tokenNeed)]
  if (report.treasuryReady) lines.push(phrases.treasuryReady)
  if (report.shortAgents.length === 0) lines.push(phrases.agentsReady)
  else {
    lines.push(phrases.agentsCount(report.agentsReady, report.agentsTotal))
    for (const agent of report.shortAgents) {
      lines.push(agent.missing ? phrases.agentMissing(agent.account) : phrases.agentNear(agent.account, agent.near, agent.need))
    }
  }
  return lines
}

export function describeTreasury(input: {
  account: string
  treasury: Holding
  ledgerMicros: bigint
  agents: AgentHolding[]
  agentFloorYocto?: bigint
  treasuryReserveYocto?: bigint
}): TreasuryReport {
  const floor = input.agentFloorYocto ?? AGENT_FLOOR_YOCTO
  const reserve = input.treasuryReserveYocto ?? TREASURY_RESERVE_YOCTO
  const floorLabel = formatYocto(floor)
  const shortAgents: ShortAgent[] = []
  let ready = 0
  const ordered = [...input.agents].sort((left, right) => (left.account < right.account ? -1 : left.account > right.account ? 1 : 0))
  for (const agent of ordered) {
    const have = agent.holding.exists ? agent.holding.nearYocto : 0n
    if (agent.holding.exists && have >= floor) {
      ready += 1
      continue
    }
    shortAgents.push({
      account: agent.account,
      near: formatYocto(have),
      need: floorLabel,
      missing: !agent.holding.exists,
    })
  }
  const treasuryReady = input.treasury.exists && input.treasury.nearYocto >= reserve && input.treasury.tokenMicros >= input.ledgerMicros
  const report: TreasuryReport = {
    ok: treasuryReady && shortAgents.length === 0,
    account: input.account,
    near: formatYocto(input.treasury.nearYocto),
    nearNeed: formatYocto(reserve),
    token: formatQm(input.treasury.tokenMicros),
    tokenNeed: formatQm(input.ledgerMicros),
    treasuryReady,
    agentsReady: ready,
    agentsTotal: input.agents.length,
    shortAgents,
    lines: [],
  }
  report.lines = reportLines(report, englishReport)
  return report
}

/** Legacy pre-migration safeguard. Chain-scoped databases may contain both families. */
export function ledgerChainConflict(addresses: string[], chainKey: ChainKey): "base" | "near" | null {
  if (chainKey === "near-testnet") return addresses.some((item) => EVM_ADDRESS.test(item)) ? "base" : null
  return addresses.some((item) => isNearAccountId(item)) ? "near" : null
}

export function ledgerChainMessage(conflict: "base" | "near", dbPath: string): string {
  if (conflict === "base") return `The active NEAR ledger contains unmigrated Base accounts. Restore the legacy migration before using ${dbPath}`
  return `The active Base ledger contains unmigrated NEAR accounts. Restore the legacy migration before using ${dbPath}`
}

export function requireNearToken(chainKey: ChainKey, tokenAccount: string) {
  if (chainKey !== "near-testnet") return
  if (!isNearAccountId(tokenAccount.trim())) {
    throw new Error("Set TOKEN_ACCOUNT to the quick-market contract before starting on NEAR testnet.")
  }
}
