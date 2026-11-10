export const LANGUAGES = [
  { code: "en", label: "English" },
  { code: "zh-TW", label: "繁體中文" },
] as const

export type Lang = (typeof LANGUAGES)[number]["code"]

export function parseLang(value: string | null | undefined): Lang | null {
  if (value === "en" || value === "zh-TW") return value
  return null
}

/** Missing or unknown `lang` stays English. */
export function readLang(search: string): Lang {
  const params = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search)
  return parseLang(params.get("lang")) ?? "en"
}

/** Set `lang` and keep every other query parameter. */
export function withLang(href: string, lang: Lang): string {
  const url = new URL(href, "https://quickmarket.app")
  url.searchParams.set("lang", lang)
  return `${url.pathname}${url.search}${url.hash}`
}

/** Rewrite the document language. The rest of the file stays put. */
export function stampHtml(html: string, lang: Lang): string {
  return html.replace(/<html\b([^>]*)>/i, (_match, rest: string) => {
    const attrs = String(rest).replace(/\s+lang\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+)/i, "")
    return `<html lang="${lang}"${attrs}>`
  })
}
