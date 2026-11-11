/** @jsxImportSource @opentui/react */
import { createCliRenderer, type MouseEvent } from "@opentui/core"
import { createRoot, useKeyboard, useRenderer, useTerminalDimensions } from "@opentui/react"
import { useEffect, useRef, useState } from "react"
import { loadEnv } from "../server/env"
import { parseAgentSplit } from "../shared/split"
import {
  HELP_LINES,
  connectionOf,
  crowdLine,
  detailLine,
  handleKey,
  histogramLine,
  hostLine,
  isRunnerAlive,
  keyFromEvent,
  loadControl,
  loadSnapshot,
  moneyLine,
  pageRoster,
  panelsFit,
  rosterCapacity,
  rosterCells,
  runnerActionLine,
  runnerConfirmCopy,
  runRunnerIntent,
  saveControl,
  takeRunnerKey,
  type DashState,
  type RosterCells,
  type RunnerPrompt,
  type RowTone,
} from "./dashboard"
import { peekApiEndpoint, refreshApiEndpoint, type ApiTarget } from "./endpoint"
import { formatMicros, spark, type ControlFile, type SwarmSnapshot } from "./status"
import type { WalletRow } from "./swarmdb"

const text = "#f3f0e8"
const muted = "#8f8a80"
const up = "#2fce86"
const down = "#ff5a4f"
const gold = "#e2b340"
const bg = "#090a0c"
const raise = "#1b1e26"

const TONE: Record<RowTone, string> = { text, muted, gold, up, down }

const COL = { mark: 2, idx: 5, address: 13, state: 8, mind: 10, bankroll: 12, last: 16, skip: 12 }

type Page = { rows: WalletRow[]; count: number; offset: number; selected: number }

export function DashboardView({
  snapshot,
  page,
  state,
  now,
  width,
  height,
  endpoint,
  onSelect,
  onScroll,
  onArm,
  onYes,
  onNo,
}: {
  snapshot: SwarmSnapshot | null
  page: Page
  state: DashState
  now: number
  width: number
  height: number
  endpoint: ApiTarget
  onSelect: (index: number) => void
  onScroll: (delta: number) => void
  onArm?: () => void
  onYes?: () => void
  onNo?: () => void
}) {
  const wide = width >= 100
  const roomy = height >= 18
  const prompt = state.runnerPrompt ?? null
  const busy = state.runnerBusy ?? null
  const note = state.runnerNote ?? null
  const pid = typeof snapshot?.pid === "number" ? snapshot.pid : null
  const aliveNow = snapshot ? isRunnerAlive(snapshot, now) : false
  const target = connectionOf(snapshot, aliveNow, endpoint)
  if (!snapshot) {
    return (
      <box style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: bg, padding: 1 }}>
        {target ? <Line>{hostLine(target)}</Line> : null}
        <text fg={text}>Waiting for bun run agent.</text>
        <text fg={muted}>Press s to start the runner, or q to close this dashboard. The runner keeps going.</text>
        <RunnerControl label={runnerActionLine(false, null, busy)} onPress={onArm} />
        {prompt ? <ConfirmLine prompt={prompt} pid={pid} onYes={onYes} onNo={onNo} /> : null}
        {note ? <text fg={down}>{note}</text> : null}
      </box>
    )
  }
  const alive = aliveNow
  const control = state.control
  const together = panelsFit(width, snapshot, control)
  const selectedRow = page.rows[state.selected - page.offset] ?? null
  const onWheel = (event: MouseEvent) => {
    const direction = event.scroll?.direction
    if (direction === "down") onScroll(3)
    else if (direction === "up") onScroll(-3)
    event.stopPropagation()
  }
  return (
    <box
      style={{ width: "100%", height: "100%", flexDirection: "column", backgroundColor: bg, paddingLeft: 1, paddingRight: 1 }}
      onMouseScroll={onWheel}
    >
      {target ? <Line>{hostLine(target)}</Line> : null}
      <Line fg={alive ? text : gold}>
        Manila {snapshot.manila}   {snapshot.phase}   {alive ? "runner live" : "agent quiet"}
      </Line>
      <Line>{crowdLine(snapshot, alive)}</Line>
      {roomy ? <Line fg={muted}>{spark(snapshot.trace) || "·"}</Line> : null}
      {together ? (
        <box style={{ height: 1, flexDirection: "row", flexShrink: 0 }}>
          <Book snapshot={snapshot} />
          <Text>  </Text>
          <Money snapshot={snapshot} control={control} wide={false} />
        </box>
      ) : (
        <box style={{ flexDirection: "column", flexShrink: 0 }}>
          <Book snapshot={snapshot} />
          <Money snapshot={snapshot} control={control} wide={moneyLine(snapshot, control, true).length <= width - 2} />
        </box>
      )}
      {roomy ? <Line fg={muted}>{bandsLine(snapshot)}</Line> : null}
      {snapshot.lastError ? <Line fg={down}>error {snapshot.lastError}</Line> : null}
      <box style={{ flexGrow: 1, flexDirection: "column", flexShrink: 1 }}>
        <RosterHead wide={wide} />
        {page.rows.length === 0 ? <Line fg={muted}>no wallets</Line> : null}
        {page.rows.map((row, index) => (
          <RosterRow
            key={row.address}
            cells={rosterCells(row, page.offset + index === state.selected, control, alive)}
            wide={wide}
            onPress={() => onSelect(page.offset + index)}
          />
        ))}
      </box>
      <Line fg={muted}>{detailLine(selectedRow, control, alive, now)}</Line>
      <box style={{ height: 1, flexDirection: "row", justifyContent: "space-between", flexShrink: 0 }}>
        <box style={{ height: 1, flexDirection: "row", flexShrink: 1 }}>
          <Status control={control} />
          <Text fg={muted}>  ·  </Text>
          <RunnerControl label={runnerActionLine(alive, pid, busy)} onPress={onArm} />
        </box>
        <Text fg={muted}>{state.help ? "? hide" : "? keys"}</Text>
      </box>
      {prompt ? <ConfirmLine prompt={prompt} pid={pid} onYes={onYes} onNo={onNo} /> : null}
      {note ? <Line fg={down}>{note}</Line> : null}
      {state.help ? HELP_LINES.map((line) => <Line key={line} fg={muted}>{line}</Line>) : null}
    </box>
  )
}

function App() {
  const renderer = useRenderer()
  const { width, height } = useTerminalDimensions()
  const [state, setState] = useState<DashState>(() => ({
    selected: 0,
    filter: "all",
    help: false,
    control: loadControl(),
  }))
  const [snapshot, setSnapshot] = useState<SwarmSnapshot | null>(null)
  const [page, setPage] = useState<Page>({ rows: [], count: 0, offset: 0, selected: 0 })
  const [now, setNow] = useState(() => Date.now())
  const [endpoint, setEndpoint] = useState<ApiTarget>(() => peekApiEndpoint(loadEnv().apiUrl))
  const stateRef = useRef(state)
  const pageRef = useRef(page)
  const offsetRef = useRef(0)
  stateRef.current = state
  pageRef.current = page

  useEffect(() => {
    let cancel = false
    const pull = () => {
      const apiUrl = loadEnv().apiUrl
      void refreshApiEndpoint(apiUrl).then(() => {
        if (!cancel) setEndpoint(peekApiEndpoint(apiUrl))
      })
    }
    pull()
    const timer = setInterval(pull, 10_000)
    return () => {
      cancel = true
      clearInterval(timer)
    }
  }, [])

  useEffect(() => {
    const tick = () => {
      try {
        const next = loadSnapshot()
        const current = stateRef.current
        const capacity = rosterCapacity(width, height, {
          help: current.help,
          error: Boolean(next?.lastError),
          stacked: !next || !panelsFit(width, next, current.control),
          extra: (current.runnerPrompt ? 1 : 0) + (current.runnerNote ? 1 : 0),
        })
        const listed = pageRoster(current.filter, current.selected, offsetRef.current, capacity)
        offsetRef.current = listed.offset
        setSnapshot(next)
        setPage(listed)
        setNow(Date.now())
        if (listed.selected !== current.selected) setState({ ...current, selected: listed.selected })
      } catch {
        // A locked snapshot or roster read keeps the last frame on screen.
      }
    }
    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [width, height, state.help, state.filter, state.selected, state.runnerPrompt, state.runnerNote])

  const press = (token: string) => {
    const current = stateRef.current
    if (current.runnerBusy && token !== "q" && token !== "\u0003") return
    const snap = loadSnapshot()
    const alive = isRunnerAlive(snap)
    const taken = takeRunnerKey(current.runnerPrompt ?? null, alive, token)
    if (taken.handled) {
      if (taken.intent) {
        const pid = typeof snap?.pid === "number" && snap.pid > 0 ? snap.pid : null
        const runnerBusy = taken.intent === "spawn" ? "start" : "restart"
        const next = { ...current, runnerPrompt: null, runnerBusy, runnerNote: null } satisfies DashState
        stateRef.current = next
        setState(next)
        void runRunnerIntent(taken.intent, pid).then((runnerNote) => {
          setState((latest) => {
            const done = { ...latest, runnerBusy: null, runnerNote }
            stateRef.current = done
            return done
          })
        })
        return
      }
      const next = { ...current, runnerPrompt: taken.prompt }
      stateRef.current = next
      setState(next)
      return
    }
    const local = pageRef.current.rows[current.selected - pageRef.current.offset] ?? null
    const next = handleKey(current, token, local?.address ?? null, pageRef.current.count)
    if (JSON.stringify(next.state.control) !== JSON.stringify(current.control)) saveControl(next.state.control)
    stateRef.current = next.state
    setState(next.state)
    if (next.quit) renderer.destroy()
  }

  useKeyboard((key) => {
    const token = keyFromEvent(key)
    if (!token || key.eventType === "release") return
    press(token)
  })

  return (
    <DashboardView
      snapshot={snapshot}
      page={page}
      state={state}
      now={now}
      width={width}
      height={height}
      endpoint={endpoint}
      onSelect={(index) => setState((current) => ({ ...current, selected: index }))}
      onScroll={(delta) =>
        setState((current) => ({
          ...current,
          selected: Math.min(Math.max(0, pageRef.current.count - 1), Math.max(0, current.selected + delta)),
        }))
      }
      onArm={() => press(isRunnerAlive(snapshot, now) ? "R" : "s")}
      onYes={() => press("y")}
      onNo={() => press("n")}
    />
  )
}

function bandsLine(snapshot: SwarmSnapshot): string {
  const lag = snapshot.bookLagMs === null ? "—" : `${snapshot.bookLagMs}ms`
  return `p50 ${formatMicros(snapshot.book.p50)}  p90 ${formatMicros(snapshot.book.p90)}  lag ${lag}   ${histogramLine(snapshot)}`
}

function Book({ snapshot }: { snapshot: SwarmSnapshot }) {
  const book = snapshot.book
  const pool = book.upMicros + book.downMicros
  const bot = book.botUpMicros + book.botDownMicros
  const share = pool === 0 ? "—" : `${Math.round((bot / pool) * 100)}%`
  return (
    <box style={{ height: 1, flexDirection: "row", flexShrink: 1 }}>
      <Text>book  r{book.roundId ?? "—"}  </Text>
      <Text fg={up}>up {formatMicros(book.upMicros)}</Text>
      <Text>  </Text>
      <Text fg={down}>down {formatMicros(book.downMicros)}</Text>
      <Text>  bots {share}  buy-ins {book.buyIns}  skips {book.skips}</Text>
    </box>
  )
}

function Money({ snapshot, control, wide }: { snapshot: SwarmSnapshot; control: ControlFile; wide: boolean }) {
  return <Line fg={control.bleed ? text : gold}>{moneyLine(snapshot, control, wide)}</Line>
}

function RunnerControl({ label, onPress }: { label: string; onPress?: () => void }) {
  return (
    <text
      wrapMode="none"
      fg={gold}
      style={{ height: 1, flexShrink: 0 }}
      onMouseDown={(event) => {
        onPress?.()
        event.stopPropagation()
      }}
    >
      {label}
    </text>
  )
}

function ConfirmLine({
  prompt,
  pid,
  onYes,
  onNo,
}: {
  prompt: RunnerPrompt
  pid: number | null
  onYes?: () => void
  onNo?: () => void
}) {
  const copy = runnerConfirmCopy(prompt, pid)
  return (
    <box style={{ height: 1, flexDirection: "row", flexShrink: 0 }}>
      <Text fg={gold}>{copy.ask}  </Text>
      <text
        wrapMode="none"
        fg={gold}
        style={{ height: 1, flexShrink: 0 }}
        onMouseDown={(event) => {
          onYes?.()
          event.stopPropagation()
        }}
      >
        {copy.yes}
      </text>
      <Text fg={gold}>   </Text>
      <text
        wrapMode="none"
        fg={gold}
        style={{ height: 1, flexShrink: 0 }}
        onMouseDown={(event) => {
          onNo?.()
          event.stopPropagation()
        }}
      >
        {copy.no}
      </text>
    </box>
  )
}

function Status({ control }: { control: ControlFile }) {
  const mode = control.mode === "pin" ? `pin ${control.pin ?? 1}` : control.mode
  const split = (() => {
    try {
      return parseAgentSplit(process.env.AGENT_SPLIT_BASE, process.env.AGENT_SPLIT_NEAR)
    } catch {
      return { base: 100, near: 0 }
    }
  })()
  return (
    <box style={{ height: 1, flexDirection: "row", flexShrink: 1 }}>
      <Text fg={control.mode === "clock" ? text : gold}>{mode}</Text>
      <Text fg={muted}>  ·  </Text>
      <Text fg={control.buyInPaused ? gold : text}>{control.buyInPaused ? "buy-ins paused" : "buy-ins on"}</Text>
      <Text fg={muted}>  ·  </Text>
      <Text fg={control.bleed ? text : gold}>{control.bleed ? "bleed on" : "bleed off"}</Text>
      <Text>  ·  paused {control.paused.length}</Text>
      <Text fg={muted}>{`  ·  split base ${split.base} / near ${split.near}`}</Text>
    </box>
  )
}

function RosterHead({ wide }: { wide: boolean }) {
  return (
    <box style={{ height: 1, flexDirection: "row", flexShrink: 0 }}>
      <Cell width={COL.mark} fg={muted}> </Cell>
      <Cell width={COL.idx} fg={muted}>#</Cell>
      <Cell width={COL.address} fg={muted}>address</Cell>
      <Cell width={COL.state} fg={muted}>state</Cell>
      {wide ? <Cell width={COL.mind} fg={muted}>mind</Cell> : null}
      <Cell width={COL.bankroll} fg={muted}>bankroll</Cell>
      {wide ? <Cell width={COL.last} fg={muted}>last</Cell> : null}
      <Cell width={COL.skip} fg={muted}>skip</Cell>
      {wide ? <Text fg={muted}>W/L</Text> : null}
    </box>
  )
}

function RosterRow({ cells, wide, onPress }: { cells: RosterCells; wide: boolean; onPress: () => void }) {
  return (
    <box
      style={{ height: 1, flexDirection: "row", flexShrink: 0, backgroundColor: cells.mark === ">" ? raise : bg }}
      onMouseDown={(event) => {
        onPress()
        event.stopPropagation()
      }}
    >
      <Cell width={COL.mark} fg={gold}>{cells.mark}</Cell>
      <Cell width={COL.idx}>{cells.idx}</Cell>
      <Cell width={COL.address} fg={cells.mark === ">" ? gold : text}>{cells.address}</Cell>
      <Cell width={COL.state} fg={TONE[cells.stateTone]}>{cells.state}</Cell>
      {wide ? <Cell width={COL.mind} fg={muted}>{cells.mind}</Cell> : null}
      <Cell width={COL.bankroll}>{cells.bankroll}</Cell>
      {wide ? <Cell width={COL.last} fg={TONE[cells.lastTone]}>{cells.last}</Cell> : null}
      <Cell width={COL.skip} fg={muted}>{cells.skip}</Cell>
      {wide ? <Text>{cells.record}</Text> : null}
    </box>
  )
}

function Line({ children, fg = text }: { children: string; fg?: string }) {
  return <Text fg={fg}>{children}</Text>
}

function Text({ children, fg = text }: { children: string; fg?: string }) {
  return (
    <text wrapMode="none" fg={fg} style={{ height: 1, flexShrink: 0 }}>
      {children}
    </text>
  )
}

function Cell({ children, width, fg = text }: { children: string; width: number; fg?: string }) {
  return (
    <text wrapMode="none" fg={fg} style={{ height: 1, width, flexShrink: 0 }}>
      {fit(children, width)}
    </text>
  )
}

function fit(value: string, width: number): string {
  if (value.length > width) return value.slice(0, width)
  return value.padEnd(width)
}

export async function runScreen(): Promise<void> {
  const renderer = await createCliRenderer({
    exitOnCtrlC: true,
    useMouse: true,
    targetFps: 30,
    backgroundColor: bg,
  })
  createRoot(renderer).render(<App />)
  await new Promise<void>((resolve) => {
    renderer.once("destroy", () => resolve())
  })
}
