import { expect, test } from "bun:test"
import { parseLang, readLang, stampHtml, withLang } from "./lang"

test("lang query keeps a known code and drops an unknown one", () => {
  expect(parseLang("zh-TW")).toBe("zh-TW")
  expect(parseLang("en")).toBe("en")
  expect(parseLang("nope")).toBeNull()
  expect(parseLang(null)).toBeNull()
  expect(readLang("?lang=zh-TW")).toBe("zh-TW")
  expect(readLang("?lang=nope")).toBe("en")
  expect(readLang("")).toBe("en")
})

test("setting lang leaves the other query parameters", () => {
  const next = withLang("/?login=1&x=2", "zh-TW")
  const url = new URL(next, "https://quickmarket.app")
  expect(url.pathname).toBe("/")
  expect(url.searchParams.get("lang")).toBe("zh-TW")
  expect(url.searchParams.get("login")).toBe("1")
  expect(url.searchParams.get("x")).toBe("2")
})

test("stampHtml changes only the document language", () => {
  const html = `<!doctype html>
<html lang="en">
  <head><title>Quick Market</title></head>
  <body>Hi</body>
</html>`
  const stamped = stampHtml(html, "zh-TW")
  expect(stamped).toContain('<html lang="zh-TW">')
  expect(stamped).not.toContain('lang="en"')
  expect(stamped).toContain("<title>Quick Market</title>")
  expect(stamped).toContain("<body>Hi</body>")
})
