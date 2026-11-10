import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { activeChainKey } from "./activeChain"
import { configuredChain, loadEnv } from "./env"
import { describeTreasury, isImplicitAccount, type AgentHolding, type Holding, type TreasuryReport } from "../shared/near"

/** A missing key or invalid NEAR token stops the process before it listens. */
export class NearConfigError extends Error {}

const KEYS_PATH = join(process.cwd(), "agent", "keys.near.json")

export function nearRpcUrl(): string {
  return loadEnv().rpcUrl || configuredChain().rpc
}

async function rpc(method: string, params: unknown): Promise<unknown> {
  const response = await fetch(nearRpcUrl(), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "quick-market-agent", method, params }),
  })
  if (!response.ok) throw new Error(`NEAR RPC returned ${response.status}`)
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } }
  if (body.error) throw new Error(body.error.message ?? "NEAR RPC failed")
  return body.result
}

function missingAccount(error: unknown): boolean {
  const message = error instanceof Error ? error.message.toLowerCase() : ""
  return message.includes("does not exist") || message.includes("unknown account") || message.includes("access key")
}

export async function readNearBalance(account: string): Promise<{ exists: boolean; yocto: bigint }> {
  try {
    const result = (await rpc("query", {
      request_type: "view_account",
      finality: "final",
      account_id: account,
    })) as { amount?: string }
    return { exists: true, yocto: BigInt(result.amount ?? "0") }
  } catch (error) {
    if (missingAccount(error)) return { exists: false, yocto: 0n }
    throw error
  }
}

async function viewCall(contract: string, method: string, args: unknown): Promise<unknown> {
  const result = (await rpc("query", {
    request_type: "call_function",
    finality: "final",
    account_id: contract,
    method_name: method,
    args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
  })) as { result?: number[] }
  const text = new TextDecoder().decode(Uint8Array.from(result.result ?? []))
  return text ? JSON.parse(text) : null
}

export async function readTokenBalance(contract: string, account: string): Promise<bigint> {
  try {
    const balance = await viewCall(contract, "ft_balance_of", { account_id: account })
    if (typeof balance !== "string" || !/^\d+$/.test(balance)) return 0n
    return BigInt(balance)
  } catch (error) {
    if (missingAccount(error)) return 0n
    throw error
  }
}

export async function readTokenMetadata(contract: string): Promise<{ symbol: string; decimals: number }> {
  const meta = (await viewCall(contract, "ft_metadata", {})) as { symbol?: unknown; decimals?: unknown }
  return {
    symbol: typeof meta.symbol === "string" ? meta.symbol : "",
    decimals: typeof meta.decimals === "number" ? meta.decimals : -1,
  }
}

export function assertQmMetadata(meta: { symbol: string; decimals: number }) {
  if (meta.symbol !== "QM" || meta.decimals !== 6) {
    throw new NearConfigError("TOKEN_ACCOUNT must be quick-market QM with 6 decimals.")
  }
}

export function nearAgentAccounts(keysPath = KEYS_PATH): string[] {
  if (!existsSync(keysPath)) return []
  try {
    const parsed = JSON.parse(readFileSync(keysPath, "utf8")) as unknown
    if (!Array.isArray(parsed)) return []
    const accounts: string[] = []
    for (const row of parsed) {
      if (!row || typeof row !== "object") continue
      const account = (row as { account?: unknown }).account
      if (typeof account === "string" && isImplicitAccount(account)) accounts.push(account)
    }
    return accounts
  } catch {
    return []
  }
}

async function holding(account: string, token: string, withToken: boolean): Promise<Holding> {
  const balance = await readNearBalance(account)
  const tokenMicros = withToken && balance.exists ? await readTokenBalance(token, account) : 0n
  return { exists: balance.exists, nearYocto: balance.yocto, tokenMicros }
}

export async function collectHoldings(treasury: string, agents: string[]): Promise<{ treasury: Holding; agents: AgentHolding[] }> {
  const token = loadEnv().tokenAccount.trim()
  const treasuryHolding = await holding(treasury, token, true)
  const rows: AgentHolding[] = []
  for (const account of agents) {
    const balance = await readNearBalance(account)
    rows.push({ account, holding: { exists: balance.exists, nearYocto: balance.yocto, tokenMicros: 0n } })
  }
  return { treasury: treasuryHolding, agents: rows }
}

/**
 * Read-only treasury check for the runner. The ledger sum lives in the
 * server database, which this repo does not open, so it reports 0 here.
 * Funding decisions only use NEAR balances, so behavior is unchanged.
 */
export async function inspectNear(treasury: string): Promise<TreasuryReport> {
  void activeChainKey()
  const agents = nearAgentAccounts()
  try {
    const read = await collectHoldings(treasury, agents)
    const report = describeTreasury({ account: treasury, treasury: read.treasury, ledgerMicros: 0n, agents: read.agents })
    return report
  } catch (error) {
    const line = error instanceof Error ? error.message : "NEAR check failed"
    const report = describeTreasury({
      account: treasury,
      treasury: { exists: false, nearYocto: 0n, tokenMicros: 0n },
      ledgerMicros: 0n,
      agents: agents.map((account) => ({ account, holding: { exists: false, nearYocto: 0n, tokenMicros: 0n } })),
    })
    report.ok = false
    report.lines = [line, ...report.lines]
    return report
  }
}

export function fundedAgents(report: TreasuryReport): Set<string> {
  const short = new Set(report.shortAgents.map((agent) => agent.account))
  return new Set(nearAgentAccounts().filter((account) => !short.has(account)))
}
