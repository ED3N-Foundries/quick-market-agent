import { expect, test } from "bun:test"
import { bankAction } from "./bank"
import { USDC, swarmConfig } from "./config"

const bank = swarmConfig.bank

test("$1,200 burns into the profit pocket, $2 refills, and $40 sits still", () => {
  const burned = bankAction(1_200 * USDC, 3, bank, false)
  expect(burned.kind).toBe("burn")
  if (burned.kind === "burn") {
    expect(burned.pocketMicros).toBeGreaterThanOrEqual(bank.burnMinMicros)
    expect(burned.pocketMicros).toBeLessThanOrEqual(bank.burnMaxMicros)
    expect(1_200 * USDC - burned.amountMicros).toBe(burned.pocketMicros)
  }
  const refilled = bankAction(2 * USDC, 3, bank, false)
  expect(refilled.kind).toBe("mint")
  if (refilled.kind === "mint") {
    expect(refilled.pocketMicros).toBeGreaterThanOrEqual(bank.refillMinMicros)
    expect(refilled.pocketMicros).toBeLessThanOrEqual(bank.refillMaxMicros)
  }
  expect(bankAction(40 * USDC, 3, bank, false)).toEqual({ kind: "none" })
  expect(bankAction(2 * USDC, 3, bank, true)).toEqual({ kind: "none" })
})
