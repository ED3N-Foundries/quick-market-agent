import type { ChainKey } from "../shared/chain"
import { marketPreferences } from "../shared/market"

export function activeChainKey(): ChainKey {
  return marketPreferences.chain
}
