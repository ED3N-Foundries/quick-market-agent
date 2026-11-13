# Selfish agent swarm

A Bun runner keeps a crowd of durable wallets whose size glides between a few hundred and a few thousand, each betting to win for itself with uneven stakes. Surplus above $1,000 is burned. Balances under $3 are refilled just enough to stay in the game. The human grant, the human withdraw, and the one-bet lock stay as they are.

How often a wallet comes on, turns off, and bets is a separate problem from the chair count. That behavior is a mix of seeded noise and a few small rules on the public tape. Both halves stay in. The noise spreads equal wallets off the same tick. The rules make a live tape busier and a dead tape quieter.

## Noise and judgment

Both layers are on for every wallet, every tick.

Noise, all seeded from the wallet index, so a replay repeats:

- Multi-scale. The slow simplex mood and the evening `fbm` stay. A faster, smaller octave roughens arrivals and the online trace inside the window. The shape is more than one smooth hill.
- Skewed clocks. Visit lengths, gaps between visits, and gaps between bets are `easing.expoOut` draws. Most are short. A few run long.
- Private streams. Equal minds do not share a `mulberry32` stream. The disagreement residual stays private to that wallet.

Judgment, all clamped so a hot tape cannot rewrite the Manila window:

- Alternating visits. A wallet arrives for a visit and leaves when the visit ends. Rank is only the spare list, not a seat for the whole evening.
- Tape response. A moving tape shortens the wait until the next bet and can stretch the open visit a little. A flat tape lengthens the wait and ends visits sooner. Sleeping wallets stay asleep until a visit is due.
- Bursts, then quiet. A bet raises that wallet's chance of another bet for a couple of windows, then a refractory gap. A few similar chronotypes may follow an arrival. Both bumps are a capped self-exciting kernel: a hard limit on the extra bets and the extra arrivals, then decay.
- A mixture of minds. Tape, fade, the pool price, and the settled-result column are different reasons to bet. Most wallets lean on one. About one in five adds a second term at low weight. A restless minority is mostly noise, with small stakes and a low rate. A streak minority counts the last few settled markets and disagrees about how long a run has to be.

No wallet is told the next print. No wallet calls a model. The rules read the public tape, the settled up/down column, and that wallet's own last results.

## How many are online

The live crowd always prefers a window about 600 agents wide. That window slides. It does not jump.

Asia/Manila (UTC+8, no daylight saving) is the clock. Hours below are Manila local.

| Hours | Preference window |
| --- | --- |
| 02:00–07:00 | Fixed at [600, 1,200]. This is the off-peak example. |
| 07:00–17:00 | Center eases from 900 toward the low end of the peak box (~6,300) with `easing.cubicInOut`. The window is `[center - 300, center + 300]`. |
| 17:00–23:00 | A 600-wide window whose center wanders inside [6000, 12000]. An evening might sit near 6,800, then near 10,400. It does not occupy that whole span at once. |
| 23:00–02:00 | Center eases back to 900. |

The window is clamped so it never asks for fewer than 600 or more than 12,000. While the legal box is only 600 wide, the window is that box. While the box is wider, the center walks inside it and the window stays 600 wide.

The integer online count chases the window center with `spring.damp` (`smoothTime` about 180 seconds). It may trail the window by a few minutes. Presence changes are capped at 30 wallets a second, so a dashboard override still glides instead of signing in thousands at once.

Ramp mode aims at the peak window immediately. Its spring uses `ramp.smoothTime` (24 seconds) and `ramp.perSecond` (80). A pin still uses the 30-per-second glide. Sign-in batches are always sliced to a width, including the startup rebind of wallets that lost their session. Base uses `enrollWidth` (32) and then waits `enrollGapMs` (1 second). NEAR uses `rampEnrollWidth` (4) and `rampEnrollGapMs` (8 seconds) in every mode. A NEAR sign-in of a wallet that has never been granted opens a mint, and a wide batch pegs the market. The field names come from the ramp. The limit follows the chain.

Keys are an identity pool, not the live count. `agent/keys.json` only grows, up to 12,000, mode 0600. Dropping to off-peak sleeps wallets. It does not delete keys. The first wallets already in the file stay themselves.

`SWARM_PIN` (or the dashboard pin) replaces the clock with a fixed target for a small local run. Unset, `bun run agent` follows Manila time. The swarm refuses `CHAIN=base`. Real USDC is out of this mode.

## Config

Every number in this plan lives in `agent/config.ts`. The logic modules do not keep a second copy.

The file exports one typed object, `swarmConfig`, in groups that match the layers:

| Group | What you edit |
| --- | --- |
| `clock` | Timezone, Manila phases, window width, floor, ceiling, spring smooth time, presence cap per second, the ramp pace, and how the spare-room noise budget splits across slow wander, fast octave, and tape interest. |
| `presence` | Chronotype offset, hysteresis, visit and gap ranges, how far the tape may stretch or cut a visit, and the arrival bump. |
| `bank` | Floor, cap, seed range, refill pocket, burn pocket. |
| `persona` | Mind shares, second-mind rate, lookbacks, edge, Kelly fraction, bankroll share, noise scale, tempo, burst, refractory gap, moving and flat gate bands, herd cap, and the memory length and step. |
| `stake` | Cent bands and the round-dollar offset. |
| `runner` | Enroll width, ramp enroll width, bet chunk size, order cap, audit slice, bank pass, snapshot interval, and tape-tail length. |
| `timing` | How many past windows feed the price signal, the EWMA and thin-history edge, the streak lean and middle fire slot, virtual pool, wave size, and the loss-streak floor. |

`agent/index.ts` imports that object once and passes each slice in. `director`, `presence`, `bank`, `persona`, `decide`, and `stake` take the slice as an argument. A test uses the shipped object or a smaller one. Changing a knob is an edit to `agent/config.ts` and a restart of the runner.

`checkConfig` runs before the first enroll. Mind shares sum to 1. Every range has its low end first. Each phase window fits inside its legal box. The noise weights fit inside the spare room. Gate bands sit inside 0–1. A failed check stops the process before any wallet signs in.

`agent/control.json` stays the live steering file: follow the clock, hold a phase, ramp to the peak, pin a count, pause betting, bleed on or off. It does not repeat the schedule, the minds, or the bank band. Secrets and `SWARM_PIN` stay in the environment. Market rules that already live in `server/config.ts` (minimum stake, window length, the human grant) are not copied here. The agent reads those from the book.

## Layers

Each layer is a pure function with tests, except the last two, which do I/O. The numbers it uses come from the matching slice of `agent/config.ts`. The defaults below are the values in that file.

### 1. Clock and preference

`agent/director.ts`

Inputs are `now` and the `clock` slice. Output is the envelope, the 600-wide window, and the spring target.

Use `math` (pmndrs, pin `0.1.0`):

- `lerp`, `clamp`, `remap` for the schedule.
- `easing.cubicInOut` on the morning rise and the late decline.
- `simplex2d` plus `fbm` for the evening wander. There is no 1D simplex in this package. Sample `simplex2d` with time on x and a constant on y, then stack octaves with `fbm`.
- `spring.damp` for the online count. One scalar spring, updated with the real delta, not a new spring each tick.
- `mulberry32` only where a decision must be reproducible from a seed.

Noise amplitude is half the spare room inside the current box, so the wander cannot leave [6000, 12000] during peak or leave [600, 1200] off-peak.

That budget is split across three terms. Most of it is the slow evening wander (`fbm` on `simplex2d`). A faster octave, another `simplex2d` sample with time scaled up, roughens the trace so the count is not a single glass curve. A thin slice is interest: positive when recent absolute return is large versus recent volatility, negative when the tape has been flat. Interest only spends spare room. Off-peak the spare room is already tight, so a hot tape at 03:00 stays inside [600, 1,200].

### 2. Who is awake

`agent/presence.ts` reads the `presence` slice.

Every key has a stable chronotype from its index: a personal hour offset of about ±2 hours, plus a slow simplex mood. The mood biases when a visit wants to start. It does not keep the wallet seated by itself.

Each wallet also runs an alternating renewal clock, seeded once:

- A visit length, skewed short with `easing.expoOut`. A few minutes is common. A stay past an hour is rare. The long cap is about 90 minutes.
- A gap after that visit, usually longer than the visit, with the same skew. Outside the wallet's chronotype hours the gap stretches, so a night owl is not also a morning regular.
- Jitter on the start tick so two equal chronotypes do not arrive together.

Session rates are calibrated so the expected number of open visits tracks the spring target across the day. The clock is who wants a chair. The spring is how many chairs exist.

- Under the target: wake wallets whose visit has started, soonest-due first, inside the pace cap (30 a second on the clock, 80 while ramping). If that is not enough, wake wallets whose gap is about to end. Do not pull wallets that are deep in an off-hours gap.
- Over the target: end visits, least sticky first. A visit that already ended is first out. A wallet in the first moments of a visit yields before one that has been seated. Sticky means a visit that still fits the chronotype.
- Hysteresis: once seated, a wallet keeps the chair through small target jitter, about 40 places on the spare list. It still leaves when its visit ends and someone else is due. The same address does not flap every window.

The tape may bend a visit. It may not delete the clock or the chair count.

- A tape that is actually moving stretches the open visit by a capped fraction and can pull the next visit forward a little.
- A long flat stretch, or a personal run of losses, ends the visit sooner by a capped fraction.
- If several similar chronotypes woke in the last minute, a few more of that type may start early. The bump decays within a few minutes and cannot push the count out of the window.
- A boredom leave that would drop the crowd out of the window is backfilled from the almost-due list. People turn over. The room stays at the spring.

Paused addresses and a global betting pause do not change presence. They only stop bets. Sleeping wallets do not sign in, bet, or receive money.

New keys are created only as the high-water mark rises, and only inside the same pace cap.

### 3. Bankroll and bleed

`agent/bank.ts` decides from the `bank` slice. The server moves the tokens.

Every bot balance lives in [$3, $1,000] (3_000_000 to 1_000_000_000 micros) after a money action.

- First time a wallet is enrolled: one seed credit, log-uniform between $8 and $250, drawn with `mulberry32` and `easing.expoOut` so most wallets start small.
- Under $3: mint the gap up to a seeded pocket in [$6, $24]. Once per crossing.
- Over $1,000: burn down to a seeded pocket in [$80, $600]. That is a person taking profits, not a $1 trim off the cap.
- Inside the band: no mint and no burn.

Bots do not receive the human grant ($100 every two minutes). `applyGrant` on `/api/session`, `/api/state`, and `/api/grant` skips `is_bot`.

A bot withdrawal is a burn:

1. Debit the ledger into a pending burn row (same safety idea as a human withdraw).
2. The treasury sends that qmUSDC to `0x000000000000000000000000000000000000dEaD` with the existing `transfer`. The deployed token has `mint` and no `burn`. A dead-address transfer destroys the backing without a redeploy.
3. Mark the row burned. If the transfer fails, refund the ledger the way a reverted withdraw does.

The agent EOA is not paid. Human withdraws still transfer real qmUSDC or USDC to the person.

Bleed is the cap burn plus the pari-mutuel fee, against small floor mints. Winners cash out by burning. Losers come back cheap. The $100 grant must not run on these wallets or the band is impossible.

Dashboard `bleed off` freezes mints and burns for inspection. Betting can continue.

### 4. Each agent tries to win

`agent/persona.ts`, `agent/decide.ts`, and `agent/stake.ts` read the `persona` and `stake` slices.

Personas are seeded once from the wallet index and stored. They are not a shared forecast and they are not told the next print.

A persona holds:

- a mind, seeded once and kept for the life of the key: tape (~35%), fade (~20%), price (~20%), restless (~10%), or streak (~15%)
- for every wallet, a private streak reading used when that mind is streak: how many settled markets count (2, 3, 4, or 5), whether a long enough run is a pullback or a continuation, and a conviction that scales the lean
- momentum weight from about −1 to +1 (tape uses the positive side, fade the negative)
- lookback of 2–12 seconds; a price mind also keeps a slower lookback inside the same tape tail, up to about 90 seconds
- minimum edge before it will bet (near zero only for restless)
- a Kelly fraction and a max share of its own bankroll (about 1–8%, restless capped at the low end)
- a disagreement noise scale (large only for restless)
- a tempo: the typical gap between bets, in windows, skewed so most wallets are slower than the window

The public tape tail is the price input for tape, fade, and price. Decision bars are the last four completed windows inside that tail, or fewer when the feed has not covered them. Streak minds ignore those bars and read the last directional settles on the book (`recent`), oldest first, with voids and pushes left out. An awake wallet still does not bet every window. `decide` runs the tempo gate first. A wallet that passes the gate draws a fire time inside the open window and does not post until that time.

- When a visit starts or a bet lands, draw the next gap from that persona's tempo with `easing.expoOut`. Most gaps cover several windows. A few are short.
- Scale the gap down when the recent move is large versus volatility, and up when the tape is flat. Clamp the scale. A hot tape is not "every window." A flat tape is not "silent for the whole visit."
- After a bet, a seeded burst of 1–3 windows has a higher fire chance, then a refractory gap of at least one tempo draw. Bets show up in flurries, then the wallet watches.
- Jitter the fire with that wallet's own `mulberry32` stream.
- Restless minds use a shorter tempo and still miss most windows.
- On a moving tape, about 5–20% of awake wallets pass the gate. On a flat tape, well under 5%.

Then the mind sets `pUp` from an EWMA of those window returns:

- Tape. A sigmoid of positive momentum times the EWMA z-score, plus private noise. Its fire time sits in the early part of the window.
- Fade. The same sigmoid with the sign flipped. Its fire time sits in the late part of the window, so it sees the pool the early money just filled.
- Price. Near 0.5, plus a small drift from the same z-score. A one-window twitch is not a setup. The pool price is the thing it trades against. It fires late, with fade.
- Restless. 0.5 plus a large private residual, at any time in the window. Stakes stay in the small cent mass.
- Streak. The run at the end of the last directional settles, capped at 5. A run shorter than that wallet's own length is no view, and the wallet skips. A long enough run moves `pUp` off 0.5 by a base lean plus a step per extra market, times that wallet's conviction. About 62% fade the run (four ups, bet down). The rest ride it (four ups, bet up). A flat price tape does not cancel a formed streak. Fire time sits in the middle of the window. The same Kelly path sizes the bet, so a longer run and a higher conviction stake more.

About one in five wallets adds a second mind's term at low weight. Fewer than three bars widens the edge for the price minds. Zero bars makes those minds skip. A streak with no formed run skips even when it has a second mind. A flat tape still puts tape and fade near 0.5, so they skip when the pool is within `crowdGap` of that number. A wider gap, such as an 80/20 pool, cancels the skip and the wallet can take the cheap side.

Against the pool:

- Implied up-price is `up / (up + down)`, or 0.5 when both sides are empty.
- Bet the side where `p` beats the implied price by more than that persona's edge. Otherwise skip.
- The pari-mutuel stake that spends the edge is `s* = (p (U+D+2V) − (U+V)) / (1−p)` on Up, with virtual liquidity `V` on each side so an empty pool has a price. The posted size is the minimum of `s*`, fractional Kelly on the current price times the bankroll, and the persona share cap. A losing streak in the last 32 results scales the Kelly term down. Minimum remains $1. Below $1 the wallet skips until a floor mint.
- Same-side bets shrink as the pool moves toward the belief. Opposite-side bets grow. That is how the wallets bet against each other.

Fire times are seeded from the wallet index and the window id. The runner refetches the book before each wave and posts at most `waveCap` orders, then waits. Inside one wave the orders walk a shadow pool in fire-time order. A wallet that never reaches its fire time does not arm a refractory gap. Both sides fill when personas disagree. A flat and already-fair pool produces a quiet window.

Cap at 800 orders per window. The tempo gate and the edge rule are the real filters. The cap is only a backstop.

Stakes must not pile up on round dollars. After the Kelly size, reshape onto cents:

- Draw with the persona RNG and `easing.expoOut` so the distribution is skewed small: most tickets $1–$8, a minority $8–$40, few above that.
- If the cent string is a round dollar (`x.00`) or a poster amount (`*.00`, `*.50` on a ten), add a seeded cent offset in `±3¢` to `±40¢` that still respects the $1 floor and the wallet balance.
- Send micros. `parseMicros` already accepts up to 6 decimal places. The batch path sends integer micros directly so we do not round back to a dollar.

A wallet bets at most once per window. Same-side adds are not used by the swarm. The other side is a skip.

Local memory of the last 32 personal results nudges that wallet's edge threshold, its tempo, and a tiny bias. The step is capped. A wallet that is wrong becomes pickier and slower. A small seeded share get slightly looser after a win. The crowd does not flip onto one side.

Skip reasons include `waiting`, `refractory`, `flat`, and `no edge`, so a wallet can be awake and visibly choosing not to bet.

No wallet sees a future print, another wallet's private noise, or the settle price.

### 5. Runner

`agent/index.ts` stops being a serial loop of RPC balance reads, `/api/state`, and one `$1` POST.

One Bun process. Batch sizes, the order cap, the audit slice, and the pass intervals come from the `runner` slice.

1. Read `agent/control.json`. Load `swarmConfig` once. Run `checkConfig`.
2. Step the director and presence.
3. Enroll newly awake wallets in parallel, about 16 at a time. One signature per wallet per lifetime. `POST /api/agents/enroll` with `AGENT_SECRET`. The server verifies the signature, inserts `is_bot = 1`, and applies the seed credit. An address that already exists as a human is rejected. A leaked secret cannot take over a person.
4. On each new betting window, one `GET /api/agents/book`: join id, both pools, a tape tail of about the last 90 seconds, and rounds settled since a cursor (strike, settle, fee, pools, winning side). No per-wallet RPC. No `eth_getBalance`. No `balanceOf` on the hot path. Admit the tempo gate then, and store a fire time for each wallet that is due.
5. Replay settlements locally with the shared pure settle function, using the stakes this process recorded. That updates the cached bankroll. A slow audit (`GET /api/agents/balances` for a slice of ~200 addresses every few seconds) corrects drift.
6. Each tick, refetch the book and decide the wallets whose fire time has arrived, against the live pools plus a shadow of this wave. Cap the wave. Slip the overflow one slice later if it still fits in the window.
7. `POST /api/agents/bets` for that wave: `{ address, side, stakeMicros }`. One SQLite transaction per chunk, one `publishRound` after the chunk. Per-row errors do not roll back the rows that passed. The next tick posts the next wave, so one window does not share a single timestamp.
8. Apply bank actions (burn or floor mint) on a 5 second pass, not inside the bet transaction.
9. Write aggregates. Sleep until the next window or the next presence tick, whichever comes first. There is no 1 second pause between wallets.

Sepolia agents do not call the CDP faucet and do not sweep. The ledger is the bankroll.

If a window cannot be posted before it closes, skip it. Late bets are not retried into the next window.

### 6. See it and steer it

`bun run agents` is one OpenTUI screen. It reads chain-scoped agent rows from `data/quick-market.sqlite`.

The runner writes:

- `data/quick-market.sqlite` (gitignored): chain-scoped wallet rows (online, phase, bankroll, last side, last stake, last skip reason, win/loss counts) and a ring of window summaries.
- `agent/swarm.json`: a small snapshot every quarter second (Manila time, window, online, spring target, bets, skips, stake percentiles, balance histogram, mint micros, burn micros, last error, book lag).

The dashboard reads those. It does not parse a 6,000-row `status.json`.

One screen, sized to the terminal:

- Crowd. Manila time, schedule phase, preference window, online versus spring target, arrivals and departures this minute, and an ASCII trace when the terminal is tall enough.
- Book and money. Up and down notional, bot share, skip rate, stake p50 and p90, seed, floor mints, burns, net bleed, and the balance histogram. Side by side when the terminal is wide. The histogram drops out when it is short.
- Roster. The rows that fit. Filters: all, stuck, richest. `j` / `k` move. The selected row shows mind, tempo, visit time left, bankroll, last bet, and why it skipped (`waiting`, `refractory`, `flat`, `no edge`).

Controls, written to `agent/control.json`:

- follow the clock, hold off-peak, hold peak, ramp to the peak, or pin a count
- pause or resume betting for the swarm, and for one address
- bleed on or off
- `q` closes the dashboard and leaves the runner up

`status.json` and `flow.json` remain as the aggregate snapshot and the mint/burn/stake totals so a non-interactive `bun run agents` still prints a page. They are no longer one row per wallet.

## Server, only where the crowd would break the book

Public clients must not receive every bot ticket.

- `board()` keeps pool totals and player counts. The tray lists humans, plus a short bot summary (count and notional per side) and a handful of sample bot rows. The pool disclosure in `web/src/App.tsx` shows that summary instead of hundreds of "Bot" lines.
- The settled websocket event keeps the round result and human payouts. Bot payout rows are left out. The client already looks up the signed-in address. The runner replays its own payouts from the public result.
- `placeBet` stays the human path. `placeBets` is the bot batch: bot flag, open window, live feed, minimum stake, balance, unique `(round_id, address)`.
- Close-round stops calling `youFor` once per bot just to fill a payload nobody renders.

Indexes already exist on `bets(round_id)` and `bets(address)`. Batch inserts use the unique pair so a retried chunk cannot double a stake.

## What changes where

- Add dependency `math@0.1.0`. Import `math` scalars, `math/time`, `math/random`, and `math/noise` only.
- New `agent/config.ts`: the typed `swarmConfig` default and `checkConfig`.
- New pure modules under `agent/`: `director.ts`, `presence.ts`, `persona.ts`, `decide.ts`, `stake.ts`, `bank.ts`, plus tests. Each takes its config slice as an argument.
- Rewrite the hot loop in `agent/index.ts`. Keep key loading, but stop truncating `keys.json` to `AGENT_COUNT`.
- Rewrite `agent/dashboard.ts` and the summary types in `agent/status.ts`.
- `server/grant.ts` and the three grant call sites skip bots.
- `server/rounds.ts` gains the batch bet and the slim tray. Settlement payload drops bot payouts.
- `server/index.ts` gains `/api/agents/enroll`, `/api/agents/book`, `/api/agents/bets`, `/api/agents/balances`, `/api/agents/burn`, `/api/agents/resurrect`. All require `AGENT_SECRET`.
- `server/custody.ts` sends bot burns to the dead address.
- `web/src/App.tsx` renders the bot summary in the existing pool disclosure.
- `agent/README.md` describes the clock, the band, the dashboard keys, the Sepolia-only rule, and `agent/config.ts` as the file to edit.

## Tests

- Config: the shipped object passes `checkConfig`. A share list that does not sum to 1 fails. A presence run given a shorter visit range turns wallets over faster than the same run on the shipped object.
- Director: a Manila 03:00 timestamp yields the window [600, 1200]. A Manila 21:00 timestamp yields a 600-wide window inside [6000, 12000]. Samples from 07:00 to 17:00 move the center upward. A spring stepped across ten minutes of a large gap does not teleport. A hot tape and a flat tape move the target in opposite directions, each inside the spare-room budget, and a 03:00 hot tape stays inside [600, 1200]. Ramp pace from off-peak aims inside the peak box and moves farther in one second than the glide. A pin keeps the glide pace.
- Presence: raising the target wakes that many, and only that many. Hysteresis keeps a wallet seated when the cutoff jitters by a few ranks. A wallet whose visit has ended is first out when the room shrinks, and a wallet whose visit is about to start is first in when a chair is free. A flat tape may shorten visits, and the next due wallets backfill so the count stays inside the window. The same seed repeats arrivals. The key file never shrinks.
- Stakes: across thousands of seeded draws, whole-dollar amounts are rare, nothing is under $1, the median is small, and the same seed repeats. Restless stakes stay in the small cent mass.
- Decide: a rising tape and a cheap up-pool produces an up bet for a tape persona. A fade persona on that tape takes down or skips. A price persona skips the twitch and bets when the pool is off its number. A fair pool produces a skip. Two minds can take opposite sides of the same shadow book. Across a seeded hour, one awake wallet bets in flurries and skips most windows. A moving tape raises the rate and still leaves most awake wallets out of that batch. The same seed repeats.
- Bank: $1,200 burns down into [$80, $600]. $2 mints into [$6, $24]. $40 does nothing. A bot session does not take the $100 grant.
- Batch: one bad row (poor balance) does not reject the good rows. A second post for the same wallet and window does not double the stake.
- Dashboard: the overview renders from a fixture snapshot and does not print thousands of lines.

## Check before calling it done

- `bun test` for the new pure modules and the server batch, grant skip, and burn.
- Run the API and a pinned swarm of about 30 wallets. Confirm a window shows mixed cent stakes, both sides when the tape is moving, skips when it is flat, and a burn when a balance is forced over $1,000. Across several minutes the same address is not awake the whole time, and an awake wallet skips most windows, then bets a short run.
- In the browser, open the pool disclosure and a settlement with the swarm running. Humans still appear as themselves. The list stays short. The signed-in person's result toast still shows their own payout.

## Out of scope

- Mainnet swarm, CDP faucet, and sweeping agent EOAs.
- An LLM per wallet, or any shared model that hands every wallet the same side. The judgment in this plan is the visit clock, the tempo gate, and the mixture of tape, fade, and price rules.
- A new dependency for those rules. They are pure functions on the pinned `math` exports.
- Changing the 5 second window, the human one-bet lock, or the human grant.
- A new token `burn()` and a redeploy. The dead-address transfer is the burn.
- Geometry, IK, and color from `math`. They are the wrong tools here.
