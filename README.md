# Quick Market Agent

Swarm runner and terminal dashboard for Quick Market. Split out of
`ED3N-Foundries/quick-market` on 2026-11-10 so the market repo holds no
runner code. This repo is public.

For the simplest NEAR Testnet demo, clone this repo beside `quick-market`
and `quick-market-health`, install each repo, and run `bun run demo` from the
market repo. That launcher supplies this runner's environment automatically.
See the [main judge guide](https://github.com/ED3N-Foundries/quick-market#run-the-complete-demo-locally).

One Bun process keeps a crowd of durable wallets whose size glides between a
few hundred and a few thousand. Each wallet buys in for itself. Surplus over
$1,000 is withdrawn to that wallet. Balances under $3 stay put. The runner
does not call `claim_grant`. The first sign-in still takes the market's
testnet grant. The swarm refuses `CHAIN=base` (real USDC).

`AGENT_SPLIT_BASE` and `AGENT_SPLIT_NEAR` are whole numbers that sum to 100.
They divide that one crowd between Base Sepolia and NEAR testnet. A share of
0 leaves that market idle. The same process opens one MCP session per market
that has a share. NEAR wallets use `NEAR_TREASURY_PRIVATE_KEY` and
`agent/keys.near.json`. Buy-ins are ledger sessions, so an implicit account
can bet before it holds on-chain NEAR.

## Run

```bash
bun install
bun test
CHAIN=base-sepolia AGENT_SPLIT_BASE=50 AGENT_SPLIT_NEAR=50 API_URL=http://127.0.0.1:3001 DB_PATH=data/quick-market-agent.sqlite bun run agent
```

`bun run agents` is the terminal dashboard. It reads `agent/swarm.json` and
the agent rows in `DB_PATH`. A non-interactive run prints one page. Closing
the dashboard leaves the runner up.

Copy `.env.example` to `.env`. `CHAIN` and the market preferences
(`WINDOW_SECONDS`, `MARKET_SECONDS`, `VIEW_SECONDS`, `FEE_BPS`,
`PRICE_SOURCE`) must match the server. `API_URL` is the server origin
(`http://quick-market:3001` in compose). `DB_PATH` is this runner's own
SQLite file, not the server ledger.

The runner listens on `STATS_PORT` (default `3011`, `0` turns it off) and
answers `GET /api/health` with the latest swarm snapshot: counts, phase,
stake percentiles, money totals, and the last error. Compose does not
publish that port. The body has no wallet keys and no addresses.
`quick-market-health` reads it on the docker network.

## Server contract

The runner is an MCP client of `API_URL` + `/mcp?chain=`. One long-lived
session. Inside compose that URL is `http://quick-market:3001/mcp?chain=`.

- Sign each wallet in once. The wallet signs the normal login message,
  `sign_in` opens the session, and the token stays in this database.
- `book` and `rounds` feed the local payout replay. `FEE_BPS` stays here.
- Each wave is `place_buy_ins`, up to 200 orders.
- Drift is corrected with `account` on the signed-in wallets, in slices.
- Surplus leaves through `withdraw`, which debits the ledger and pays the wallet.
- The runner does not call `claim_grant`. A new wallet's first sign-in takes the normal grant.

## Layout

- `agent/` runner, dashboard, and `control.json` steering file
- `shared/` chain, login, market, NEAR helpers (vendored from quick-market)
- `server/` env, market wrappers, SQLite open/tune, pure settle, and
  read-only NEAR treasury inspection (vendored/forked from quick-market)

`server/db.ts` keeps the full schema so the copied `importLegacySwarm`
still runs; only the agent tables are used here. `server/nearInspect.ts`
is the read-only fork of the server's NEAR module: no ledger writes, no
custody polling, no transaction submission. Buy-ins and withdrawals go
through the public MCP server.

## Config

Edit `agent/config.ts`. That file is the schedule, the minds, the stake
shape, and the runner batch sizes. `agent/control.json` only steers a
running swarm: follow the clock, hold off-peak, hold peak, ramp to the peak, pin a count,
pause buy-ins, or freeze mints and burns.
