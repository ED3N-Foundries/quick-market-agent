import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"

export type ToolBody = Record<string, unknown>

export type ToolReply = { ok: boolean; body: ToolBody; transport: boolean }

export type LiveBook = {
  joinId: number
  windowEndsAt: number
  poolUpMicros: number
  poolDownMicros: number
  feed: "live" | "stale"
  tape: { t: number; price: string }[]
}

export type SettledRound = {
  id: number
  strike: string | null
  settle: string | null
  feeMicros: number
  poolUpMicros: number
  poolDownMicros: number
  winningSide: string | null
  resolution: string | null
}

type ToolContent = { content?: { type: string; text?: string }[]; isError?: boolean }

let client: Client | null = null
let endpoint = ""
let opening: Promise<void> | null = null

export function marketUrl(apiUrl: string, chain: string): string {
  const root = apiUrl.replace(/\/api\/session\/?$/, "").replace(/\/$/, "")
  return `${root}/mcp?chain=${encodeURIComponent(chain)}`
}

export function liveBook(body: ToolBody): LiveBook | null {
  const board = body.board
  if (!board || typeof board !== "object") return null
  const card = board as { join?: unknown; windowEndsAt?: unknown }
  if (typeof card.windowEndsAt !== "number") return null
  const feed = body.feed === "live" || body.feed === "stale" ? body.feed : null
  if (!feed || !Array.isArray(body.tape)) return null
  const tape: { t: number; price: string }[] = []
  for (const point of body.tape) {
    if (!point || typeof point !== "object") return null
    const row = point as { t?: unknown; price?: unknown }
    if (typeof row.t !== "number" || typeof row.price !== "string") return null
    tape.push({ t: row.t, price: row.price })
  }
  const join = card.join
  if (join !== null && join !== undefined && typeof join !== "object") return null
  const pools = join as { id?: unknown; poolUpMicros?: unknown; poolDownMicros?: unknown } | null | undefined
  return {
    joinId: pools && typeof pools.id === "number" ? pools.id : -1,
    windowEndsAt: card.windowEndsAt,
    poolUpMicros: pools && typeof pools.poolUpMicros === "number" ? pools.poolUpMicros : 0,
    poolDownMicros: pools && typeof pools.poolDownMicros === "number" ? pools.poolDownMicros : 0,
    feed,
    tape,
  }
}

export function settledRounds(body: ToolBody): SettledRound[] | null {
  if (!Array.isArray(body.rounds)) return null
  const out: SettledRound[] = []
  for (const row of body.rounds) {
    if (!row || typeof row !== "object") return null
    const round = row as {
      id?: unknown
      strike?: unknown
      settle?: unknown
      poolUpMicros?: unknown
      poolDownMicros?: unknown
      winningSide?: unknown
      resolution?: unknown
    }
    if (typeof round.id !== "number") return null
    if (typeof round.poolUpMicros !== "number" || typeof round.poolDownMicros !== "number") return null
    out.push({
      id: round.id,
      strike: typeof round.strike === "string" ? round.strike : null,
      settle: typeof round.settle === "string" ? round.settle : null,
      feeMicros: 0,
      poolUpMicros: round.poolUpMicros,
      poolDownMicros: round.poolDownMicros,
      winningSide: typeof round.winningSide === "string" ? round.winningSide : null,
      resolution: typeof round.resolution === "string" ? round.resolution : null,
    })
  }
  return out
}

/** The rounds page is newest first. Minds read oldest first. */
export function recentRounds(body: ToolBody): { id: number; winningSide: string | null }[] | null {
  const rows = settledRounds(body)
  if (!rows) return null
  return rows.reverse().map((row) => ({ id: row.id, winningSide: row.winningSide }))
}

export async function openMarket(apiUrl: string, chain: string): Promise<void> {
  endpoint = marketUrl(apiUrl, chain)
  await reconnect()
}

export async function callMarket(name: string, args: Record<string, unknown>): Promise<ToolReply> {
  try {
    return await once(name, args)
  } catch (error) {
    try {
      await reconnect()
    } catch {
      // The next wave rebinds after the caller sees transport: true.
    }
    return {
      ok: false,
      body: { error: error instanceof Error ? error.message : "The book is unreachable" },
      transport: true,
    }
  }
}

async function once(name: string, args: Record<string, unknown>): Promise<ToolReply> {
  const current = await currentClient()
  const result = (await current.callTool({ name, arguments: args })) as ToolContent
  const text = result.content?.find((item) => item.type === "text")?.text
  if (!text) return { ok: false, body: { error: "The book is unreachable" }, transport: true }
  let body: unknown
  try {
    body = JSON.parse(text)
  } catch {
    return { ok: false, body: { error: "The book is unreachable" }, transport: true }
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, body: { error: "The book is unreachable" }, transport: true }
  }
  return { ok: result.isError !== true && !("error" in body), body: body as ToolBody, transport: false }
}

async function reconnect(): Promise<void> {
  if (opening) return opening
  opening = (async () => {
    const previous = client
    client = null
    await previous?.close().catch(() => undefined)
    client = await connect()
  })()
  try {
    await opening
  } finally {
    opening = null
  }
}

async function currentClient(): Promise<Client> {
  if (!client) await reconnect()
  if (!client) throw new Error("The book is unreachable")
  return client
}

async function connect(): Promise<Client> {
  if (!endpoint) throw new Error("The book is unreachable")
  const next = new Client({ name: "quick-market-agent", version: "1.0.0" })
  await next.connect(new StreamableHTTPClientTransport(new URL(endpoint)))
  return next
}
