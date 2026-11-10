import type { ChainKey } from "../shared/chain"
import { marketPreferences } from "../shared/market"
import { isNearAccountId } from "../shared/near"

export function parseMicros(input: unknown): number | null {
  if (typeof input !== "string") return null
  const s = input.trim()
  if (!/^\d+(\.\d{1,6})?$/.test(s)) return null
  const [whole, frac = ""] = s.split(".")
  const micros = Number(whole) * 1_000_000 + Number(frac.padEnd(6, "0"))
  if (!Number.isSafeInteger(micros)) return null
  return micros
}

export function normalizeAddress(input: unknown): string | null {
  if (typeof input !== "string") return null
  const address = input.trim().toLowerCase()
  if (!/^0x[0-9a-f]{40}$/.test(address)) return null
  return address
}

/** EVM addresses stay `0x` + 40 hex. NEAR account ids are accepted only on a NEAR launch. */
export function normalizeAccount(input: unknown, chainKey: ChainKey = marketPreferences.chain): string | null {
  if (chainKey !== "near-testnet") return normalizeAddress(input)
  if (typeof input !== "string") return null
  const account = input.trim()
  return isNearAccountId(account) ? account : null
}

export function comparePrice(a: string, b: string): number {
  const parse = (value: string) => {
    if (!/^\d+(\.\d+)?$/.test(value)) throw new Error("bad price")
    const [whole, frac = ""] = value.split(".")
    return { whole, frac }
  }
  const left = parse(a)
  const right = parse(b)
  const scale = Math.max(left.frac.length, right.frac.length)
  const av = BigInt(left.whole + left.frac.padEnd(scale, "0"))
  const bv = BigInt(right.whole + right.frac.padEnd(scale, "0"))
  return av < bv ? -1 : av > bv ? 1 : 0
}
