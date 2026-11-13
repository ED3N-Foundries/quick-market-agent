import { expect, test } from "bun:test"
import { treasuryEnvValue } from "./env"

test("NEAR mode reads the NEAR treasury line and leaves the Base key alone", () => {
  const env = { TREASURY_PRIVATE_KEY: "0xabc", NEAR_TREASURY_PRIVATE_KEY: "ed25519:near" }
  expect(treasuryEnvValue("near-testnet", env)).toBe("ed25519:near")
  expect(treasuryEnvValue("base-sepolia", env)).toBe("0xabc")
  expect(treasuryEnvValue("base", env)).toBe("0xabc")
})
