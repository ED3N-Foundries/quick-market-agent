/** Blocks a grant mint must sit before the ledger is credited. One confirmation on both chains. */
export const MINT_CONFIRMATIONS = 1

/**
 * How long a mint may wait for those blocks.
 * One Base slot is about two seconds. This stays open across a slow receipt
 * instead of giving up while the transaction is still confirming.
 */
export const MINT_RECEIPT_TIMEOUT_MS = 45_000

/** Client follow is a little longer than the receipt wait, so a late credit is still seen. */
export const GRANT_FOLLOW_MS = MINT_RECEIPT_TIMEOUT_MS + 5_000

export function mintReceiptWait(hash: `0x${string}`) {
  return {
    hash,
    confirmations: MINT_CONFIRMATIONS,
    timeout: MINT_RECEIPT_TIMEOUT_MS,
    pollingInterval: 1_000,
  }
}
