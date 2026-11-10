import { settleRound } from "../server/settle"
import type { Side } from "./decide"

export type OurBuyIn = { address: string; side: Side; stakeMicros: number }

export function replayPayouts(input: {
  ours: OurBuyIn[]
  poolUpMicros: number
  poolDownMicros: number
  strike: string | null
  settle: string | null
  feeBps: number
  voided: boolean
}) {
  let ourUp = 0
  let ourDown = 0
  const bets = input.ours.map((bet, index) => {
    if (bet.side === "up") ourUp += bet.stakeMicros
    else ourDown += bet.stakeMicros
    return { id: String(index), address: bet.address, side: bet.side, stakeMicros: bet.stakeMicros }
  })
  const extraUp = Math.max(0, input.poolUpMicros - ourUp)
  const extraDown = Math.max(0, input.poolDownMicros - ourDown)
  if (extraUp > 0) bets.push({ id: "other-up", address: "other", side: "up", stakeMicros: extraUp })
  if (extraDown > 0) bets.push({ id: "other-down", address: "other", side: "down", stakeMicros: extraDown })
  return settleRound({
    bets,
    strike: input.strike,
    settle: input.settle,
    feeBps: input.feeBps,
    stale: input.voided || !input.strike || !input.settle,
  })
}
