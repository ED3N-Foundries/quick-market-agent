import type { Lang } from "./lang"
import type { PriceSource } from "./market"

export type Ticker = { venue: PriceSource; label: string }

export type Handoff = { from: PriceSource; to: PriceSource | null; resumeAt: number | null }

const NAMES: Record<PriceSource, string> = {
  binance: "Binance",
  bybit: "Bybit",
  okx: "OKX",
  coinbase: "Coinbase",
  kraken: "Kraken",
  bitstamp: "Bitstamp",
}

const PAIRS: Record<PriceSource, string> = {
  binance: "BTCUSDT",
  bybit: "BTCUSDT",
  okx: "BTC-USDT",
  coinbase: "BTC-USD",
  kraken: "BTC/USD",
  bitstamp: "BTC/USD",
}

const QUOTES: Record<PriceSource, string> = {
  binance: "BTC-USDT",
  bybit: "BTC-USDT",
  okx: "BTC-USDT",
  coinbase: "BTC-USD",
  kraken: "BTC/USD",
  bitstamp: "BTC/USD",
}

export function sourceName(source: string, lang: Lang = "en"): string {
  if (source in NAMES) return NAMES[source as PriceSource]
  return lang === "zh-TW" ? "報價來源" : "The price feed"
}

export function sourceLabel(source: string, lang: Lang = "en"): string {
  if (source in NAMES) return `${NAMES[source as PriceSource]} ${PAIRS[source as PriceSource]}`
  return lang === "zh-TW" ? "未知報價" : "an unknown feed"
}

export function quotePair(source: string): string {
  if (source in QUOTES) return QUOTES[source as PriceSource]
  return "BTC"
}

export function tickerFor(venue: PriceSource): Ticker {
  return { venue, label: sourceLabel(venue) }
}

/** Shown on the chart and returned when a buy-in is rejected during the hold. */
export function handoffBanner(from: string, to: string | null, lang: Lang = "en"): string {
  if (!to) {
    const name = sourceName(from, lang)
    return lang === "zh-TW" ? `${name} 中斷` : `${name} dropped`
  }
  return `${sourceName(from, lang)} → ${sourceName(to, lang)}`
}
