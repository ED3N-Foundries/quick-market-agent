import { expect, test } from "bun:test"
import { feeBps, windowMs } from "../server/config"
import { loadMarket, publicConfigSchema, requireExplicitChain } from "./market"

test("environment preferences replace defaults and NEAR is the default chain", () => {
  const loaded = loadMarket({
    WINDOW_SECONDS: "12",
    MARKET_SECONDS: "30",
    VIEW_SECONDS: "15",
    FEE_BPS: "25",
    PRICE_SOURCE: "coinbase",
    CHAIN: "base",
    GRANT_MICROS: "1",
    GRANT_INTERVAL_MS: "1",
  })
  expect(loaded.windowSeconds).toBe(12)
  expect(loaded.marketSeconds).toBe(30)
  expect(loaded.viewSeconds).toBe(15)
  expect(loaded.feeBps).toBe(25)
  expect(loaded.priceSource).toBe("coinbase")
  expect(loaded.chain).toBe("base")
  expect(loadMarket({}).chain).toBe("near-testnet")
  expect(loadMarket({ CHAIN: "near-testnet" }).chain).toBe("near-testnet")
  expect(loaded.grantMicros).toBe(1)
  expect(loaded.grantIntervalMs).toBe(1)
})

test("a blank preference is ignored and an invalid one throws", () => {
  expect(loadMarket({ WINDOW_SECONDS: "  ", FEE_BPS: "" }).windowSeconds).toBe(10)
  expect(() => loadMarket({ FEE_BPS: "nope" })).toThrow("FEE_BPS")
  expect(() => loadMarket({ PRICE_SOURCE: "gemini" })).toThrow("PRICE_SOURCE")
})

test("loaded preferences do not change after a later env write", () => {
  const previous = process.env.WINDOW_SECONDS
  process.env.WINDOW_SECONDS = "99"
  expect(windowMs()).toBe(10_000)
  expect(feeBps()).toBe(0)
  if (previous === undefined) delete process.env.WINDOW_SECONDS
  else process.env.WINDOW_SECONDS = previous
})

test("server and agent require an explicit chain and public config is validated", () => {
  expect(() => requireExplicitChain({})).toThrow("CHAIN")
  expect(() => requireExplicitChain({ CHAIN: "  " })).toThrow("CHAIN")
  expect(() => requireExplicitChain({ CHAIN: "base-sepolia" })).not.toThrow()
  expect(publicConfigSchema.safeParse({}).success).toBe(false)
})
