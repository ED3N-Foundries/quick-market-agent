import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"

test("the runner does not keep the faucet loop", () => {
  const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8")
  expect(source).toContain("The swarm refuses CHAIN=base")
  expect(source).toContain("agentMarketAllowed")
  expect(source).not.toContain("The swarm does not run on NEAR")
  expect(source).not.toContain("NEAR agent trading is not enabled")
  expect(source).not.toContain("/api/agents")
  expect(source).not.toContain("x-agent-secret")
  expect(source).not.toContain("needsFaucet")
  expect(source).not.toContain("requestFaucet")
  expect(source).not.toContain("balanceOf")
  expect(source).not.toContain("data/quick-market.sqlite")
})
