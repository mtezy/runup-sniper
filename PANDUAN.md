# RUNUP.fun — Panduan Sniper & Alert (Injective EVM)

Dokumentasi lengkap tooling di `/root/runup-sniper`. Dibuat untuk runup.fun (launchpad token di
Injective EVM, gaya pump.fun). Chain **1776 = Injective EVM mainnet**.

> Recon mentah ada di `/root/runup_recon` (source `LaunchpadCore.sol`, ABI, bundle JS).

---

## 0. TL;DR (cheat sheet)

```bash
cd /root/runup-sniper

node src/sniper.mjs config          # tampilkan config aktif
node src/sniper.mjs scan            # daftar semua coin di factory (+MC)
node src/sniper.mjs monitor         # state 1 market (JSON, +marketCap)
node src/sniper.mjs wallets         # tabel wallet: saldo + posisi + approval
node src/sniper.mjs approve         # approve USDC → market (semua wallet)
node src/sniper.mjs buy  --amount 20
node src/sniper.mjs sell
node src/sniper.mjs snipe           # race curve-open (WS + timer + poll)

node src/alerts.mjs                 # watcher token baru + surge (screen)
node src/alerts.mjs --test          # kirim 1 sample alert launch
node src/alerts.mjs --test-surge    # kirim 1 sample alert MC surge
```

Default **`DRY_RUN=true`** — selalu cek `--dry` dulu, baru `DRY_RUN=false`.

---

## 1. Arsitektur & alamat (mainnet 1776)

| Item | Alamat / Nilai |
|---|---|
| Chain | 1776 (Injective EVM, native `injective-1`) |
| RPC utama | `https://sentry.evm-rpc.injective.network/` |
| WS | `wss://sentry.evm-ws.injective.network` |
| Explorer | `https://blockscout.injective.network` |
| USDC (quote, 6dp) | `0xa00C59fF5a080D2b954d0c75e46E22a0c371235a` |
| **V4 LaunchpadFactory** | `0xef1a648373dC19072D692429B704Bb63cf597950` (UUPS, impl `0xAA0306726d4CE46410eEF0a43Cf2596014d27d2a`) |
| RUNNER token | `0xe2906863a4Dc9261B1D0c25b5EF983C84130D893` |
| RUNNER market | `0x8399aF15A225314d7bE75BEeBf1E83D001380074` |
| creator/Safe | `0x8284476327Db79dd37d682A64968c8155A4C770E` |

### Lifecycle market
```
phase 0  FOUNDING   → tiket 20 USDC, max 333 slot (subscribe())
phase 1  ACTIVE     → public bonding curve (event CurveOpened)   ← target snipe
phase 2  GRADUATED
```
- `opening()` = **mulai founding**; public curve = **`opening() + OPEN_DELAY_S`** (founding 1 jam).
- Untuk RUNNER: founding `2026-10-01 15:30 UTC` → public `16:30 UTC`.

### Math curve (mirror dari bundle)
- `tokenOut = net × effToken / (effPair + net)`, `effPair = virtualPair + realQuote`,
  `effToken = virtualToken − realTokens`
- Min beli = `MIN_TRADE = 10000` (0.01 USDC). **V4 tak ada cap max** (oversize = cap-and-refund ke graduation).
- Kapasitas curve RUNNER ≈ 13,638 USDC (0 founder) → 24,842 USDC (333 founder).

---

## 2. Struktur file

```
/root/runup-sniper/
  src/
    sniper.mjs      CLI utama: config|scan|monitor|wallets|approve|buy|sell|watch|snipe
    alerts.mjs      watcher token baru (CoinLaunched) + MC-surge → Telegram
    abi.mjs         FACTORY_ABI, MARKET_ABI, ERC20_ABI
    curve.mjs       readMarketCap(pub, market)  → {priceRaw, unit, supply, cap}
    fmt.mjs         warna, tabel (cols), angka (num/usd/tok), mcap()/mcapMove()
    notify.mjs      kirim Telegram (@digidawbbot)
    fund.mjs        funder → wallet (USDC + gas INJ)
    genwallets.mjs  generate N wallet EOA
    convex.mjs      auto-discovery factory dari backend app
  test/
    Mock.sol        MockQuote + MockToken + MockMarket (punya price(), CurveOpened)
    run_e2e.sh / run_e2e_nows.sh / run_fund_e2e.sh / run_buysell_e2e.sh
  .env              config live (JANGAN commit)
  .env.example      template
  README.md         dokumentasi teknis
  wallets.json      daftar wallet (alamat)
  alerts.log        log watcher
```

---

## 3. Command `sniper.mjs`

### `wallets` — saldo + posisi + approval
Tabel: `# / wallet / buy / USDC / INJ / tokens / value / appr`
- `buy` = amount per-wallet (dari `PRIVATE_KEYS` `KEY:AMOUNT`)
- `tokens` = saldo token market; `value` = `tokens × harga` (USD live)
- Footer: `N/N ready · holdings X tok · value $Y`
- `appr` = allowance USDC → market (yes/no)

### `approve` — approve USDC ke market (semua wallet)
Wajib sebelum `buy` (buy auto-approve juga, tapi ini bisa pre-approve).

### `buy` — beli token
```bash
node src/sniper.mjs buy                        # per-wallet amount
node src/sniper.mjs buy --amount 50            # override semua wallet
node src/sniper.mjs buy --market 0x.. --amount 20
node src/sniper.mjs buy --dry                  # preview (default DRY_RUN=true)
node src/sniper.mjs buy --slippage 500         # 5% (default 3000 bps = 30%)
node src/sniper.mjs buy --json                 # output JSON (mcBefore/mcAfter/results)
DRY_RUN=false node src/sniper.mjs buy          # live
```
Output: banner (`▲ BUY · phase · active · MC $X · N wallets · slip`) + tabel
(`# / wallet / amount / min-out / result`) + summary
(`n/n · spent · got · avg USDC/tok · gas INJ · MC $A → $B`).

### `sell` — jual token
```bash
node src/sniper.mjs sell                       # jual SEMUA token tiap wallet
node src/sniper.mjs sell --tokens 1000         # jual jumlah tertentu
node src/sniper.mjs sell --market 0x.. --tokens 5000
node src/sniper.mjs sell --dry
DRY_RUN=false node src/sniper.mjs sell
```
Auto-approve token → market, pakai `quoteSell` buat min-out.

### `scan` / `monitor`
```bash
node src/sniper.mjs scan        # #i market phase active opening mc token lev
node src/sniper.mjs monitor     # JSON: phase, price, marketCap, unitPrice, totalSupply, ...
```

### `snipe` — race curve-open
3 lapis trigger (pertama menang, guard `fired`):
1. WS `logs` → `CurveOpened`
2. WS `newHeads` → re-check `phase()`
3. Timer `opening()+OPEN_DELAY_S − LEAD_MS`
4. HTTP poll `phase()` (fallback; `--no-ws` = poll only)

Multi-wallet paralel, pre-arm signed tx, re-sign kalau nonce stale.

---

## 4. Market Cap

```
marketCap = price() / 1e18 × totalSupply
          = price() / 1e9        (supply RUNUP = 1e9 token; mirror bundle situs)
```
- `price()` = harga 18-desimal USD/token (getter di market)
- Format ringkas: `$23.9K`, `$1.24M`, `$3.10B`
- Muncul di: `buy`/`sell` (banner + summary before→after), `scan`, `monitor`, `alerts`

Contoh (RUNNER): `price = 23885400000000` (18dp) → unit `0.0000239 USDC/tok` → **MC $23.9K**.

---

## 5. Alerts (`alerts.mjs`)

Watcher jalan di **screen `runup-alerts`**, kirim ke **DM langris** via bot **@digidawbbot**.

### Cara jalan
```bash
screen -dmS runup-alerts
screen -S runup-alerts -X stuff 'cd /root/runup-sniper && node src/alerts.mjs >> alerts.log 2>&1\n'
```

### Flag
| Flag | Fungsi |
|---|---|
| `--test` | kirim 1 sample alert launch, exit |
| `--test-surge` | kirim 1 sample alert MC-surge, exit |
| `--once` | backfill launch lama, exit |
| `--no-surge` | matiin surge watcher |
| `--no-ws` | poll only |
| `--chat ID` | override target chat |

### Alert 1 — token baru (`CoinLaunched`)
```
🆕 NEW RUNUP LAUNCH  #0

RunUp $RUNNER
market  0x8399aF15...
token   0xe2906863...
creator 0x82844763...

📊 MC $23.9K  ·  0.0000239 USDC/tok
💵 20 USDC ticket  ·  826,446 tok
⚙️ LONG 2× · preset 3 · profile 1 · fee 1.30%
🕐 founding opens  2026-10-01T15:30:00Z  (public +1h)

runup.fun/coin/…  ·  explorer
```

### Alert 2 — MC surge
```
🚀 MC SURGE  $RUNNER

MC  $15.9K → $23.9K  (+50% in 5m)
market  0x8399aF15...
token   0xe2906863...
```
Trigger: MC naik ≥ `ALERT_SURGE_PCT`% dalam `ALERT_SURGE_WINDOW_MS`, di atas `ALERT_SURGE_MIN_MC`.
Cooldown per-market = 1 window (anti-spam).

### Env surge
```
ALERT_SURGE_PCT=25           # naik ≥25%
ALERT_SURGE_WINDOW_MS=300000 # window 5 menit
ALERT_SURGE_MIN_MC=500       # abaikan MC < $500
ALERT_SURGE_POLL_MS=30000    # cek tiap 30s
```

---

## 6. Wallet & funding

### Generate
```bash
node src/genwallets.mjs --count 10            # tulis wallets.json + wallets.env
```

### Funding
```bash
DRY_RUN=false node src/fund.mjs --funder 0xKEY --wallets wallets.json --usdc 20 --inj 0.05
```
- Funder kirim USDC (ERC20 transfer) + gas INJ ke tiap wallet
- Funder **beda** dari wallet sniper, tapi **ikut beli** juga

### Format `PRIVATE_KEYS`
```
PRIVATE_KEYS=0xKEY1:20,0xKEY2:440            # KEY:AMOUNT (USDC per wallet)
```
- Comma-separated, prefix `0x` opsional, 64 hex
- EOA (bukan mnemonic)


---

## 7. Config `.env` (live)

```
RPC_URLS=sentry,drpc1,drpc2     # multi-RPC failover (viem fallback)
WS_URL=wss://sentry.evm-ws.injective.network
CHAIN_ID=1776
FACTORY=0xef1a648373dC19072D692429B704Bb63cf597950
MARKET=0x8399aF15A225314d7bE75BEeBf1E83D001380074
QUOTE=0xa00C59fF5a080D2b954d0c75e46E22a0c371235a
QUOTE_DECIMALS=6
AMOUNT=20
SLIPPAGE_BPS=3000
POLL_MS=250
LEAD_MS=400
OPEN_DELAY_S=3600               # public curve = opening() + 3600s
DEADLINE_S=7200                 # deadline tx buy/sell (detik); snipe pre-arm awal → harus nutup waktu tunggu
DRY_RUN=true
BLAST=1
TELEGRAM_CHAT_ID=782664019
ALERT_POLL_MS=15000
```

---

## 8. Testing (anvil)

```bash
bash test/run_e2e.sh           # snipe (WS)
bash test/run_e2e_nows.sh      # snipe (poll only)
bash test/run_fund_e2e.sh      # funding
bash test/run_buysell_e2e.sh   # buy + sell (+MC)
```
Hasil: buy 20 USDC → 19,800 tok → sell all → 19.8 USDC. MC `$0 → $20 → $0`. Semua PASS.

---

## 9. Pelajaran / pitfall

- **Chain ID**: 1776 = mainnet, 1439 = testnet. Jangan percaya ternary frontend.
- **RPC flaky**: dRPC `network=injective` campur EVM+Cosmos, ~20% error → multi-RPC failover wajib.
- **Baca ERC20 dari token QUOTE, bukan market.** `allowance`/`balanceOf` di alamat market = revert.
- **`opening()` = mulai founding**, bukan public curve. Public = `+OPEN_DELAY_S`.
- **`nonce too low`** di test: jangan pakai key yang sama buat setup tx + sniper.
- **`pkill -f "src/alerts.mjs"`** bisa kena shell sendiri → pakai pola bracket `[a]lerts\.mjs`.
- **Deadline tx**: `arm()` pre-sign pakai deadline. Kalau snipe di-start jauh sebelum open, deadline **harus**
  nutup waktu tunggu (fix: `DEADLINE_S`, default 600 → set 7200). Deadline kadaluarsa = semua tx revert.
- **Gas**: `MAX_FEE_GWEI`/`PRIORITY_GWEI` kosong = pakai estimasi saat arm. Kalau gas spike pas curve buka,
  tx pre-armed bisa under-priced → nyangkut. Set cap gas (mis. `MAX_FEE_GWEI=2`) kalau mau live.
- Bot token dari credential store Hermes (`TELEGRAM_BOT_TOKEN`), bukan bikin bot baru.

---

