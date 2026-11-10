import { lookup } from "node:dns/promises"
import { isIP } from "node:net"

export type ApiTarget = {
  host: string
  ip: string | null
}

const TTL_MS = 30_000
const LOOKUP_MS = 2_000

type Cache = {
  url: string
  host: string
  ip: string | null
  at: number
}

let cache: Cache | null = null
let inflight: { url: string; promise: Promise<void> } | null = null

/** Hostname and port the agent process actually requests. */
export function apiEndpointFromUrl(apiUrl: string): { host: string; hostname: string } {
  const trimmed = apiUrl.trim()
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `http://${trimmed}`
  let url: URL
  try {
    url = new URL(withScheme)
  } catch {
    return { host: trimmed, hostname: trimmed }
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "")
  const port = url.port || (url.protocol === "https:" ? "443" : "80")
  const bare = hostname.includes(":") ? `[${hostname}]` : hostname
  return { host: `${bare}:${port}`, hostname }
}

export async function resolveHostIp(
  hostname: string,
  resolve: (hostname: string) => Promise<string[]> = defaultLookupAll,
): Promise<string | null> {
  if (isIP(hostname)) return hostname
  try {
    const addresses = await resolve(hostname)
    const usable = addresses.filter((address) => isIP(address) !== 0)
    const v4 = usable.filter((address) => isIP(address) === 4)
    const chosen = v4.length > 0 ? v4 : usable
    const unique = [...new Set(chosen)]
    return unique.length > 0 ? unique.join(", ") : null
  } catch {
    return null
  }
}

/** Last resolved target for this API URL. An address literal needs no lookup. */
export function peekApiEndpoint(apiUrl: string): ApiTarget {
  const parsed = apiEndpointFromUrl(apiUrl)
  if (cache && cache.url === apiUrl) return { host: cache.host, ip: cache.ip }
  return { host: parsed.host, ip: isIP(parsed.hostname) ? parsed.hostname : null }
}

/** Resolve the API host and remember it. Repeat calls inside the TTL reuse the result. */
export function refreshApiEndpoint(
  apiUrl: string,
  now = Date.now(),
  resolve?: (hostname: string) => Promise<string[]>,
): Promise<void> {
  if (cache && cache.url === apiUrl && now - cache.at < TTL_MS) return Promise.resolve()
  if (inflight && inflight.url === apiUrl) return inflight.promise
  const promise = (async () => {
    const parsed = apiEndpointFromUrl(apiUrl)
    const ip = await resolveHostIp(parsed.hostname, resolve ?? defaultLookupAll)
    const previous = cache && cache.url === apiUrl ? cache.ip : null
    cache = { url: apiUrl, host: parsed.host, ip: ip ?? previous, at: now }
  })()
  const tracked = promise.finally(() => {
    if (inflight?.promise === tracked) inflight = null
  })
  inflight = { url: apiUrl, promise: tracked }
  return tracked
}

async function defaultLookupAll(hostname: string): Promise<string[]> {
  const found = await withTimeout(lookup(hostname, { all: true, verbatim: true }), LOOKUP_MS)
  return found.map((item) => item.address)
}

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("DNS lookup timed out")), ms)
    timer.unref()
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
