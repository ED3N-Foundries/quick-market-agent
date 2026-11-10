import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { isImplicitAccount } from "../shared/near"
import { accountFromSecret, generateNearSecret } from "../shared/nearKey"

export type StoredKey = {
  address: string
  privateKey: `0x${string}`
}

export type NearStoredKey = {
  account: string
  privateKey: string
}

export function growKeys(existing: StoredKey[], needed: number, cap: number): StoredKey[] {
  const keys: StoredKey[] = []
  for (const row of existing) {
    if (!/^0x[0-9a-fA-F]{64}$/.test(row.privateKey)) continue
    const account = privateKeyToAccount(row.privateKey)
    keys.push({ address: account.address, privateKey: row.privateKey })
  }
  const target = Math.min(cap, Math.max(keys.length, Math.max(0, Math.floor(needed))))
  while (keys.length < target) {
    const privateKey = generatePrivateKey()
    keys.push({ address: privateKeyToAccount(privateKey).address, privateKey })
  }
  return keys
}

/** Keep rows whose secret matches the implicit account, then generate ed25519 keys up to the cap. */
export async function growNearKeys(existing: NearStoredKey[], needed: number, cap: number): Promise<NearStoredKey[]> {
  const keys: NearStoredKey[] = []
  for (const row of existing) {
    if (!isImplicitAccount(row.account)) continue
    const derived = await accountFromSecret(row.privateKey)
    if (derived !== row.account) continue
    keys.push({ account: row.account, privateKey: row.privateKey })
  }
  const target = Math.min(cap, Math.max(keys.length, Math.max(0, Math.floor(needed))))
  while (keys.length < target) {
    const made = await generateNearSecret()
    keys.push({ account: made.account, privateKey: made.secretKey })
  }
  return keys
}
