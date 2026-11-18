import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { isImplicitAccount } from "../shared/near"
import { generateNearSecret, seedFromSecret } from "../shared/nearKey"

export type StoredKey = {
  address: string
  privateKey: `0x${string}`
}

export type NearStoredKey = {
  account: string
  privateKey: string
}

const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/

export function growKeys(existing: StoredKey[], needed: number, cap: number): StoredKey[] {
  const keys: StoredKey[] = []
  for (const row of existing) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(row.privateKey)) continue
    // The key file already carries the wallet identity. Re-deriving every
    // address on boot spends seconds on a full 12k pass for no new information.
    if (!EVM_ADDRESS.test(row.address)) continue
    keys.push({ address: row.address, privateKey: row.privateKey })
  }
  const target = Math.min(cap, Math.max(keys.length, Math.max(0, Math.floor(needed))))
  while (keys.length < target) {
    const privateKey = generatePrivateKey()
    keys.push({ address: privateKeyToAccount(privateKey).address, privateKey })
  }
  return keys
}

/** Keep rows whose secret is a well-formed implicit key. Only new keys are derived. */
export async function growNearKeys(existing: NearStoredKey[], needed: number, cap: number): Promise<NearStoredKey[]> {
  const keys: NearStoredKey[] = []
  for (const row of existing) {
    if (!isImplicitAccount(row.account)) continue
    if (!seedFromSecret(row.privateKey)) continue
    keys.push({ account: row.account, privateKey: row.privateKey })
  }
  const target = Math.min(cap, Math.max(keys.length, Math.max(0, Math.floor(needed))))
  while (keys.length < target) {
    const made = await generateNearSecret()
    keys.push({ account: made.account, privateKey: made.secretKey })
  }
  return keys
}
