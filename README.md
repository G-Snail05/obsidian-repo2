# @obsidian/market-data
Shared crypto market-data client for Obsidian Division.
## Setup
Providers: CoinGecko, DexScreener, Birdeye, Hyperliquid. Optional tokens in .env.example.
Install deps, then build with tsc.
CLI examples: obsidian-market spot btc | ohlc eth | perps SOL

## Alert watcher (`obsidian-market watch`)

Long-running process that watches spot prices and the Aave V4 health factor and POSTs alerts to a webhook (Mr. Digit's alert routine).

- **Prices:** Coinbase public WebSocket ticker (`wss://ws-feed.exchange.coinbase.com`, `ZEC-USD` etc.). Auto-reconnects with jittered exponential backoff. If any symbol has no Coinbase tick for `STALE_SEC`, Hyperliquid `allMids` (`POST /info`, every 5 s) fills in for that symbol until Coinbase is fresh again. Symbols with no tick from either source are logged as `STALE`.
- **Alerts:** `alerts.json` (gitignored; copy `alerts.example.json`). Hot-reloaded on change. An invalid file is logged and the last good config is kept. Crossing semantics: an alert fires when price moves from the not-triggered side to `>= level` (above) or `<= level` (below). It does not fire again until price crosses back (re-arm). `cooldownMin` (default 30) suppresses re-fires, and `oneShot` disables the alert after it first fires. No alert fires at startup just because price is already beyond the level.
- **Health factor:** `getUserAccountData(AAVE_USER)` on the Aave V4 Main Spoke `0x94e7a5dcbe816e498b89ab752661904e2f56c485` (HF is WAD), via plain `eth_call`. It uses `RPC_URL` if set, otherwise the Etherscan V2 proxy with `ETHERSCAN_API_KEY`. It polls every `HF_POLL_MIN` (5) minutes. States are ok / warn (< `HF_WARN` 1.3) / critical (< `HF_CRITICAL` 1.2). To leave a state the HF must climb `HF_HYSTERESIS` (0.02) above the threshold. Alerts are sent on escalation and recovery, plus a reminder every `HF_REPEAT_MIN` (60) minutes while in warn/critical.
- **Heartbeat:** daily at `HEARTBEAT_AT` (09:00 Europe/London) with the status of each feed and the HF.

### .env keys

| Key | Default | Meaning |
|---|---|---|
| `WEBHOOK_URL` | unset → **dry-run** | Routine address. If unset, payloads are only logged and appended to `.watch/dry-run.jsonl`. |
| `WEBHOOK_KEY` | unset | Sender key. |
| `WEBHOOK_KEY_HEADER` | `Authorization: Bearer <key>` | Header template; `<key>` is replaced. **Confirm the exact format in the routine's panel**, e.g. `X-Sender-Key: <key>`. |
| `AAVE_USER` | `0x6951…B1e0` | Address whose HF is watched |
| `AAVE_SPOKE` | Main Spoke | Spoke contract |
| `RPC_URL` | unset (Etherscan proxy) | Ethereum JSON-RPC endpoint |
| `HF_WARN` / `HF_CRITICAL` / `HF_HYSTERESIS` / `HF_REPEAT_MIN` / `HF_POLL_MIN` | 1.3 / 1.2 / 0.02 / 60 / 5 | HF thresholds and timing |
| `WATCH_SYMBOLS` | `ZEC,ETH,BTC,NEAR` | Symbols to watch |
| `STALE_SEC` | 60 | Seconds without a tick before a feed counts as stale |
| `HEARTBEAT_AT` | `09:00` | London time of the daily heartbeat |
| `ALERTS_FILE` / `WATCH_STATE_DIR` | `./alerts.json` / `./.watch` | Paths |

Payload fields: `type` (`price|hf|heartbeat|watcher_error`), `symbol`, `price`, `level`, `op`, `note`, `source`, `alertId`, `time` (ISO UTC), `timeLondon`.
Failed sends are retried with backoff (5 retries, 2 s doubling). 4xx responses other than 429 are not retried.

### Managing alerts (for Mr. Digit)

```bash
node dist/cli.js alert add ZEC above 60 --note "breakout" --cooldown 30 [--once] [--id my-id]
node dist/cli.js alert list [--json]
node dist/cli.js alert disable <id>   # / enable <id>
node dist/cli.js alert remove <id>
```
Writes are atomic (temp file + rename), and the running watcher picks them up within about 1 to 2 s.

### Running and keeping it alive

There's no systemd or pm2 on the box, so `scripts/watchd.sh` is a small bash supervisor. It starts the watcher detached with `setsid nohup`, so it survives shell exit. It restarts the watcher on exit with backoff (2 s doubling to 120 s), writes PID files, and rotates the log at 10 MB.

```bash
npm run build
scripts/watchd.sh start     # build + start detached
scripts/watchd.sh status    # PIDs + .watch/status.json (feeds, HF, alerts)
scripts/watchd.sh logs 100  # tail .watch/watch.log
scripts/watchd.sh stop      # / restart
node dist/cli.js watch --once         # self-test: feeds, HF, alerts file, sample payload
node dist/cli.js watch --once --send  # ...and actually POST the test heartbeat
```
After changing `.env`, run `scripts/watchd.sh restart`. The supervisor does not come back by itself after a full machine reboot, so run `start` again.

## Paper trading

A practice ledger for Mr. Digit. Fills use live Coinbase public best bid/ask (long buys at ask / sells at bid, short the reverse), plus Coinbase Advanced taker fee and slippage on every fill. State lives in `.paper/` (gitignored): `ledger.json` plus an append-only `journal.jsonl` (opens, rejections, fills, auto-closes, manual closes, resets).

```bash
# open (market or limit). All fields required. Exit code 2 + reason if rejected.
node dist/cli.js paper open --symbol ETH --side long --entry market --stop 2300 --target 2700 \
  --thesis "reclaim of 2350 with rising OI" --invalidation "daily close < 2300" --confidence 3
node dist/cli.js paper open --symbol BTC --side short --entry 84500 --stop 86500 --target 78000 \
  --thesis "..." --invalidation "..." --confidence 2      # resting limit; watcher fills it when touched

node dist/cli.js paper list [--all] [--json]
node dist/cli.js paper close P1          # market close (or cancel a pending limit)
node dist/cli.js paper stats [--no-live] # win rate, avg R, expectancy, PnL, equity, max DD, open risk, graduation
node dist/cli.js paper journal -n 50
node dist/cli.js paper reset --confirm   # archives ledger.json to ledger.json.bak-<ts>
npm run paper:smoke                      # CLI smoke test with mocked prices in a temp dir
```

**Hard limits (enforced in code, rejected with a reason):**

| Rule | Default | Env override |
|---|---|---|
| Starting balance | $10,000 (fixed at ledger creation) | `PAPER_START_BALANCE` |
| Risk per trade (position auto-sized from stop distance incl. fees/slippage) | 1% of equity | `PAPER_RISK_PCT` |
| Max open + pending positions | 3 | `PAPER_MAX_OPEN` |
| Daily halt: today's realized loss (UK day) reaches | 3% of start-of-day equity | `PAPER_DAILY_HALT_PCT` |
| Min reward:risk **after round-trip taker fees + slippage** | 2:1 | `PAPER_MIN_RR` |
| Taker fee per side | 0.6% | `PAPER_TAKER_FEE_PCT` |
| Slippage per fill | 5 bps | `PAPER_SLIPPAGE_BPS` |

Also rejected: missing thesis/invalidation, confidence not 1-5, stop/target on the wrong side, marketable limits, notional above equity (no leverage).

**Watcher integration:** `watch` polls Coinbase bid/ask every `PAPER_POLL_SEC` (5s) for symbols with open/pending paper positions, fills touched limits, auto-closes on stop or target, journals it and sends a `type: "paper"` webhook through the normal delivery path (dry-run if `WEBHOOK_URL` is unset).

**Graduation flag** (`paper stats`): ≥30 closed trades, positive average R, max drawdown < 10%.
