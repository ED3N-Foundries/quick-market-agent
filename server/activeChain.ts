import { AsyncLocalStorage } from "node:async_hooks"
import type { ChainKey } from "../shared/chain"
import { marketPreferences } from "../shared/market"

const current = new AsyncLocalStorage<ChainKey>()

/** The chain this call is trading. Outside a lane, that is the process CHAIN. */
export function activeChainKey(): ChainKey {
  return current.getStore() ?? marketPreferences.chain
}

export function runOnChain<T>(chain: ChainKey, fn: () => T): T {
  return current.run(chain, fn)
}
