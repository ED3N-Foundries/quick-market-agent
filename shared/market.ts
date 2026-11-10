import * as z from "zod"
import type { ChainKey, TokenKind } from "./chain"
import type { Assert, Equal } from "./exact"

export const priceSources = ["binance", "bybit", "okx", "coinbase", "kraken", "bitstamp"] as const

export type PriceSource = (typeof priceSources)[number]

export type MarketPreferences = {
  chain: ChainKey
  windowSeconds: number
  marketSeconds: number
  viewSeconds: number
  feeBps: number
  priceSource: PriceSource
  minStakeMicros: number
  liveMs: number
  tapeMs: number
  grantMicros: number
  grantIntervalMs: number
}

/** What the browser receives. Chain display fields are derived, not preferences. */
export type PublicConfig = {
  windowSeconds: number
  marketSeconds: number
  viewSeconds: number
  feeBps: number
  minStakeMicros: number
  source: PriceSource
  chainId: number
  chainKey: ChainKey
  chainName: string
  usdc: string
  treasury: string
  moneyLabel: string
  tokenKind: TokenKind
  tokenLabel: string
  grantMicros: number
  grantIntervalMs: number
}

const seconds = z.int().min(1).max(120)
const positive = z.int().positive()

export const publicConfigSchema = z.strictObject({
  windowSeconds: seconds,
  marketSeconds: seconds,
  viewSeconds: seconds,
  feeBps: z.int().min(0).max(10_000),
  minStakeMicros: positive,
  source: z.enum(priceSources),
  chainId: z.int().nonnegative(),
  chainKey: z.enum(["base", "base-sepolia", "near-testnet"]),
  chainName: z.string().min(1),
  usdc: z.string(),
  treasury: z.string(),
  moneyLabel: z.string().min(1),
  tokenKind: z.enum(["circle", "qm"]),
  tokenLabel: z.string().min(1),
  grantMicros: z.int().nonnegative(),
  grantIntervalMs: z.int().nonnegative(),
})

type _publicConfig = Assert<Equal<z.infer<typeof publicConfigSchema>, PublicConfig>>

export const marketSchema = z.strictObject({
  chain: z.enum(["base", "base-sepolia", "near-testnet"]),
  windowSeconds: seconds,
  marketSeconds: seconds,
  viewSeconds: seconds,
  feeBps: z.int().min(0).max(10_000),
  priceSource: z.enum(priceSources),
  minStakeMicros: positive,
  liveMs: positive,
  tapeMs: positive,
  grantMicros: positive,
  grantIntervalMs: positive,
})

type _market = Assert<Equal<z.infer<typeof marketSchema>, MarketPreferences>>

const defaults: MarketPreferences = {
  chain: "near-testnet",
  windowSeconds: 10,
  marketSeconds: 10,
  viewSeconds: 5,
  feeBps: 0,
  priceSource: "binance",
  minStakeMicros: 1_000_000,
  liveMs: 5_000,
  tapeMs: 15 * 60 * 1000,
  grantMicros: 100_000_000,
  grantIntervalMs: 120_000,
}

/** How often a browser is sent a price. The stored tape is finer than this. */
export const TICK_MS = 100

/** One price tick behind the synced clock, so the live segment can blend into a print already in hand. Market ids do not use this. */
export const RENDER_MS = TICK_MS

type PreferenceEnv = {
  CHAIN?: string
  WINDOW_SECONDS?: string
  MARKET_SECONDS?: string
  VIEW_SECONDS?: string
  FEE_BPS?: string
  PRICE_SOURCE?: string
  GRANT_MICROS?: string
  GRANT_INTERVAL_MS?: string
}

function unset(value: unknown): unknown {
  if (typeof value !== "string") return value
  const trimmed = value.trim()
  return trimmed === "" ? undefined : trimmed
}

const optionalSeconds = z.preprocess(unset, z.coerce.number().int().min(1).max(120).optional())
const optionalPositive = z.preprocess(unset, z.coerce.number().int().positive().optional())

const preferenceEnv = z.object({
  CHAIN: z.preprocess(unset, z.enum(["base", "base-sepolia", "near-testnet"]).optional()),
  WINDOW_SECONDS: optionalSeconds,
  MARKET_SECONDS: optionalSeconds,
  VIEW_SECONDS: optionalSeconds,
  FEE_BPS: z.preprocess(unset, z.coerce.number().int().min(0).max(10_000).optional()),
  PRICE_SOURCE: z.preprocess(unset, z.enum(priceSources).optional()),
  GRANT_MICROS: optionalPositive,
  GRANT_INTERVAL_MS: optionalPositive,
})

function ambientPreferences(): PreferenceEnv {
  const proc = (globalThis as { process?: { env?: PreferenceEnv } }).process
  const meta = (import.meta as ImportMeta & { env?: PreferenceEnv }).env
  return { ...meta, ...proc?.env }
}

export function requireExplicitChain(env: PreferenceEnv = ambientPreferences()): void {
  if (!env.CHAIN?.trim()) throw new Error("CHAIN must be set to base, base-sepolia, or near-testnet.")
}

/** Environment values override product defaults; invalid explicit values fail at startup. */
export function loadMarket(env: PreferenceEnv = ambientPreferences()): MarketPreferences {
  const declared = preferenceEnv.parse({
    CHAIN: env.CHAIN,
    WINDOW_SECONDS: env.WINDOW_SECONDS,
    MARKET_SECONDS: env.MARKET_SECONDS,
    VIEW_SECONDS: env.VIEW_SECONDS,
    FEE_BPS: env.FEE_BPS,
    PRICE_SOURCE: env.PRICE_SOURCE,
    GRANT_MICROS: env.GRANT_MICROS,
    GRANT_INTERVAL_MS: env.GRANT_INTERVAL_MS,
  })
  return marketSchema.parse({
    chain: declared.CHAIN ?? defaults.chain,
    windowSeconds: declared.WINDOW_SECONDS ?? defaults.windowSeconds,
    marketSeconds: declared.MARKET_SECONDS ?? defaults.marketSeconds,
    viewSeconds: declared.VIEW_SECONDS ?? defaults.viewSeconds,
    feeBps: declared.FEE_BPS ?? defaults.feeBps,
    priceSource: declared.PRICE_SOURCE ?? defaults.priceSource,
    minStakeMicros: defaults.minStakeMicros,
    liveMs: defaults.liveMs,
    tapeMs: defaults.tapeMs,
    grantMicros: declared.GRANT_MICROS ?? defaults.grantMicros,
    grantIntervalMs: declared.GRANT_INTERVAL_MS ?? defaults.grantIntervalMs,
  })
}

export const marketPreferences: MarketPreferences = loadMarket()
