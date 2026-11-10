import { expect, test } from "bun:test"
import { GRANT_FOLLOW_MS, MINT_CONFIRMATIONS, MINT_RECEIPT_TIMEOUT_MS, mintReceiptWait } from "./mint"

test("a grant mint waits on three blocks past a single slot", () => {
  expect(MINT_CONFIRMATIONS).toBe(3)
  expect(MINT_RECEIPT_TIMEOUT_MS).toBe(45_000)
  expect(GRANT_FOLLOW_MS).toBeGreaterThan(MINT_RECEIPT_TIMEOUT_MS)
  const hash = `0x${"ab".repeat(32)}` as `0x${string}`
  expect(mintReceiptWait(hash)).toEqual({
    hash,
    confirmations: 3,
    timeout: 45_000,
    pollingInterval: 1_000,
  })
})
