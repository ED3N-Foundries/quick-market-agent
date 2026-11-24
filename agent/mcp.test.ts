import { expect, test } from "bun:test"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"
import type { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { activeChainKey } from "../server/activeChain"
import { callMarket, liveBook, marketUrl, recentRounds, reconnect, sessionFor, settledRounds, type Session } from "./mcp"

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

test("a reconnect sends DELETE for the old session before closing it", async () => {
  const calls: string[] = []
  const row: Session = {
    endpoint: "",
    client: {
      close: () => {
        calls.push("close")
        return Promise.resolve()
      },
    } as unknown as Client,
    transport: {
      terminateSession: () => {
        calls.push("delete")
        return Promise.resolve()
      },
    } as unknown as StreamableHTTPClientTransport,
    opening: null,
  }
  // The empty endpoint makes the fresh connect fail after the old session retired.
  await expect(reconnect(row)).rejects.toThrow("The book is unreachable")
  expect(calls).toEqual(["delete", "close"])
})

test("a DELETE that cannot reach the market does not stop the reconnect", async () => {
  const calls: string[] = []
  const row: Session = {
    endpoint: "",
    client: {
      close: () => {
        calls.push("close")
        return Promise.resolve()
      },
    } as unknown as Client,
    transport: {
      terminateSession: () => {
        calls.push("delete")
        return Promise.reject(new Error("fetch failed"))
      },
    } as unknown as StreamableHTTPClientTransport,
    opening: null,
  }
  await expect(reconnect(row)).rejects.toThrow("The book is unreachable")
  expect(calls).toEqual(["delete", "close"])
})

test("a timed-out market call keeps the session and sends no DELETE", async () => {
  const calls: string[] = []
  const row = sessionFor(activeChainKey())
  row.endpoint = ""
  row.client = {
    callTool: () => new Promise(() => {}),
  } as unknown as Client
  row.transport = {
    terminateSession: () => {
      calls.push("delete")
      return Promise.resolve()
    },
  } as unknown as StreamableHTTPClientTransport
  try {
    const reply = await callMarket("book", {}, 25)
    // A slow call is not a lost session: no reconnect, no DELETE, no rebind.
    expect(reply.transport).toBe(false)
    expect(reply.sessionLost).toBeUndefined()
    expect(calls).toEqual([])
  } finally {
    row.client = null
    row.transport = null
    row.endpoint = ""
  }
})
