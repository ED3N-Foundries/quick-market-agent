import { existsSync } from "node:fs"
import { join } from "node:path"
import { Database } from "bun:sqlite"
import { marketPreferences } from "../shared/market"
import { loadEnv } from "../server/env"
import { peekApiEndpoint, refreshApiEndpoint, type ApiTarget } from "./endpoint"
import { CONTROL_PATH, STATUS_PATH, SWARM_PATH, readJson, writeJsonAtomic } from "./store"
import { roster, rosterCount, type RosterFilter, type WalletRow } from "./swarmdb"
import {
  formatMicros,
  parseControl,
  parseSnapshot,
  shortAddress,
  spark,
  type ControlFile,
  type SwarmSnapshot,
} from "./status"

const FILTERS: readonly RosterFilter[] = ["all", "stuck", "richest"]

export const HELP_LINES = [
  "c clock   o off-peak   e peak   [ ] pin ±1   - = pin ±10",
  "b buy-ins   m bleed   p wallet   P clear   j/k move   f filter   s start   R restart   q quit",
] as const

export type RunnerPrompt = "start" | "restart"

export type DashState = {
  selected: number
  filter: RosterFilter
  help: boolean
  control: ControlFile
  runnerPrompt?: RunnerPrompt | null
  runnerBusy?: "start" | "restart" | null
  runnerNote?: string | null
}

export type KeyInput = {
  name: string
  shift?: boolean
  ctrl?: boolean
  sequence?: string
}

export function keyFromEvent(key: KeyInput): string | null {
  if (key.ctrl && key.name.toLowerCase() === "c") return "\u0003"
  if (key.name === "escape" || key.name === "esc") return "escape"
  if (key.name === "up") return "k"
  if (key.name === "down") return "j"
  const sequence = key.sequence ?? ""
  if (sequence.length === 1 && !key.ctrl) return sequence
  if (key.name.length === 1) return key.shift ? key.name.toUpperCase() : key.name
  return null
}

export function handleKey(
  state: DashState,
  key: string,
  selectedAddress: string | null,
  count: number,
): { state: DashState; quit: boolean } {
  if (key === "q" || key === "\u0003") return { state, quit: true }
  if (key === "?") return { state: { ...state, help: !state.help }, quit: false }
  const control = { ...state.control, paused: state.control.paused.slice() }
  let { selected, filter } = state
  if ((key === "j" || key === "\u001b[B") && count > 0) selected = Math.min(count - 1, selected + 1)
  if ((key === "k" || key === "\u001b[A") && count > 0) selected = Math.max(0, selected - 1)
  if (key === "c") {
    control.mode = "clock"
    control.pin = null
  }
  if (key === "o") {
    control.mode = "off-peak"
    control.pin = null
  }
  if (key === "e") {
    control.mode = "peak"
    control.pin = null
  }
  if (key === "[") {
    control.mode = "pin"
    control.pin = Math.max(1, (control.pin ?? 30) - 1)
  }
  if (key === "]") {
    control.mode = "pin"
    control.pin = Math.min(6_000, (control.pin ?? 30) + 1)
  }
  if (key === "-" || key === "_") {
    control.mode = "pin"
    control.pin = Math.max(1, (control.pin ?? 30) - 10)
  }
  if (key === "=" || key === "+") {
    control.mode = "pin"
    control.pin = Math.min(6_000, (control.pin ?? 30) + 10)
  }
  if (key === "b") control.buyInPaused = !control.buyInPaused
  if (key === "m") control.bleed = !control.bleed
  if (key === "f") {
    filter = FILTERS[(FILTERS.indexOf(filter) + 1) % FILTERS.length] ?? "all"
    selected = 0
  }
  if (key === "p" && selectedAddress) {
    const address = selectedAddress.toLowerCase()
    control.paused = control.paused.includes(address)
      ? control.paused.filter((item) => item !== address)
      : [...control.paused, address]
  }
  if (key === "P") control.paused = []
  return { state: { ...state, selected, filter, help: state.help, control }, quit: false }
}

export function isRunnerAlive(snapshot: SwarmSnapshot | null, now = Date.now()): boolean {
  if (!snapshot) return false
  if (snapshot.running === false) return false
  if (typeof snapshot.pid === "number" && snapshot.pid > 0) {
    try {
      process.kill(snapshot.pid, 0)
      return now - snapshot.at <= 15_000
    } catch {
      return false
    }
  }
  return now - snapshot.at <= 15_000
}

export function panelsFit(width: number, snapshot: SwarmSnapshot, control: ControlFile): boolean {
  if (width < 100) return false
  return bookLine(snapshot, false).length + moneyLine(snapshot, control, false).length + 2 <= width - 2
}

export function rosterCapacity(
  width: number,
  height: number,
  options: { help: boolean; error: boolean; stacked: boolean; extra?: number },
): number {
  const roomy = height >= 18
  const chrome =
    1 +
    1 +
    1 +
    (roomy ? 1 : 0) +
    (options.stacked ? 2 : 1) +
    (roomy ? 1 : 0) +
    (options.error ? 1 : 0) +
    1 +
    1 +
    1 +
    (options.help ? 2 : 0) +
    (options.extra ?? 0)
  return Math.max(1, height - chrome)
}

export function followOffset(offset: number, selected: number, count: number, visible: number): number {
  const size = Math.max(1, visible)
  if (count <= 0) return 0
  const max = Math.max(0, count - size)
  let next = Math.min(Math.max(0, offset), max)
  if (selected < next) next = selected
  if (selected >= next + size) next = Math.min(max, selected - size + 1)
  return next
}

export function crowdLine(snapshot: SwarmSnapshot, alive: boolean): string {
  const online = alive ? String(snapshot.online) : `0 (last ${snapshot.online})`
  const enrolled = typeof snapshot.enrolled === "number" ? `   enrolled ${snapshot.enrolled}` : ""
  const low = Math.round(snapshot.window[0])
  const high = Math.round(snapshot.window[1])
  return `online ${online}${enrolled}   window ${low}–${high}   spring ${Math.round(snapshot.spring)}   target ${Math.round(snapshot.target)}   +${snapshot.arrivedMinute} −${snapshot.leftMinute}`
}

export function bookLine(snapshot: SwarmSnapshot, wide: boolean): string {
  const book = snapshot.book
  const pool = book.upMicros + book.downMicros
  const bot = book.botUpMicros + book.botDownMicros
  const share = pool === 0 ? "—" : `${Math.round((bot / pool) * 100)}%`
  const head = `book  r${book.roundId ?? "—"}  up ${formatMicros(book.upMicros)}  down ${formatMicros(book.downMicros)}  bots ${share}  buy-ins ${book.buyIns}  skips ${book.skips}`
  if (!wide) return head
  const lag = snapshot.bookLagMs === null ? "—" : `${snapshot.bookLagMs}ms`
  return `${head}  p50 ${formatMicros(book.p50)}  p90 ${formatMicros(book.p90)}  lag ${lag}`
}

export function moneyLine(snapshot: SwarmSnapshot, control: ControlFile, wide: boolean): string {
  const money = snapshot.money
  const net = money.seedMicros + money.mintMicros - money.burnMicros
  const bleed = control.bleed ? "bleed on" : "bleed off"
  const head = `money  seed ${formatMicros(money.seedMicros)}  net ${formatMicros(net)}  ${bleed}`
  if (!wide) return head
  return `money  seed ${formatMicros(money.seedMicros)}  mints ${formatMicros(money.mintMicros)}  burns ${formatMicros(money.burnMicros)}  net ${formatMicros(net)}  staked ${formatMicros(money.stakeMicros)}  ${bleed}`
}

export function histogramLine(snapshot: SwarmSnapshot): string {
  return snapshot.money.histogram.map((band) => `${band.band} ${band.count}`).join("   ")
}

export function statusLine(control: ControlFile): string {
  const mode = control.mode === "pin" ? `pin ${control.pin ?? 1}` : control.mode
  const buyIns = control.buyInPaused ? "buy-ins paused" : "buy-ins on"
  const bleed = control.bleed ? "bleed on" : "bleed off"
  return `${mode}  ·  ${buyIns}  ·  ${bleed}  ·  paused ${control.paused.length}`
}

export type RowTone = "text" | "muted" | "gold" | "up" | "down"

export type RosterCells = {
  mark: string
  idx: string
  address: string
  state: string
  stateTone: RowTone
  mind: string
  bankroll: string
  last: string
  lastTone: RowTone
  skip: string
  record: string
}

export function rosterCells(row: WalletRow, selected: boolean, control: ControlFile, alive: boolean): RosterCells {
  const paused = control.paused.includes(row.address.toLowerCase())
  const state = paused ? "paused" : !alive ? (row.online ? "quiet" : "asleep") : row.online ? "awake" : "asleep"
  const stateTone: RowTone = paused || state === "quiet" ? "gold" : state === "awake" ? "text" : "muted"
  const last = row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : "—"
  const lastTone: RowTone = row.lastSide === "up" ? "up" : row.lastSide === "down" ? "down" : "muted"
  return {
    mark: selected ? ">" : " ",
    idx: String(row.idx),
    address: shortAddress(row.address),
    state,
    stateTone,
    mind: row.mind,
    bankroll: formatMicros(row.bankroll),
    last,
    lastTone,
    skip: row.lastSkip ?? (row.online ? "ready" : "asleep"),
    record: `${row.wins}/${row.losses}`,
  }
}

export function detailLine(row: WalletRow | null, control: ControlFile, alive: boolean, now: number): string {
  if (!row) return "no wallet selected"
  const paused = control.paused.includes(row.address.toLowerCase())
  const visit = !alive ? "runner quiet" : row.visitEnd > now ? `${Math.max(1, Math.round((row.visitEnd - now) / 1000))}s left` : "visit ended"
  const tempo = Number.isFinite(row.tempo) ? row.tempo.toFixed(1) : String(row.tempo)
  const last = row.lastSide ? `${row.lastSide} ${formatMicros(row.lastStake ?? 0)}` : "—"
  const games = row.wins + row.losses
  const rate = games > 0 ? ` ${Math.round((row.wins / games) * 100)}%` : ""
  return `#${row.idx}  ${row.mind}  tempo ${tempo}  ${visit}  ${formatMicros(row.bankroll)}  last ${last}  ${row.lastSkip ?? "—"}  ${row.wins}/${row.losses}${rate}${paused ? "  paused" : ""}`
}

export function hostLine(target: ApiTarget): string {
  return `host ${target.host}   ip ${target.ip ?? "—"}`
}

/** A live runner reports the host it is hitting. Otherwise show where this process would connect. */
export function connectionOf(snapshot: SwarmSnapshot | null, alive: boolean, local: ApiTarget | null): ApiTarget | null {
  if (alive && snapshot && typeof snapshot.apiHost === "string" && snapshot.apiHost) {
    const ip = typeof snapshot.apiIp === "string" && snapshot.apiIp ? snapshot.apiIp : null
    return { host: snapshot.apiHost, ip }
  }
  return local
}

export function renderSnapshot(
  snapshot: SwarmSnapshot | null,
  state: { help?: boolean; control?: ControlFile; endpoint?: ApiTarget | null } = {},
  now = Date.now(),
): string {
  const alive = snapshot ? isRunnerAlive(snapshot, now) : false
  const endpoint = connectionOf(snapshot, alive, state.endpoint ?? null)
  const where = endpoint ? hostLine(endpoint) : ""
  if (!snapshot) {
    const lines = [
      "Waiting for bun run agent.",
      "",
      "Press s to start the runner, or q to close this dashboard. The runner keeps going.",
    ]
    if (where) lines.unshift(where)
    return lines.join("\n")
  }
  const control = state.control ?? controlFromSnapshot(snapshot)
  const lines = [
    where,
    `Manila ${snapshot.manila}   ${snapshot.phase}   ${alive ? "runner live" : "agent quiet"}`,
    crowdLine(snapshot, alive),
    spark(snapshot.trace) || "·",
    bookLine(snapshot, true),
    moneyLine(snapshot, control, true),
    histogramLine(snapshot),
    snapshot.lastError ? `error ${snapshot.lastError}` : "",
    statusLine(control),
    runnerActionLine(alive, typeof snapshot.pid === "number" ? snapshot.pid : null, null),
    ...(state.help ? HELP_LINES : []),
  ].filter((line) => line !== "")
  return lines.join("\n")
}

export function loadSnapshot(): SwarmSnapshot | null {
  return parseSnapshot(readJson(SWARM_PATH)) ?? parseSnapshot(readJson(STATUS_PATH))
}

export function loadControl(): ControlFile {
  return parseControl(readJson(CONTROL_PATH))
}

export function saveControl(control: ControlFile) {
  writeJsonAtomic(CONTROL_PATH, control)
}

export function pageRoster(
  filter: RosterFilter,
  selected: number,
  previousOffset: number,
  capacity: number,
): { rows: WalletRow[]; count: number; offset: number; selected: number } {
  const size = Math.max(1, capacity)
  const path = loadEnv().dbPath
  if (!existsSync(path)) return { rows: [], count: 0, offset: 0, selected: 0 }
  const db = new Database(path, { readonly: true })
  try {
    const count = rosterCount(db, filter)
    const nextSelected = count === 0 ? 0 : Math.min(Math.max(0, selected), count - 1)
    const offset = followOffset(previousOffset, nextSelected, count, size)
    return { rows: roster(db, filter, offset, size), count, offset, selected: nextSelected }
  } finally {
    db.close()
  }
}

export type RunnerKey = {
  handled: boolean
  prompt: RunnerPrompt | null
  intent: "spawn" | "respawn" | null
}

export function takeRunnerKey(prompt: RunnerPrompt | null, alive: boolean, key: string): RunnerKey {
  if (prompt) {
    if (key === "y" || key === "Y") return { handled: true, prompt: null, intent: prompt === "start" ? "spawn" : "respawn" }
    if (key === "n" || key === "N" || key === "escape" || key === "\u001b") return { handled: true, prompt: null, intent: null }
    return { handled: true, prompt, intent: null }
  }
  if (key === "s" && !alive) return { handled: true, prompt: "start", intent: null }
  if (key === "R" && alive) return { handled: true, prompt: "restart", intent: null }
  if (key === "s" || key === "S" || key === "r" || key === "R") return { handled: true, prompt: null, intent: null }
  return { handled: false, prompt: null, intent: null }
}

export function runnerActionLine(alive: boolean, pid: number | null, busy: "start" | "restart" | null): string {
  if (busy === "start") return "starting runner"
  if (busy === "restart") return "restarting runner"
  if (!alive) return "s  start runner"
  const who = typeof pid === "number" && pid > 0 ? `  pid ${pid}` : ""
  return `R  restart runner${who}`
}

export function runnerConfirmCopy(prompt: RunnerPrompt, pid: number | null): { ask: string; yes: string; no: string } {
  if (prompt === "start") return { ask: "Start the agent runner?", yes: "y start", no: "n cancel" }
  const who = typeof pid === "number" && pid > 0 ? `Pid ${pid} stops` : "The current process stops"
  return {
    ask: `Restart the runner? ${who}, then a new process starts. Wallets stay in the shared database.`,
    yes: "y restart",
    no: "n cancel",
  }
}

export function runnerConfirmLine(prompt: RunnerPrompt, pid: number | null): string {
  const copy = runnerConfirmCopy(prompt, pid)
  return `${copy.ask}  ${copy.yes}   ${copy.no}`
}

export function runnerBlock(): string | null {
  if (marketPreferences.chain === "base") return "The swarm refuses CHAIN=base. Real USDC is out of this mode."
  if (!loadEnv().agentSecret) return "AGENT_SECRET is required"
  return null
}

export function launchRunner(): string | null {
  const blocked = runnerBlock()
  if (blocked) return blocked
  try {
    const child = Bun.spawn(["bun", "run", join(import.meta.dir, "index.ts")], {
      stdout: "ignore",
      stderr: "ignore",
      stdin: "ignore",
      env: process.env,
    })
    child.unref()
    return null
  } catch (error) {
    return error instanceof Error ? error.message : "The runner did not start"
  }
}

export async function stopThenSpawn(input: {
  pid: number | null
  alive: (pid: number) => boolean
  signal: (pid: number, signal: "SIGTERM" | "SIGKILL") => void
  spawn: () => void
  sleep: (ms: number) => Promise<void>
  waitMs?: number
  pollMs?: number
}): Promise<boolean> {
  const waitMs = input.waitMs ?? 2_000
  const pollMs = input.pollMs ?? 50
  const pid = input.pid
  if (typeof pid === "number" && pid > 0 && input.alive(pid)) {
    try {
      input.signal(pid, "SIGTERM")
    } catch {
      // The pid can exit between the alive check and the signal.
    }
    let left = waitMs
    while (input.alive(pid) && left > 0) {
      await input.sleep(Math.min(pollMs, left))
      left -= pollMs
    }
    if (input.alive(pid)) {
      try {
        input.signal(pid, "SIGKILL")
      } catch {
        // Already gone.
      }
      await input.sleep(pollMs)
    }
    if (input.alive(pid)) return false
  }
  input.spawn()
  return true
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export async function runRunnerIntent(intent: "spawn" | "respawn", pid: number | null): Promise<string | null> {
  const blocked = runnerBlock()
  if (blocked) return blocked
  if (intent === "spawn") return launchRunner()
  if (typeof pid !== "number" || pid <= 0) return "The runner pid is missing"
  let note: string | null = null
  const started = await stopThenSpawn({
    pid,
    alive: pidAlive,
    signal: (id, signal) => {
      process.kill(id, signal)
    },
    spawn: () => {
      note = launchRunner()
    },
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  })
  if (!started) return "The runner is still stopping"
  return note
}

function controlFromSnapshot(snapshot: SwarmSnapshot): ControlFile {
  return {
    mode:
      snapshot.mode === "pin" || snapshot.mode === "off-peak" || snapshot.mode === "peak" || snapshot.mode === "clock"
        ? snapshot.mode
        : "clock",
    pin: snapshot.pin,
    buyInPaused: snapshot.buyInPaused,
    paused: [],
    bleed: snapshot.bleed,
  }
}

async function main() {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY)
  if (!interactive) {
    const apiUrl = loadEnv().apiUrl
    await refreshApiEndpoint(apiUrl)
    const snapshot = loadSnapshot()
    console.log(renderSnapshot(snapshot, { control: loadControl(), endpoint: peekApiEndpoint(apiUrl) }))
    return
  }
  const { runScreen } = await import("./screen.tsx")
  await runScreen()
}

if (import.meta.main) await main()
