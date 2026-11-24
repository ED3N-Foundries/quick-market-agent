import { expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { dbFileSizes, parseSelfIo, readSelfIo, writeBytesPerMinute } from "./writes"

const KNOWN_IO = `rchar: 1234
wchar: 5678
syscr: 90
syscw: 12
read_bytes: 0
write_bytes: 3456
cancelled_write_bytes: 0
`

test("the /proc/self/io parser reads the write counters from a known string", () => {
  expect(parseSelfIo(KNOWN_IO)).toEqual({ writeBytes: 3_456, wchar: 5_678, syscw: 12 })
})

test("the parser returns null when the counters are unavailable", () => {
  expect(parseSelfIo("rchar: 1\nwchar: 2\n")).toBeNull()
  expect(parseSelfIo("write_bytes: not-a-number\nwchar: 1\nsyscw: 1")).toBeNull()
  expect(parseSelfIo("")).toBeNull()
})

test("reading self io returns null where the kernel does not expose it", () => {
  const dir = mkdtempSync(join(tmpdir(), "io-"))
  expect(readSelfIo(join(dir, "missing"))).toBeNull()
  const partial = join(dir, "partial")
  writeFileSync(partial, "rchar: 1\n")
  expect(readSelfIo(partial)).toBeNull()
})

test("the write rate is the byte delta over the minutes between samples", () => {
  expect(writeBytesPerMinute({ at: 0, writeBytes: 1_000 }, { at: 60_000, writeBytes: 4_000 })).toBe(3_000)
  expect(writeBytesPerMinute({ at: 0, writeBytes: 1_000 }, { at: 30_000, writeBytes: 1_000 })).toBe(0)
  // No second sample yet, or a clock that did not move.
  expect(writeBytesPerMinute({ at: 0, writeBytes: 1_000 }, { at: 0, writeBytes: 2_000 })).toBeNull()
  expect(writeBytesPerMinute({ at: 60_000, writeBytes: 4_000 }, { at: 0, writeBytes: 1_000 })).toBeNull()
})

test("dbFileSizes reads the DB and WAL sizes and zero when a file is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "sizes-"))
  const path = join(dir, "swarm.sqlite")
  writeFileSync(path, "x".repeat(10))
  writeFileSync(`${path}-wal`, "y".repeat(4))
  expect(dbFileSizes(path)).toEqual({ dbBytes: 10, walBytes: 4 })
  expect(dbFileSizes(join(dir, "nope.sqlite"))).toEqual({ dbBytes: 0, walBytes: 0 })
})
