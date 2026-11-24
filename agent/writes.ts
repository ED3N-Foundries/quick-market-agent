import { readFileSync, statSync } from "node:fs"

/** Linux per-process write counters from /proc/self/io. */
export type SelfIo = { writeBytes: number; wchar: number; syscw: number }

/** One write_bytes reading with the clock it was taken at. */
export type SelfIoSample = { at: number; writeBytes: number }

const IO_LINE = /^([a-z_]+):\s*(\d+)$/

/** The counters the write meter reads. Null when the kernel does not report them. */
export function parseSelfIo(text: string): SelfIo | null {
  const values = new Map<string, number>()
  for (const line of text.split("\n")) {
    const match = IO_LINE.exec(line.trim())
    if (match) values.set(match[1]!, Number(match[2]))
  }
  const writeBytes = values.get("write_bytes")
  const wchar = values.get("wchar")
  const syscw = values.get("syscw")
  if (writeBytes === undefined || wchar === undefined || syscw === undefined) return null
  return { writeBytes, wchar, syscw }
}

/** Read this process's I/O counters, or null where /proc/self/io is unavailable. */
export function readSelfIo(path = "/proc/self/io"): SelfIo | null {
  try {
    return parseSelfIo(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

/** Whole-process write rate between two samples. Null before the first sample or on a stalled clock. */
export function writeBytesPerMinute(previous: SelfIoSample, current: SelfIoSample): number | null {
  const minutes = (current.at - previous.at) / 60_000
  if (!(minutes > 0)) return null
  return Math.max(0, (current.writeBytes - previous.writeBytes) / minutes)
}

/** Live sizes of the agent DB and its WAL. Zero when a file is absent, e.g. an in-memory DB. */
export function dbFileSizes(path: string): { dbBytes: number; walBytes: number } {
  const size = (file: string): number => {
    try {
      return statSync(file).size
    } catch {
      return 0
    }
  }
  return { dbBytes: size(path), walBytes: size(`${path}-wal`) }
}
