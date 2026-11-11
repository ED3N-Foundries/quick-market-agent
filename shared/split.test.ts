import { expect, test } from "bun:test"
import { agentMarketAllowed, assignMarket, parseAgentSplit } from "./split"

test("a blank split keeps every agent on Base", () => {
  expect(parseAgentSplit(undefined, undefined)).toEqual({ base: 100, near: 0 })
  expect(parseAgentSplit("  ", "")).toEqual({ base: 100, near: 0 })
  expect(agentMarketAllowed("base-sepolia", { base: 100, near: 0 })).toBe(true)
  expect(agentMarketAllowed("near-testnet", { base: 100, near: 0 })).toBe(false)
})

test("split shares must be whole numbers that sum to 100", () => {
  expect(parseAgentSplit("70", "30")).toEqual({ base: 70, near: 30 })
  expect(() => parseAgentSplit("70", "")).toThrow("sum to 100")
  expect(() => parseAgentSplit("40", "40")).toThrow("sum to 100")
  expect(() => parseAgentSplit("-1", "101")).toThrow("sum to 100")
  expect(() => parseAgentSplit("1.5", "98.5")).toThrow("sum to 100")
})

test("assignMarket follows the Base share and leaves a zero NEAR share idle", () => {
  const allBase = { base: 100, near: 0 }
  for (let index = 0; index < 100; index += 1) expect(assignMarket(index, allBase)).toBe("base-sepolia")
  expect(assignMarket(0, { base: 0, near: 100 })).toBe("near-testnet")
  expect(assignMarket(69, { base: 70, near: 30 })).toBe("base-sepolia")
  expect(assignMarket(70, { base: 70, near: 30 })).toBe("near-testnet")
  expect(assignMarket(-1, { base: 100, near: 0 })).toBe("base-sepolia")
})
