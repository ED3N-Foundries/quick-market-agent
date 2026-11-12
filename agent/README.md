# Agents

`bun run agent` is one Bun process for the whole swarm. It follows Asia/Manila (UTC+8, no daylight saving). The preference window is 300–600 wallets from 02:00 to 07:00, eases up through the morning, wanders inside 3,000–6,000 from 17:00 to 23:00, and eases back overnight. The live count chases that window and can trail it by minutes. Wallets sleep when the room shrinks. Their keys stay.

Each wallet buys in for itself. Stakes are uneven cents, usually a few dollars, sized from the wallet and from the last four windows of tape when that history exists. Inside a buy-in window, tape minds buy earlier and fade and price minds buy later, against the pool those earlier buy-ins just filled. A balance under $3 stays where it is. A balance over $1,000 is withdrawn to that wallet. The runner does not claim the testnet grant.

`SWARM_PIN` pins the online count and bypasses the clock floor, which is how a 30-wallet check runs. Unset, the process follows the clock. The swarm refuses `CHAIN=base`. Real USDC is out of this mode. Sepolia agents do not call the CDP faucet and do not sweep. The ledger is the bankroll.

The runner is one MCP client of `API_URL` + `/mcp`. It signs each wallet in once with the normal login message, keeps the session token, and uses that connection to read the book, place buy-ins, check balances, and withdraw.

Edit `agent/config.ts`. That file is the schedule, the minds, the stake shape, and the runner batch sizes. `agent/control.json` only steers a running swarm: follow the clock, hold off-peak, hold peak, pin a count, pause buy-ins, or freeze mints and burns.

`bun run agents` is the dashboard. It reads `agent/swarm.json` and the active chain's agent rows in `data/quick-market.sqlite`. Closing it leaves the runner up. A non-interactive run prints one page from `agent/status.json` and `agent/flow.json`.

The interactive screen is one OpenTUI view. Crowd, book, and money stay on screen. The roster fills the rows that are left and follows the terminal size. On a wide terminal the book and money sit on one line and the roster shows mind, last buy-in, and W/L. On a short terminal the sparkline and the balance histogram drop out. `?` shows the keys.

Keys:

- `j` / `k` or the arrow keys move the selection. The mouse wheel scrolls it
- `c` follow the clock, `o` hold off-peak, `e` hold peak
- `[` / `]` step the pin by one, `-` / `=` step it by ten
- `b` pause or resume swarm buy-ins, `p` pause or resume the selected wallet, `P` clear wallet pauses
- `m` bleed on or off, `f` cycle all, stuck, and richest
- `s` asks to start the runner when it is quiet. `R` asks to restart it when it is live. `y` confirms and `n` cancels. Opening this screen does not start a runner.
- `q` closes the dashboard
