import { expect, test } from "bun:test"
import { CHAINS, CIRCLE_SEPOLIA_USDC, chainFromEnv, moneyLabel, requireSepoliaToken, tokenKind, tokenLabel } from "./chain"

const quick = "0x1111111111111111111111111111111111111111"

test("Base ignores USDC_ADDRESS and Sepolia keeps Circle until an override is set", () => {
  expect(chainFromEnv("base", quick).usdc).toBe(CHAINS.base.usdc)
  expect(chainFromEnv("base-sepolia").usdc).toBe(CIRCLE_SEPOLIA_USDC)
  expect(chainFromEnv("base-sepolia", ` ${quick} `).usdc).toBe(quick)
  expect(moneyLabel(chainFromEnv("base"))).toBe("Circle USDC")
  expect(moneyLabel(chainFromEnv("base-sepolia", quick))).toBe("quick-market USDC")
  expect(tokenKind(chainFromEnv("base"))).toBe("circle")
  expect(tokenLabel(chainFromEnv("base"))).toBe("USDC")
  expect(tokenKind(chainFromEnv("base-sepolia", quick))).toBe("qm")
  expect(tokenLabel(chainFromEnv("base-sepolia", quick))).toBe("QM USDC")
  expect(chainFromEnv("near-testnet", quick).usdc).toBe(CHAINS["near-testnet"].usdc)
  expect(chainFromEnv("near-testnet").family).toBe("near")
  expect(chainFromEnv("near-testnet").gasToken).toBe("NEAR")
  expect(tokenLabel(chainFromEnv("near-testnet"))).toBe("QM")
  expect(moneyLabel(chainFromEnv("near-testnet"))).toBe("quick-market")
  expect(() => chainFromEnv("nope")).toThrow("near-testnet")
})

test("Sepolia refuses Circle and a bad USDC_ADDRESS, and the server refuses to start on Circle", () => {
  expect(() => chainFromEnv("base-sepolia", CIRCLE_SEPOLIA_USDC)).toThrow("not Circle USDC")
  expect(() => chainFromEnv("base-sepolia", "0x1234")).toThrow("20-byte")
  expect(() => requireSepoliaToken(chainFromEnv("base-sepolia"))).toThrow("USDC_ADDRESS")
  expect(() => requireSepoliaToken(chainFromEnv("base"))).not.toThrow()
  expect(() => requireSepoliaToken(chainFromEnv("base-sepolia", quick))).not.toThrow()
})
