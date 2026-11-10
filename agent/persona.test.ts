import { expect, test } from "bun:test"
import { swarmConfig } from "./config"
import { personaFor } from "./persona"

test("streak is a minority and those wallets disagree", () => {
  let streak = 0
  let fade = 0
  const needs = new Set<number>()
  const count = 2_000
  for (let index = 0; index < count; index++) {
    const person = personaFor(index, swarmConfig.persona)
    expect(person.streakNeed).toBeGreaterThanOrEqual(2)
    expect(person.streakNeed).toBeLessThanOrEqual(5)
    expect(person.streakConviction).toBeGreaterThanOrEqual(swarmConfig.persona.streakConvictionMin)
    expect(person.streakConviction).toBeLessThanOrEqual(swarmConfig.persona.streakConvictionMax)
    if (person.mind !== "streak") continue
    streak += 1
    if (person.streakFade) fade += 1
    needs.add(person.streakNeed)
  }
  expect(streak / count).toBeGreaterThan(0.1)
  expect(streak / count).toBeLessThan(0.2)
  expect(fade / streak).toBeGreaterThan(0.5)
  expect(fade / streak).toBeLessThan(0.75)
  expect([...needs].sort()).toEqual([2, 3, 4, 5])
})
