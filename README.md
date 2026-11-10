# Quick Market Agent

Swarm runner and terminal dashboard for Quick Market. Split out of
`ED3N-Foundries/quick-market` on 2026-11-10 so the market repo holds no
runner code. This repo is private.

One Bun process keeps a crowd of durable wallets whose size glides between a
few hundred and a few thousand. Each wallet buys in for itself. Surplus over
$1,000 is burned. Balances under $3 are refilled. `AGENT_SECRET` authorizes
the runner against the server. The swarm refuses `CHAIN=base`.

## Run

```bash
bun install
bun test
CHAIN=base-sepolia API_URL=http://127.0.0.1:3001 DB_PATH=data/quick-market-agent.sqlite bun run agent
```

`bun run agents` is the terminal dashboard. It reads `agent/swarm.json` and
the agent rows in `DB_PATH`. A non-interactive run prints one page. Closing
the dashboard leaves the runner up.

Copy `.env.example` to `.env`. `CHAIN` and the market preferences
(`WINDOW_SECONDS`, `MARKET_SECONDS`, `VIEW_SECONDS`, `FEE_BPS`,
`PRICE_SOURCE`) must match the server. `API_URL` is the server origin
(`http://quick-market:3001` in compose). `DB_PATH` is this runner's own
SQLite file, not the server ledger.

## Server contract

The server keeps the bot API; this runner is its only client:

- `GET /api/agents/book`, `GET /api/agents/balances`
- `POST /api/agents/enroll`, `POST /api/agents/buy-ins`
- `POST /api/agents/burn`, `POST /api/agents/resurrect`

All require `x-agent-secret: AGENT_SECRET`.

## Layout

- `agent/` runner, dashboard, and `control.json` steering file
- `shared/` chain, login, market, NEAR helpers (vendored from quick-market)
- `server/` env, market wrappers, SQLite open/tune, pure settle, and
  read-only NEAR treasury inspection (vendored/forked from quick-market)

`server/db.ts` keeps the full schema so the copied `importLegacySwarm`
still runs; only the agent tables are used here. `server/nearInspect.ts`
is the read-only fork of the server's NEAR module: no ledger writes, no
custody polling, no transaction submission. Mints and burns go through the
server API.

## Config

Edit `agent/config.ts`. That file is the schedule, the minds, the stake
shape, and the runner batch sizes. `agent/control.json` only steers a
running swarm: follow the clock, hold off-peak, hold peak, pin a count,
pause buy-ins, or freeze mints and burns.
