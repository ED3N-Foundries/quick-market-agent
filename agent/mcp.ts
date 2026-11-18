import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { activeChainKey } from "../server/activeChain"

export type ToolBody = Record<string, unknown>

export type ToolReply = { ok: boolean; body: ToolBody; transport: boolean; sessionLost?: boolean }

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

type Session = {
  endpoint: string
  client: Client | null
  opening: Promise<void> | null
}

/** A stalled MCP request must not freeze a lane or leave the enrollment latch stuck. */
const CALL_TIMEOUT_MS = 5_000

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Market call timed out after ${ms}ms`)), ms)
    timer.unref?.()
    work.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

const sessions = new Map<string, Session>()

function sessionFor(chain: string): Session {
  let row = sessions.get(chain)
  if (!row) {
    row = { endpoint: "", client: null, opening: null }
    sessions.set(chain, row)
  }
  return row
}

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
  const row = sessionFor(chain)
  row.endpoint = marketUrl(apiUrl, chain)
  await reconnect(row)
}

export async function callMarket(name: string, args: Record<string, unknown>, timeoutMs = CALL_TIMEOUT_MS): Promise<ToolReply> {
  const row = sessionFor(activeChainKey())
  try {
    return await once(row, name, args, timeoutMs)
  } catch (error) {
    const reason = error instanceof Error ? error.message : "The book is unreachable"
    // A slow call is not a lost session. Reconnecting closes every in-flight
    // request and forces a 9k-wallet rebind, which is much worse than retrying.
    const timedOut = /timed out/i.test(reason)
    let sessionLost = false
    if (!timedOut) {
      console.error(`market ${name} transport: ${reason}`)
      try {
        await reconnect(row)
        // A successful reconnect is a new MCP session with an empty account
        // map. Transient errors that never reconnect keep their bindings.
        sessionLost = true
      } catch {
        // The next wave rebinds after the caller sees transport: true.
      }
    }
    return {
      ok: false,
      body: { error: `${name}: ${reason}` },
      transport: !timedOut,
      ...(sessionLost ? { sessionLost: true } : {}),
    }
  }
}

async function once(row: Session, name: string, args: Record<string, unknown>, timeoutMs: number): Promise<ToolReply> {
  const current = await currentClient(row)
  const result = (await withTimeout(current.callTool({ name, arguments: args }), timeoutMs)) as ToolContent
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

async function reconnect(row: Session): Promise<void> {
  if (row.opening) return row.opening
  row.opening = (async () => {
    const previous = row.client
    row.client = null
    if (previous) await withTimeout(previous.close().catch(() => undefined), CALL_TIMEOUT_MS).catch(() => undefined)
    row.client = await connect(row)
  })()
  try {
    await row.opening
  } finally {
    row.opening = null
  }
}

async function currentClient(row: Session): Promise<Client> {
  if (!row.client) await reconnect(row)
  if (!row.client) throw new Error("The book is unreachable")
  return row.client
}

async function connect(row: Session): Promise<Client> {
  if (!row.endpoint) throw new Error("The book is unreachable")
  const next = new Client({ name: "quick-market-agent", version: "1.0.0" })
  try {
    await withTimeout(next.connect(new StreamableHTTPClientTransport(new URL(row.endpoint))), CALL_TIMEOUT_MS)
    return next
  } catch (error) {
    await next.close().catch(() => undefined)
    throw error
  }
}
