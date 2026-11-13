export type AgentSplit = {
  base: number
  near: number
}

export type SplitChain = "base-sepolia" | "near-testnet"

function blank(value: unknown): boolean {
  return value === undefined || value === null || (typeof value === "string" && value.trim() === "")
}

function whole(value: unknown): number | null {
  if (typeof value === "number" && Number.isInteger(value)) return value
  if (typeof value !== "string" || !/^\d+$/.test(value.trim())) return null
  return Number(value.trim())
}

/** Unset lines mean the whole swarm stays on Base. A share of 0 turns that market's runner off. Any explicit line must be a whole number, and the two shares must sum to 100. */
export function parseAgentSplit(baseValue: unknown, nearValue: unknown): AgentSplit {
  if (blank(baseValue) && blank(nearValue)) return { base: 100, near: 0 }
  const base = whole(baseValue)
  const near = whole(nearValue)
  if (base === null || near === null || base + near !== 100) {
    throw new Error("AGENT_SPLIT_BASE and AGENT_SPLIT_NEAR must be whole numbers that sum to 100.")
  }
  return { base, near }
}

/** Wallet index modulo 100. Shares of 100 and 0 put every wallet on Base. */
export function assignMarket(index: number, split: AgentSplit): SplitChain {
  const slot = ((Math.trunc(index) % 100) + 100) % 100
  return slot < split.base ? "base-sepolia" : "near-testnet"
}

export function agentMarketAllowed(chain: string, split: AgentSplit): boolean {
  if (chain === "near-testnet") return split.near > 0
  if (chain === "base-sepolia") return split.base > 0
  return false
}
