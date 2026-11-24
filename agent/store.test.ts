import { expect, test } from "bun:test"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readJson, writeJsonAtomic } from "./store"

test("compact status JSON parses to the same object and pretty output is still available", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"))
  const value = { at: 1, book: { buyIns: 2, skips: 0 }, trace: [1, 2, 3] }

  const compact = join(dir, "compact.json")
  writeJsonAtomic(compact, value, false)
  expect(readFileSync(compact, "utf8")).toBe(`${JSON.stringify(value)}\n`)
  expect(readJson(compact)).toEqual(value)

  const pretty = join(dir, "pretty.json")
  writeJsonAtomic(pretty, value)
  expect(readFileSync(pretty, "utf8")).toBe(`${JSON.stringify(value, null, 2)}\n`)
  expect(readJson(pretty)).toEqual(value)
})

test("status writes stay atomic: no partial file is left behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "status-"))
  const path = join(dir, "status.json")
  writeJsonAtomic(path, { at: 1 }, false)
  writeJsonAtomic(path, { at: 2 }, false)
  expect(readJson(path)).toEqual({ at: 2 })
})
