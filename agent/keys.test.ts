import { expect, test } from "bun:test"
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts"
import { generateNearSecret } from "../shared/nearKey"
import { growKeys, growNearKeys } from "./keys"

test("the key file's stored EVM address is trusted instead of re-derived", () => {
  const privateKey = generatePrivateKey()
  const other = privateKeyToAccount(generatePrivateKey()).address.toLowerCase()
  const stored = [{ address: other, privateKey }]
  // Re-deriving would replace `other` with the key's real address.
  expect(growKeys(stored, 1, 100)).toEqual(stored)
})

test("the key file's stored NEAR account is trusted instead of re-derived", async () => {
  const one = await generateNearSecret()
  const two = await generateNearSecret()
  const stored = [{ account: one.account, privateKey: two.secretKey }]
  // Re-deriving would replace `one.account` with two.account.
  expect(await growNearKeys(stored, 1, 100)).toEqual(stored)
})

test("malformed key rows are dropped and missing keys are generated", async () => {
  expect(growKeys([{ address: "0x0", privateKey: "0x123" }], 0, 100)).toEqual([])
  const evm = growKeys([], 2, 10)
  expect(evm).toHaveLength(2)
  expect(evm.every((row) => /^0x[0-9a-fA-F]{40}$/.test(row.address))).toBe(true)
  const near = await growNearKeys([{ account: "not an implicit account", privateKey: "ed25519:bad" }], 1, 10)
  expect(near).toHaveLength(1)
  expect(near[0]!.account).toMatch(/^[0-9a-f]{64}$/)
})
