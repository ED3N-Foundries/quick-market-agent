import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const STATUS_PATH = join(process.cwd(), "agent", "status.json")
export const CONTROL_PATH = join(process.cwd(), "agent", "control.json")
export const FLOW_PATH = join(process.cwd(), "agent", "flow.json")
export const SWARM_PATH = join(process.cwd(), "agent", "swarm.json")
export const KEYS_PATH = join(process.cwd(), "agent", "keys.json")
export const NEAR_KEYS_PATH = join(process.cwd(), "agent", "keys.near.json")

export function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"))
  } catch {
    return null
  }
}

export function writeJsonAtomic(path: string, value: unknown, pretty = true) {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.tmp`
  // The per-second status files ride the compact form; the operator's control
  // file keeps the readable default.
  writeFileSync(tmp, `${pretty ? JSON.stringify(value, null, 2) : JSON.stringify(value)}\n`)
  renameSync(tmp, path)
}
