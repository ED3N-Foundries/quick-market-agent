import { expect, test } from "bun:test"
import { USDC, swarmConfig } from "./config"
import { personaFor, type Persona } from "./persona"
import { shapeStake } from "./stake"

const stake = swarmConfig.stake

function restless(index: number): Persona {
  return { ...personaFor(index, swarmConfig.persona), mind: "restless" }
}

test("stakes are small, repeat, and avoid whole dollars", () => {
  const draws = Array.from({ length: 4_000 }, (_, index) =>
    shapeStake(80 * USDC, personaFor(index, swarmConfig.persona), index + 1, 200 * USDC, stake),
  )
  const amounts = draws.filter((amount): amount is number => amount !== null)
  expect(amounts.length).toBe(draws.length)
  expect(amounts.every((amount) => amount >= USDC)).toBe(true)
  const sorted = amounts.slice().sort((left, right) => left - right)
  const median = sorted[Math.floor(sorted.length / 2)]!
  expect(median).toBeLessThan(8 * USDC)
  const whole = amounts.filter((amount) => amount % USDC === 0).length
  expect(whole / amounts.length).toBeLessThan(0.02)
  expect(shapeStake(80 * USDC, personaFor(4, swarmConfig.persona), 9, 200 * USDC, stake)).toBe(
    shapeStake(80 * USDC, personaFor(4, swarmConfig.persona), 9, 200 * USDC, stake),
  )
  const tight = Array.from({ length: 200 }, (_, index) =>
    shapeStake(USDC, personaFor(index, swarmConfig.persona), index + 1, 9 * USDC, stake),
  ).filter((amount): amount is number => amount !== null)
  expect(tight.every((amount) => amount % USDC !== 0)).toBe(true)
})

test("restless stakes stay in the small cent mass", () => {
  const draws = Array.from({ length: 500 }, (_, index) =>
    shapeStake(80 * USDC, restless(index), index + 11, 200 * USDC, stake),
  )
  const amounts = draws.filter((amount): amount is number => amount !== null)
  expect(amounts.every((amount) => amount <= stake.restlessMax * USDC)).toBe(true)
  const sorted = amounts.slice().sort((left, right) => left - right)
  expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(8 * USDC)
})
