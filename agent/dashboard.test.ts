import { expect, test } from "bun:test"
import {
  connectionOf,
  followOffset,
  handleKey,
  hostLine,
  keyFromEvent,
  renderSnapshot,
  rosterCapacity,
  runnerActionLine,
  runnerConfirmLine,
  stopThenSpawn,
  takeRunnerKey,
  type DashState,
} from "./dashboard"
import { histogram, parseControl, parseSnapshot, type SwarmSnapshot } from "./status"

function snapshot(): SwarmSnapshot {
  return {
    at: 1_000,
    manila: "03:15:00",
    phase: "off-peak",
    hour: 3.25,
    window: [300, 600],
    online: 30,
    spring: 30,
    target: 30,
    arrivedMinute: 2,
    leftMinute: 1,
    trace: Array.from({ length: 180 }, (_, index) => 300 + (index % 40)),
    book: {
      roundId: 10,
      upMicros: 12_340_000,
      downMicros: 8_760_000,
      botUpMicros: 3_000_000,
      botDownMicros: 2_000_000,
      buyIns: 4,
      skips: 26,
      p50: 1_230_000,
      p90: 4_560_000,
    },
    money: {
      seedMicros: 80_000_000,
      mintMicros: 0,
      burnMicros: 0,
      stakeMicros: 5_000_000,
      histogram: histogram([4_000_000, 20_000_000, 80_000_000, 400_000_000, 2_000_000]),
    },
    lastError: null,
    bookLagMs: 40,
    buyInPaused: false,
    bleed: true,
    mode: "pin",
    pin: 30,
  }
}

function state(partial: Partial<DashState> = {}): DashState {
  return { selected: 0, filter: "all", help: false, control: parseControl(null), ...partial }
}

test("the page names the host and the ip of the instance being hit", () => {
  const local = { host: "127.0.0.1:3001", ip: "127.0.0.1" }
  const waiting = renderSnapshot(null, { endpoint: local }, 2_000)
  expect(waiting.split("\n")[0]).toBe("host 127.0.0.1:3001   ip 127.0.0.1")
  expect(hostLine({ host: "qm.example:3001", ip: null })).toBe("host qm.example:3001   ip —")

  const live = snapshot()
  live.apiHost = "qm.example:3001"
  live.apiIp = "203.0.113.8"
  const page = renderSnapshot(live, { endpoint: local }, 2_000)
  expect(page.split("\n")[0]).toBe("host qm.example:3001   ip 203.0.113.8")
  expect(connectionOf(live, true, local)).toEqual({ host: "qm.example:3001", ip: "203.0.113.8" })

  const quiet = snapshot()
  quiet.running = false
  quiet.apiHost = "old.example:3001"
  quiet.apiIp = "198.51.100.9"
  const parked = renderSnapshot(quiet, { endpoint: local }, 2_000)
  expect(parked.split("\n")[0]).toBe("host 127.0.0.1:3001   ip 127.0.0.1")
})

test("the overview is one page", () => {
  const screen = renderSnapshot(snapshot(), state(), 2_000)
  expect(screen.split("\n").length).toBeLessThan(12)
  expect(screen).toContain("Manila 03:15:00")
  expect(screen).toContain("online 30")
  expect(screen).toContain("book")
  expect(screen).toContain("money")
  expect(screen).toContain("p50")
  expect(screen).not.toContain("0x")
})

test("an old control file still means follow the clock", () => {
  const control = parseControl({ paused: ["0xABC"], queue: [{ id: "1", action: "faucet" }] })
  expect(control.mode).toBe("clock")
  expect(control.paused).toEqual(["0xabc"])
  expect(control.bleed).toBe(true)
  expect(control.buyInPaused).toBe(false)
  expect(parseControl({ bettingPaused: true }).buyInPaused).toBe(true)
  expect(parseControl({ buyInPaused: false, bettingPaused: true }).buyInPaused).toBe(false)
  expect(parseControl({ mode: "ramp" }).mode).toBe("ramp")
  const legacy = parseSnapshot({ ...snapshot(), buyInPaused: undefined, bettingPaused: true, book: { ...snapshot().book, buyIns: undefined, bets: 9 } })
  expect(legacy?.buyInPaused).toBe(true)
  expect(legacy?.book.buyIns).toBe(9)
})

test("dashboard keys steer the swarm without listing every wallet", () => {
  const ramped = handleKey(state(), "a", null, 0)
  expect(ramped.state.control.mode).toBe("ramp")
  expect(ramped.state.control.pin).toBeNull()
  const pinned = handleKey(state(), "]", null, 0)
  expect(pinned.state.control.mode).toBe("pin")
  expect(pinned.state.control.pin).toBe(31)
  const paused = handleKey(pinned.state, "b", null, 0)
  expect(paused.state.control.buyInPaused).toBe(true)
  const one = handleKey(paused.state, "p", "0xabc", 3)
  expect(one.state.control.paused).toEqual(["0xabc"])
  const screen = renderSnapshot(snapshot(), { control: one.state.control }, 2_000)
  expect(screen.split("\n").length).toBeLessThan(12)
  expect(screen).toContain("pin 31")
  expect(screen).toContain("buy-ins paused")
  expect(screen).toContain("paused 1")
  const cleared = handleKey(one.state, "P", "0xabc", 3)
  expect(cleared.state.control.paused).toEqual([])
})

test("the filter cycles the useful lists and the view keys do nothing", () => {
  const stuck = handleKey(state(), "f", null, 4)
  expect(stuck.state.filter).toBe("stuck")
  expect(stuck.state.selected).toBe(0)
  const richest = handleKey(stuck.state, "f", null, 4)
  expect(richest.state.filter).toBe("richest")
  const back = handleKey(richest.state, "f", null, 4)
  expect(back.state.filter).toBe("all")
  const numbered = handleKey({ ...state(), selected: 2 }, "1", null, 4)
  expect(numbered.state.selected).toBe(2)
  const helped = handleKey(state(), "?", null, 4)
  expect(helped.state.help).toBe(true)
  expect(handleKey(helped.state, "?", null, 4).state.help).toBe(false)
})

test("the roster follows the selection and the terminal size", () => {
  expect(followOffset(0, 0, 100, 10)).toBe(0)
  expect(followOffset(0, 10, 100, 10)).toBe(1)
  expect(followOffset(20, 10, 100, 10)).toBe(10)
  expect(followOffset(90, 99, 100, 10)).toBe(90)
  const wide = rosterCapacity(120, 24, { help: false, error: false, stacked: false })
  const narrow = rosterCapacity(70, 24, { help: false, error: false, stacked: true })
  const short = rosterCapacity(120, 12, { help: false, error: false, stacked: false })
  expect(wide).toBeGreaterThan(narrow)
  expect(short).toBeLessThan(wide)
  expect(rosterCapacity(120, 24, { help: true, error: false, stacked: false })).toBe(wide - 2)
})

test("terminal keys map onto the steering letters", () => {
  expect(keyFromEvent({ name: "up", sequence: "\u001b[A" })).toBe("k")
  expect(keyFromEvent({ name: "down", sequence: "\u001b[B" })).toBe("j")
  expect(keyFromEvent({ name: "/", shift: true, sequence: "?" })).toBe("?")
  expect(keyFromEvent({ name: "p", shift: true, sequence: "P" })).toBe("P")
  expect(keyFromEvent({ name: "r", shift: true, sequence: "R" })).toBe("R")
  expect(keyFromEvent({ name: "escape", sequence: "\u001b" })).toBe("escape")
  expect(keyFromEvent({ name: "c", ctrl: true, sequence: "\u0003" })).toBe("\u0003")
})

test("start and restart arm a confirm, and y is the only way through", () => {
  const quiet = takeRunnerKey(null, false, "s")
  expect(quiet).toEqual({ handled: true, prompt: "start", intent: null })
  expect(takeRunnerKey(null, true, "s")).toEqual({ handled: true, prompt: null, intent: null })
  expect(takeRunnerKey(null, true, "R")).toEqual({ handled: true, prompt: "restart", intent: null })
  expect(takeRunnerKey(null, false, "R")).toEqual({ handled: true, prompt: null, intent: null })
  expect(takeRunnerKey(null, true, "r")).toEqual({ handled: true, prompt: null, intent: null })

  expect(takeRunnerKey("start", false, "y")).toEqual({ handled: true, prompt: null, intent: "spawn" })
  expect(takeRunnerKey("restart", true, "y")).toEqual({ handled: true, prompt: null, intent: "respawn" })
  expect(takeRunnerKey("start", false, "n")).toEqual({ handled: true, prompt: null, intent: null })
  expect(takeRunnerKey("restart", true, "escape")).toEqual({ handled: true, prompt: null, intent: null })
  expect(takeRunnerKey("restart", true, "b")).toEqual({ handled: true, prompt: "restart", intent: null })

  const steered = handleKey({ ...state(), runnerPrompt: "restart", runnerNote: "AGENT_SECRET is required" }, "j", null, 4)
  expect(steered.state.selected).toBe(1)
  expect(steered.state.runnerPrompt).toBe("restart")
  expect(steered.state.runnerNote).toBe("AGENT_SECRET is required")
})

test("the runner control names start or restart", () => {
  expect(runnerActionLine(false, null, null)).toBe("s  start runner")
  expect(runnerActionLine(true, 48538, null)).toBe("R  restart runner  pid 48538")
  expect(runnerActionLine(true, null, "restart")).toBe("restarting runner")
  expect(runnerConfirmLine("start", null)).toBe("Start the agent runner?  y start   n cancel")
  expect(runnerConfirmLine("restart", 48538)).toBe(
    "Restart the runner? Pid 48538 stops, then a new process starts. Wallets stay in the shared database.  y restart   n cancel",
  )
  const page = renderSnapshot(snapshot(), state(), 2_000)
  expect(page).toContain("R  restart runner")
})

test("stop-then-spawn does not start a second process while the old pid is alive", async () => {
  let alive = true
  const events: string[] = []
  const stopped = await stopThenSpawn({
    pid: 48538,
    alive: () => alive,
    signal: (_pid, signal) => {
      events.push(signal)
      if (signal === "SIGTERM") alive = false
    },
    spawn: () => events.push(alive ? "spawn-alive" : "spawn-dead"),
    sleep: async () => {},
    waitMs: 200,
    pollMs: 50,
  })
  expect(stopped).toBe(true)
  expect(events).toEqual(["SIGTERM", "spawn-dead"])

  const stuck: string[] = []
  const started = await stopThenSpawn({
    pid: 48538,
    alive: () => true,
    signal: (_pid, signal) => stuck.push(signal),
    spawn: () => stuck.push("spawn"),
    sleep: async () => {},
    waitMs: 100,
    pollMs: 50,
  })
  expect(started).toBe(false)
  expect(stuck).toEqual(["SIGTERM", "SIGKILL"])
})
