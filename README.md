# RUNUP.FUN — public-curve sniper

Sniper for [runup.fun](https://runup.fun) — a token launchpad on **Injective EVM** where each coin
runs a pump.fun-style bonding curve, paired with stock perpetuals (RFQ). This bot fires a buy the
instant a coin's **public curve opens** (phase 0 → 1).

## How runup.fun works (V4)

Two contract layers, both **UUPS upgradeable**:

| Layer | Contract | Role |
|------|----------|------|
| Factory | `LaunchpadFactory` | `count()`, `launches(i)`, `launch(...)`; emits `CoinLaunched(index, creator, market, token, vault, schedule, adapter, marketId, short, leverage, profile, preset)` |
| Market | per-coin `Market` | the bonding curve + trade engine |
| Vault | per-coin `Vault` | perp treasury (strategy cash, buybacks, burn) |
| Adapter | per-coin `Adapter` | RFQ/perp execution |

### Lifecycle of a coin

1. **FOUNDING** (`phase == 0`) — a ticket round. `TICKET` (quote per ticket, e.g. 20 USDC) and
   `TICKET_TOKENS` (tokens per ticket) are fixed; wallets call `subscribe()` → `TicketPurchased`.
   For RUNNER: **333** tickets @ **$23,885 FDV**, round open ~90 min.
2. **ACTIVE** (`phase == 1`) — **the public curve opens** (`CurveOpened` event). Anyone can `buy` /
   `sell` against the virtual-reserve constant-product curve:
   - `tokenOut = pairInNet * effToken / (effPair + pairInNet)`
   - `pairOut  = tokenIn   * effPair  / (effToken + tokenIn)`
   - `effPair = virtualPair + realQuote`, `effToken = virtualToken − realTokens`
3. **GRADUATED** (`phase == 2`) — when `realQuote ≥ graduationQuote` (RUNNER: **$81K** breakout).
   Capital splits 85% → LP (paired with the token reserve) / 15% → perp treasury; the treasury runs
   a fixed strategy (RUNNER: `$INJ · LONG · 2×`); profits → buyback & burn.

### Trade API (Market)

```solidity
buy(uint256 maximum, uint256 minimum, address recipient, uint256 deadline, bool expectedActive)
    returns (uint256 spent, uint256 out)
sell(uint256 input, uint256 minimum, address recipient, uint256 deadline, bool expectedActive)
    returns (uint256 out)
quoteBuy(uint256 maximum) returns (uint256 spent, uint256 out, uint256 fee, bool graduates)
quoteSell(uint256 input)  returns (uint256 out, uint256 fee)
phase() -> uint8   // 0 founding | 1 active | 2 graduated
active() -> bool
opening() -> uint256   // unix ts the curve opens
```

`buy` pulls the quote asset (USDC) via `transferFrom` → **you must `approve` the market first**
(this bot does it automatically).

## The sniper

`src/sniper.mjs` (Node + [viem](https://viem.sh)). It:
- resolves the factory (from `--factory`, `.env`, or the app's Convex config),
- **pre-arms** a signed `buy` per wallet (nonce + fees + gas estimated once),
- triggers on the **curve open** through four racing layers (first to fire wins):
  1. **WS `logs`** — subscribes to the market's `CurveOpened` event over WebSocket → fires the
     instant the log lands (fastest).
  2. **WS `newHeads`** — re-checks `phase()` on every new block (belt & braces / reconnect safety).
  3. **timer** — if `opening()` is known, fires `LEAD_MS` before it.
  4. **poll** — HTTP `phase()` poll at `POLL_MS` (always-on fallback; `--no-ws` uses only this).
- auto re-signs on a stale nonce, supports multi-wallet + blast, and has a `DRY_RUN`.

### Commands

```bash
node src/sniper.mjs config                          # show live V4 config (Convex catalog:get)
node src/sniper.mjs scan   --factory 0x..           # list coins
node src/sniper.mjs monitor --market 0x..           # live market state
node src/sniper.mjs watch  --factory 0x..           # watch CoinLaunched + phases
node src/sniper.mjs snipe  [--market 0x..] [--factory 0x..] [--dry]
```

### Config

Copy `.env.example` → `.env`. Key vars: `RPC_URL`, `WS_URL`, `FACTORY`, `MARKET`, `PRIVATE_KEYS`
(comma-sep), `AMOUNT`, `SLIPPAGE_BPS`, `MAX_FEE_GWEI`, `PRIORITY_GWEI`, `POLL_MS`, `LEAD_MS`,
`OPEN_DELAY_S` (public curve = `opening()` + this; 3600 for a founding market), `DEADLINE_S`
(buy/sell tx deadline in seconds — must cover the wait when pre-arming a snipe early), `DRY_RUN`, `BLAST`.

### WebSocket

The sniper uses `wss://sentry.evm-ws.injective.network` (mainnet) by default for instant event
triggers. Override with `--ws wss://..` or `WS_URL`; disable with `--no-ws` (HTTP polling only). The
WS transport auto-reconnects (`retryCount: 8`), and the poll + timer layers keep working even if the
socket drops, so a missed log never means a missed snipe.

### Multi-RPC failover

Set `RPC_URLS` (or `--rpcs a,b`) to a comma-separated list — the first is primary, the rest are
automatic failover via viem's `fallback` transport (rotates on transport *and* JSON-RPC errors, e.g.
a backend that rejects `eth_*`). Useful for dRPC's `network=injective` endpoint, which serves Injective
EVM but intermittently routes to a Cosmos-only backend ("method does not exist"). Example:
`RPC_URLS=https://sentry.evm-rpc.injective.network/,https://lb.drpc.org/ogrpc?network=injective&dkey=...`

### Run

```bash
npm install
cp .env.example .env      # fill PRIVATE_KEYS etc.
# dry run first:
DRY_RUN=true node src/sniper.mjs snipe --market 0xTHE_MARKET
# live:
node src/sniper.mjs snipe --market 0xTHE_MARKET
```

### Wallets + funding

Generate N fresh wallets (writes `wallets.json` + `wallets.env`, prints only addresses):

```bash
node src/genwallets.mjs --count 10
```

Fund them from one funder wallet (USDC + native INJ for gas), sequentially, with a balance pre-check:

```bash
# dry first
node src/fund.mjs --funder 0xKEY --wallets wallets.json --usdc 20 --inj 0.05 --dry
# live
DRY_RUN=false node src/fund.mjs --funder 0xKEY --wallets wallets.json --usdc 20 --inj 0.05
```

- `--usdc 20` per wallet, `--inj 0.05` gas per wallet (both configurable).
- Targets come from `--keys k1,k2`, `--wallets file.json`, or `PRIVATE_KEYS`.
- Checks the funder's USDC/INJ totals first and warns if short.
- Override the USDC token with `--usdc-token` / `--usdc-decimals` (defaults to Injective USDC, 6dp).

### New-token alerts

Watch the factory for `CoinLaunched`, enrich each launch on-chain, and push a formatted alert to
Telegram (@digidawbbot → langris DM):

```bash
node src/alerts.mjs --test        # send one sample launch alert now, exit
node src/alerts.mjs --test-surge  # send one sample MC-surge alert now, exit
node src/alerts.mjs --once        # backfill existing launches, exit
node src/alerts.mjs               # WS + poll, live (run in screen)
node src/alerts.mjs --no-surge    # disable the MC-surge watcher
# run detached:
screen -dmS runup-alerts
screen -S runup-alerts -X stuff 'cd /root/runup-sniper && node src/alerts.mjs >> alerts.log 2>&1\n'
```

- Token read from `TELEGRAM_BOT_TOKEN` (or `~/.hermes/.env`); target = `TELEGRAM_CHAT_ID` (default langris).
- Alert shows: name/symbol, **description + artwork** (from the token's on-chain `metadataURI()` JSON), market
  + token + creator addresses, **market cap + unit price**, ticket price + tokens, graduation target,
  leverage/preset/fee, founding-open time, and runup.fun + explorer links.
- **Token metadata is on-chain**: RUNUP coins carry a JSON string in the token's `metadataURI()` getter —
  `{"image":"https://…","description":"…","avatar":"rocket"}` (description ≤ 240 chars, JSON ≤ 1024 bytes).
  There is **no website/socials field** in the schema. `sniper.mjs` exposes it too: `monitor` adds
  `tokenName/tokenSymbol/description/image/avatar`, `scan` prints name + description.
- **MC-surge watcher**: polls every market's market cap (`ALERT_SURGE_POLL_MS`, default 30s) and fires a
  `🚀 MC SURGE` alert when it rises ≥ `ALERT_SURGE_PCT`% (default 25) within `ALERT_SURGE_WINDOW_MS`
  (default 5m), above `ALERT_SURGE_MIN_MC` (default $500). Per-market cooldown = one window.
  The alert is **metadata-enriched**: token name + `$symbol`, MC move + a `<code>` sparkline, price
  (USDC/tok), phase, founding progress (`ticketsSold/founderCount`) or curve progress
  (`realQuote/graduationQuote` → % to graduation), fee, and market/token/creator + links.
- **Founding / curve watcher**: polls every market (`ALERT_CURVE_POLL_MS`, default 8s) and alerts on
  founding milestones (90% / sold out) and the phase 0→1 flip (🔓 curve open) — catches an **early open**
  on sell-out.

### Unified realtime watcher (frontend + on-chain)

Watch runup.fun's SPA bundle **and** the on-chain state in realtime, alerting on ANY change — the fastest
signal that a new launch time / factory / market is coming:

```bash
node src/sitewatch.mjs --test        # send one sample alert, exit
node src/sitewatch.mjs --once        # snapshot once, print, exit
node src/sitewatch.mjs               # baseline then watch live (run in screen)
screen -dmS runup-sitewatch
screen -S runup-sitewatch -X stuff 'cd /root/runup-sniper && node src/sitewatch.mjs >> sitewatch.log 2>&1\n'
```

- **Frontend**: index bundle hash change (🚀 redeploy), lazy chunk set changes, Convex `catalog:get`
  going `null → live` (🏭 factory live), new deployment addresses in the `v4Curve` chunk.
- **On-chain**: `factory.count()` increase (🪙 new launch + market/token), tracked market phase change
  (🔓 0 founding → 1 active = curve open), and `opening()` change (🕐 **new launch time**).
- Baseline persisted to `.sitewatch.state.json` (gitignored) so restarts don't re-alert.
- Flags/env: `SITE`, `--interval N` (s), `--no-convex`, `--no-chain`, `--chat ID`.

### Manual buy / sell

```bash
node src/sniper.mjs buy  --amount 20            # buy on MARKET with every wallet (per-wallet amount honored)
node src/sniper.mjs buy  --json                 # machine-readable JSON instead of the table
node src/sniper.mjs sell                        # sell ALL tokens from every wallet
node src/sniper.mjs sell --tokens 1000          # sell a fixed token amount
```

- `buy` uses `quoteBuy` for the min-out slippage guard; `sell` approves the token then uses `quoteSell`.
- Both print a color table (`# / wallet / amount / min-out / result`) + a summary line
  (`n/n · spent X USDC · got Y tok · avg P USDC/tok · gas G INJ · MC $A → $B`); `--json` emits raw results.
- **Market cap** = `price() × totalSupply` (price() is 18-decimal USD/token, supply = 1e9 → `MC = price/1e9`,
  mirroring the site). Shown in the banner (current) and the summary (after, live) for buy/sell; also in
  `scan`, `monitor` (`marketCap`/`unitPrice`/`totalSupply` fields) and every new-token alert.
- Both respect `DRY_RUN`, `SLIPPAGE_BPS`, and `--market` / `MARKET`.
- Colored output auto-disables when piped / `NO_COLOR` set.
- `node src/sniper.mjs wallets` shows per-wallet readiness **and position**: `# / wallet / buy / USDC /
  INJ / tokens / value / appr` plus a `holdings … · value …` footer (token balance × unit price).

## Network

| | Value |
|---|---|
| Injective EVM mainnet chainId | **1776** (native `injective-1`) |
| RPC | `https://sentry.evm-rpc.injective.network/` |
| WS | `wss://sentry.evm-ws.injective.network` |
| Explorer | `https://blockscout.injective.network` |
| USDC (V4 quote) | `0xa00C59fF5a080D2b954d0c75e46E22a0c371235a` |
| **V4 LaunchpadFactory** | `0xef1a648373dC19072D692429B704Bb63cf597950` (UUPS proxy, impl `0xAA0306726d4CE46410eEF0a43Cf2596014d27d2a`) |
| Injective EVM testnet chainId | 1439 (native `injective-888`) |

### Live coins (launch #0 = $RUNNER)

| | Value |
|---|---|
| Token | `0xe2906863a4Dc9261B1D0c25b5EF983C84130D893` (RunUp / RUNNER, 1B) |
| Market (curve) | `0x8399aF15A225314d7bE75BEeBf1E83D001380074` |
| Vault | `0x602E8b57c9F0f008eC941c71f955730Da239680F` |
| Schedule | `0x82fB91b6Fc3F150148112c34D29eF0dDB735a477` |
| Adapter | `0x413f62dFdcDC46a462dA7f7cb1FBD283dc5f6643` |
| Creator | `0x8284476327Db79dd37d682A64968c8155A4C770E` (Safe) |

`TICKET` = 20 USDC · `TICKET_TOKENS` ≈ 826,446 · `preset` 3 · `FEE_BPS` 130 · leverage 2×.
The factory is **live now**; the app's Convex `catalog:get` may lag until the UI cuts over, so the bot
takes the factory from `.env`/`--factory`.

## Test

`test/run_e2e.sh` spins up anvil, deploys a mock Market, and proves the sniper fires on the
phase 0 → 1 flip (asserts `realQuote` / `realTokens` moved on-chain).

```bash
bash test/run_e2e.sh
```
