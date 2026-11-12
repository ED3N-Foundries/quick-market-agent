import { expect, test } from "bun:test"
import { liveBook, marketUrl, recentRounds, settledRounds } from "./mcp"

test("the runner talks to the public MCP URL for its chain", () => {
  expect(marketUrl("http://quick-market:3001", "base-sepolia")).toBe("http://quick-market:3001/mcp?chain=base-sepolia")
  expect(marketUrl("http://127.0.0.1:3001/api/session/", "base-sepolia")).toBe("http://127.0.0.1:3001/mcp?chain=base-sepolia")
})

test("book and rounds map onto the runner book", () => {
  expect(
    liveBook({
      board: { windowEndsAt: 2_000, join: { id: 11, poolUpMicros: 5, poolDownMicros: 7 } },
      feed: "live",
      tape: [{ t: 1, price: "100" }],
    }),
  ).toEqual({
    joinId: 11,
    windowEndsAt: 2_000,
    poolUpMicros: 5,
    poolDownMicros: 7,
    feed: "live",
    tape: [{ t: 1, price: "100" }],
  })
  expect(liveBook({ board: { windowEndsAt: 2_000, join: null }, feed: "stale", tape: [] })).toMatchObject({
    joinId: -1,
    poolUpMicros: 0,
    poolDownMicros: 0,
  })
  const settled = settledRounds({
    rounds: [{ id: 4, strike: "1", settle: "2", poolUpMicros: 3, poolDownMicros: 4, winningSide: "up", resolution: "paid" }],
  })
  expect(settled).toEqual([
    {
      id: 4,
      strike: "1",
      settle: "2",
      feeMicros: 0,
      poolUpMicros: 3,
      poolDownMicros: 4,
      winningSide: "up",
      resolution: "paid",
    },
  ])
  expect(recentRounds({ rounds: [{ id: 9, poolUpMicros: 0, poolDownMicros: 0, winningSide: "down" }, { id: 8, poolUpMicros: 0, poolDownMicros: 0, winningSide: "up" }] })).toEqual([
    { id: 8, winningSide: "up" },
    { id: 9, winningSide: "down" },
  ])
})
