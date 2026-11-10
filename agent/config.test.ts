import { expect, test } from "bun:test"
import { checkConfig, swarmConfig } from "./config"
import { countTurnover } from "./presence"

test("the shipped swarm config passes", () => {
  expect(checkConfig(swarmConfig)).toBeNull()
})

test("mind shares that do not sum to 1 fail", () => {
  const broken = {
    ...swarmConfig,
    persona: { ...swarmConfig.persona, shares: { ...swarmConfig.persona.shares, tape: 0.2 } },
  }
  expect(checkConfig(broken)).toBe("Mind shares must sum to 1")
})

test("a shorter visit range turns wallets over faster", () => {
  const shipped = countTurnover(swarmConfig.presence, 180)
  const shorter = countTurnover(
    { ...swarmConfig.presence, visitMinMs: 20_000, visitMaxMs: 60_000, gapMinMs: 20_000, gapMaxMs: 90_000 },
    180,
  )
  expect(shorter.leaves + shorter.arrivals).toBeGreaterThan(shipped.leaves + shipped.arrivals)
})
