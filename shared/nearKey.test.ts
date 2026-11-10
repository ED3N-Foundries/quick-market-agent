import { expect, test } from "bun:test"
import { nearBotEnrollMessage, nearLoginMessage } from "./login"
import {
  NEP413_RECIPIENT,
  accountFromSecret,
  generateNearSecret,
  nep413Bytes,
  signNearMessage,
  verifyNep413,
  verifyNearMessage,
} from "./nearKey"
import * as ed from "@noble/ed25519"

test("an agent signature matches the implicit account", async () => {
  const made = await generateNearSecret()
  const account = await accountFromSecret(made.secretKey)
  expect(account).toBe(made.account)
  const message = nearBotEnrollMessage(made.account, 1_700_000_000_000, 8_000_000)
  const signature = await signNearMessage(message, made.secretKey)
  expect(signature).not.toBeNull()
  expect(await verifyNearMessage(message, made.account, signature!)).toBe(true)
  expect(await verifyNearMessage(message, "ab".repeat(32), signature!)).toBe(false)
  expect(nearLoginMessage(made.account, 5)).toBe(`quick-market\nchain: near-testnet\naccount: ${made.account}\nissued: 5`)
})

test("a NEP-413 signature round-trips for an implicit account", async () => {
  const made = await generateNearSecret()
  const message = nearLoginMessage(made.account, 9)
  const nonce = new Uint8Array(32)
  nonce[0] = 7
  const bytes = nep413Bytes(message, nonce, NEP413_RECIPIENT)
  const seed = (await import("bs58")).default.decode(made.secretKey.slice("ed25519:".length)).slice(0, 32)
  const signature = Buffer.from(await ed.signAsync(bytes, seed)).toString("hex")
  const publicKey = `ed25519:${(await import("bs58")).default.encode(Buffer.from(made.account, "hex"))}`
  expect(
    await verifyNep413({
      message,
      account: made.account,
      publicKey,
      signature,
      nonce,
      recipient: NEP413_RECIPIENT,
    }),
  ).toBe(true)
  expect(
    await verifyNep413({
      message,
      account: "cd".repeat(32),
      publicKey,
      signature,
      nonce,
      recipient: NEP413_RECIPIENT,
    }),
  ).toBe(false)
})
