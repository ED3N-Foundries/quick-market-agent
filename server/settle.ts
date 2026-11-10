import { comparePrice } from "./money"

export type Side = "up" | "down"

export type BuyInInput = {
  id: string
  address: string
  side: Side
  stakeMicros: number
}

export type Payout = BuyInInput & { payoutMicros: number }

export type Resolution = "paid" | "refund" | "void"

export type Settlement = {
  resolution: Resolution
  winningSide: Side | "push" | null
  settle: string | null
  feeMicros: number
  poolUpMicros: number
  poolDownMicros: number
  payouts: Payout[]
}

function pools(bets: BuyInInput[]) {
  let up = 0
  let down = 0
  for (const bet of bets) {
    if (bet.side === "up") up += bet.stakeMicros
    else down += bet.stakeMicros
  }
  return { up, down }
}

function refund(
  bets: BuyInInput[],
  poolUpMicros: number,
  poolDownMicros: number,
  resolution: Resolution,
  winningSide: Side | "push" | null,
  settle: string | null,
): Settlement {
  return {
    resolution,
    winningSide,
    settle,
    feeMicros: 0,
    poolUpMicros,
    poolDownMicros,
    payouts: bets.map((bet) => ({ ...bet, payoutMicros: bet.stakeMicros })),
  }
}

export function settleRound(args: {
  bets: BuyInInput[]
  strike: string | null
  settle: string | null
  feeBps: number
  stale: boolean
}): Settlement {
  const { up, down } = pools(args.bets)
  if (args.stale || !args.strike || !args.settle) {
    return refund(args.bets, up, down, "void", null, null)
  }

  const cmp = comparePrice(args.settle, args.strike)
  if (cmp === 0) return refund(args.bets, up, down, "refund", "push", args.settle)
  const winningSide: Side = cmp > 0 ? "up" : "down"
  if (up === 0 || down === 0) return refund(args.bets, up, down, "refund", winningSide, args.settle)

  const winningPool = winningSide === "up" ? up : down
  const pot = up + down
  const feeMicros = Number((BigInt(pot) * BigInt(args.feeBps)) / 10_000n)
  const distributable = pot - feeMicros
  const payouts = args.bets.map((bet) => {
    if (bet.side !== winningSide) return { ...bet, payoutMicros: 0 }
    const payoutMicros = Number((BigInt(bet.stakeMicros) * BigInt(distributable)) / BigInt(winningPool))
    return { ...bet, payoutMicros }
  })

  return {
    resolution: "paid",
    winningSide,
    settle: args.settle,
    feeMicros,
    poolUpMicros: up,
    poolDownMicros: down,
    payouts,
  }
}
