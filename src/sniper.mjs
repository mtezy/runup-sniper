#!/usr/bin/env node
/**
 * RUNUP.FUN  —  public-curve sniper (Injective EVM)
 * -------------------------------------------------------------
 * Mechanism (reverse-engineered from runup.fun + verified ABIs):
 *   Factory (UUPS)          -> count(), launches(i), event CoinLaunched(index, creator, market, token, vault, ...)
 *   Market  (per-coin, UUPS)-> phase() 0=FOUNDING(ticket round) | 1=ACTIVE(public curve) | 2=GRADUATED
 *                              buy(maximum, minimum, recipient, deadline, expectedActive)
 *                              quoteBuy(maximum) -> (spent, out, fee, graduates)
 *
 * The "public curve" opens when a coin's Market flips phase 0 -> 1 (event CurveOpened).
 * This bot arms a pre-signed `buy` and fires the instant the curve opens.
 *
 * Commands:
 *   scan                       list coins on the factory
 *   monitor --market 0x..      print a market's live state
 *   watch                      live-watch factory CoinLaunched + each market's phase
 *   snipe  [--market 0x..]     arm + fire on curve open (auto-discovers newest if --market omitted)
 *
 * Env (or .env): RPC_URL, CHAIN_ID, FACTORY, MARKET, PRIVATE_KEYS, QUOTE, AMOUNT, SLIPPAGE_BPS,
 *                MAX_FEE_GWEI, PRIORITY_GWEI, POLL_MS, LEAD_MS, DRY_RUN, BLAST
 */
import 'dotenv/config';
import {
  createPublicClient, createWalletClient, http, webSocket, fallback, defineChain, parseUnits, formatUnits,
  encodeFunctionData,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { FACTORY_ABI, MARKET_ABI, ERC20_ABI } from './abi.mjs';
import { convexConfig, waitForFactory } from './convex.mjs';
import { C, short, cols, num, usd, tok, pct, rule, statusCell, mcap, mcapMove } from './fmt.mjs';
import { readMarketCap } from './curve.mjs';

// ---------- chains ----------
const DEFAULT_RPC = {
  1776: 'https://sentry.evm-rpc.injective.network/',   // Injective EVM mainnet
  1439: 'https://1439.rpc.thirdweb.com',               // Injective EVM testnet
};
const DEFAULT_WS = {
  1776: 'wss://sentry.evm-ws.injective.network',       // Injective EVM mainnet WS
  1439: 'wss://testnet.sentry.evm-ws.injective.network',
};
const chainFor = (id, rpc) => defineChain({
  id, name: id === 1776 ? 'Injective EVM' : id === 1439 ? 'Injective EVM Testnet' : 'chain-' + id,
  nativeCurrency: { name: 'Injective', symbol: 'INJ', decimals: 18 },
  rpcUrls: { default: { http: [rpc || DEFAULT_RPC[id] || 'http://127.0.0.1:8545'] } },
});

const argv = process.argv.slice(2);
const cmd = argv[0] || 'help';
const opt = (name, def) => { const i = argv.indexOf('--' + name); return i >= 0 ? argv[i + 1] : def; };
const flag = (name) => argv.includes('--' + name);

const CHAIN_ID = Number(opt('chain', process.env.CHAIN_ID || 1776));
// RPC list: --rpcs a,b  OR  RPC_URLS=a,b  OR  single RPC_URL. First is primary, rest are failover.
const RPC_LIST = (
  opt('rpcs', '') ||
  opt('rpc', '') ||
  process.env.RPC_URLS ||
  process.env.RPC_URL ||
  DEFAULT_RPC[CHAIN_ID] || 'http://127.0.0.1:8545'
).split(',').map(s => s.trim()).filter(Boolean);
const RPC_URL = RPC_LIST[0];
const chain = chainFor(CHAIN_ID, RPC_URL);
const WS_URL = opt('ws', process.env.WS_URL || DEFAULT_WS[CHAIN_ID] || '');
const NO_WS = flag('no-ws');
let FACTORY = (opt('factory', process.env.FACTORY || '')).trim();
const MARKET = (opt('market', process.env.MARKET || '')).trim();
const QUOTE = (opt('quote', process.env.QUOTE || '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a')).trim(); // USDC mainnet
const QUOTE_DECIMALS = Number(opt('quoteDecimals', process.env.QUOTE_DECIMALS || 6));
const AMOUNT = opt('amount', process.env.AMOUNT || '25');                 // human units of QUOTE
const SLIPPAGE_BPS = BigInt(opt('slippage', process.env.SLIPPAGE_BPS || 3000));
const MAX_FEE_GWEI = opt('maxfee', process.env.MAX_FEE_GWEI || '');
const PRIORITY_GWEI = opt('priority', process.env.PRIORITY_GWEI || '');
const POLL_MS = Number(opt('poll', process.env.POLL_MS || 250));
const LEAD_MS = Number(opt('lead', process.env.LEAD_MS || 400));          // fire this early vs open
// `opening()` = the FOUNDING start. The PUBLIC curve opens OPEN_DELAY_S later (V4 platform founding
// duration = 1h = 3600s). Set OPEN_DELAY_S=3600 to snipe a founding market's public-curve open.
const OPEN_DELAY_S = Number(opt('openDelay', process.env.OPEN_DELAY_S || 0));
// `buy/sell` deadline (seconds). For a snipe armed well before the open, the pre-armed tx's deadline
// must still be valid at fire time → set DEADLINE_S to cover the wait (e.g. 7200 = 2h).
const DEADLINE_S = Number(opt('deadline', process.env.DEADLINE_S || 600));
const DRY_RUN = flag('dry') || String(process.env.DRY_RUN).toLowerCase() === 'true';
const BLAST = Number(opt('blast', process.env.BLAST || 1));               // send N copies (nonce+1..)
const KEYS = (opt('keys', process.env.PRIVATE_KEYS || process.env.PRIVATE_KEY || '')).split(',').map(s => s.trim()).filter(Boolean);

// Build an HTTP transport: single url, or a viem `fallback` chain that rotates on RPC failure.
function httpTransport() {
  const opts = { timeout: 20000, retryCount: 0 };
  if (RPC_LIST.length === 1) return http(RPC_LIST[0], { ...opts, retryCount: 1 });
  return fallback(RPC_LIST.map((u) => http(u, opts)), { rank: false, retryCount: 2 });
}

const pub = createPublicClient({ chain, transport: httpTransport() });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const now = () => Math.floor(Date.now() / 1000);
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

function wallets() {
  return KEYS.map(entry => {
    const [rawKey, rawAmt] = entry.split(':');
    const account = privateKeyToAccount(rawKey.startsWith('0x') ? rawKey : '0x' + rawKey);
    const amount = (rawAmt && rawAmt.trim()) || AMOUNT;
    return { account, wallet: createWalletClient({ account, chain, transport: httpTransport() }), amount: String(amount) };
  });
}

// ---------- factory discovery ----------
async function factoryCount(factory) {
  return Number(await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'count' }));
}
async function factoryLaunch(factory, i) {
  const r = await pub.readContract({ address: factory, abi: FACTORY_ABI, functionName: 'launches', args: [BigInt(i)] });
  return { index: i, token: r[0], market: r[1], vault: r[2], schedule: r[3], adapter: r[4], creator: r[5], marketId: r[6], shortThesis: r[7], leverage: r[8], profile: r[9], preset: r[10] };
}
async function newestMarket(factory) {
  const n = await factoryCount(factory);
  if (!n) throw new Error('factory has no coins yet');
  return (await factoryLaunch(factory, n - 1)).market;
}

// ---------- market state ----------
async function marketState(market) {
  const [phase, active, opening, realQuote, realTokens, gradQuote, tSold, founderCap, ticket, ticketTokens, token, quote] = await Promise.all([
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'phase' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'active' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'opening' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'realQuote' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'realTokens' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'graduationQuote' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'ticketsSold' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'founderCount' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'TICKET' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'TICKET_TOKENS' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'token' }).catch(() => null),
    pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'quoteToken' }).catch(() => null),
  ]);
  return { market, phase, active, opening, realQuote, realTokens, gradQuote, tSold, founderCap, ticket, ticketTokens, token, quote };
}

// ---------- arming ----------
async function arm(market, w, { nonce, fees, amount, deadline } = {}) {
  const account = w.account;
  const amt = amount ?? w.amount ?? AMOUNT;
  const maximum = parseUnits(String(amt), QUOTE_DECIMALS);
  // preview min-out with slippage against the current curve (open price)
  let minimum = 0n;
  try {
    const [, out] = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'quoteBuy', args: [maximum] });
    minimum = (out * (10000n - SLIPPAGE_BPS)) / 10000n;
  } catch { /* curve not quoted yet — min 0 */ }
  const dl = BigInt(deadline ?? (now() + DEADLINE_S));
  const data = encodeFunctionData({ abi: MARKET_ABI, functionName: 'buy', args: [maximum, minimum, account.address, dl, true] });
  const nonceV = nonce ?? await pub.getTransactionCount({ address: account.address, blockTag: 'pending' });
  let gas;
  try { gas = (await pub.estimateGas({ account, to: market, data, value: 0n })) * 120n / 100n; } catch { gas = 900000n; }
  const tx = { account, to: market, data, value: 0n, chain, gas, nonce: nonceV, ...fees };
  const serialized = await w.wallet.signTransaction(tx);
  return { tx, serialized, maximum, minimum, deadline: dl };
}

async function fees() {
  const out = {};
  if (MAX_FEE_GWEI) out.maxFeePerGas = parseUnits(MAX_FEE_GWEI, 9);
  if (PRIORITY_GWEI) out.maxPriorityFeePerGas = parseUnits(PRIORITY_GWEI, 9);
  if (!MAX_FEE_GWEI || !PRIORITY_GWEI) {
    try {
      const f = await pub.estimateFeesPerGas();
      out.maxFeePerGas ??= f.maxFeePerGas;
      out.maxPriorityFeePerGas ??= f.maxPriorityFeePerGas;
    } catch {
      out.gasPrice = await pub.getGasPrice();
      delete out.maxFeePerGas; delete out.maxPriorityFeePerGas;
    }
  }
  return out;
}

// ---------- approval ----------
async function ensureApproval(w, market, amount) {
  const cur = await pub.readContract({ address: QUOTE, abi: ERC20_ABI, functionName: 'allowance', args: [w.account.address, market] }).catch(() => 0n);
  if (cur >= amount) return;
  if (DRY_RUN) { log(`[DRY] would approve ${market} for wallet ${w.account.address.slice(0, 10)}`); return; }
  const hash = await w.wallet.writeContract({ address: QUOTE, abi: ERC20_ABI, functionName: 'approve', args: [market, (1n << 256n) - 1n] });
  log(`approve ${w.account.address.slice(0, 10)} -> ${hash}`);
  await pub.waitForTransactionReceipt({ hash });
}

// ---------- fire ----------
async function fire(market, armed, w, rearm) {
  const label = w.account.address.slice(0, 10);
  if (DRY_RUN) { log(`[DRY] would buy on ${market} wallet ${label} max=${formatUnits(armed.maximum, QUOTE_DECIMALS)} min=${armed.minimum}`); return null; }
  const hashes = [];
  for (let i = 0; i < Math.max(1, BLAST); i++) {
    try {
      const h = await pub.sendRawTransaction({ serializedTransaction: armed.serialized });
      hashes.push(h);
      log(`FIRED ${label} blast#${i + 1} -> ${h}`);
    } catch (e) {
      const msg = `${e.details || ''} ${e.shortMessage || ''} ${e.message || ''}`.toLowerCase();
      if ((msg.includes('nonce') || msg.includes('deadline') || msg.includes('expired')) && rearm) {
        log(`${msg.includes('nonce') ? 'nonce stale' : 'deadline/expired'} for ${label}, re-arming fresh...`);
        try {
          const fresh = await rearm(w);
          const h = await pub.sendRawTransaction({ serializedTransaction: fresh.serialized });
          hashes.push(h);
          log(`FIRED ${label} (renonce) -> ${h}`);
        } catch (e2) { log(`fire err ${label} renonce: ${e2.details || e2.shortMessage || e2.message}`); }
      } else {
        log(`fire err ${label} #${i + 1}: ${e.shortMessage || e.message}`);
        if (e.details) log(`   details: ${e.details}`);
      }
    }
  }
  return hashes;
}

// ---------- commands ----------
async function cmdScan() {
  if (!FACTORY) throw new Error('need --factory or FACTORY');
  const n = await factoryCount(FACTORY);
  log(`factory ${FACTORY} chain ${CHAIN_ID} — ${n} coin(s)`);
  for (let i = 0; i < n; i++) {
    const c = await factoryLaunch(FACTORY, i);
    const s = await marketState(c.market).catch(() => ({}));
    const mc = await readMarketCap(pub, c.market).catch(() => null);
    console.log(`#${i} ${c.market} phase=${s.phase} active=${s.active} opening=${s.opening} mc=${mc ? mcap(mc.cap) : '?'} token=${c.token} lev=${c.leverage}x${c.shortThesis ? ' short' : ''}`);
  }
}

async function cmdMonitor() {
  if (!MARKET) throw new Error('need --market or MARKET');
  const s = await marketState(MARKET);
  const mc = await readMarketCap(pub, MARKET).catch(() => null);
  if (mc) { s.marketCap = mc.cap; s.unitPrice = mc.unit; s.totalSupply = mc.supply; }
  console.log(JSON.stringify(s, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

async function cmdFounders() {
  if (!MARKET) throw new Error('need --market or MARKET');
  const s = await marketState(MARKET);
  const sold = Number(s.tSold ?? 0), cap = Number(s.founderCap ?? 0);
  const pctDone = cap ? (sold / cap) * 100 : 0;
  const openTs = s.opening && Number(s.opening) > 0 ? Number(s.opening) + OPEN_DELAY_S : 0;
  const bar = (() => {
    const w = 28, filled = Math.round((pctDone / 100) * w);
    return C.green('█'.repeat(filled)) + C.dim('░'.repeat(Math.max(0, w - filled)));
  })();
  console.log('');
  console.log('  ' + C.bold(C.cyan('FOUNDING')) + C.dim('  ' + MARKET));
  console.log('  ' + bar + '  ' + C.bold(`${sold}/${cap}`) + C.dim(`  (${pctDone.toFixed(1)}%)`));
  console.log('  ' + C.dim('phase ') + (Number(s.phase) === 0 ? C.yellow('0 founding') : Number(s.phase) === 1 ? C.green('1 active') : C.green('2 graduated'))
    + C.dim('  ·  ticket ') + (s.ticket ? usd(s.ticket) + ' USDC' : '?')
    + C.dim('  ·  sold ') + sold);
  if (openTs) console.log('  ' + C.dim('scheduled public open ') + new Date(openTs * 1000).toISOString() + C.dim(`  (opening+${OPEN_DELAY_S}s)`));
  if (Number(s.phase) === 0 && cap && sold >= cap) console.log('  ' + C.green('SOLD OUT → public curve open (phase 1)'));
  console.log('');
}

async function cmdWallets() {
  const ws = wallets();
  if (!ws.length) throw new Error('need PRIVATE_KEYS');
  // position context: the market's token + unit price (for USD value)
  let token = null, tdec = 18, unit = 0;
  if (MARKET) {
    token = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'token' }).catch(() => null);
    if (token) {
      tdec = Number(await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18));
      const mc = await readMarketCap(pub, MARKET).catch(() => null);
      if (mc) unit = mc.unit;
    }
  }
  const T = cols([
    { label: '#', w: 3, align: 'right' },
    { label: 'wallet', w: 15 },
    { label: 'buy', w: 8, align: 'right' },
    { label: 'USDC', w: 10, align: 'right' },
    { label: 'INJ', w: 9, align: 'right' },
    { label: 'tokens', w: 12, align: 'right' },
    { label: 'value', w: 10, align: 'right' },
    { label: 'appr', w: 6 },
    { label: '', w: 3 },
  ]);
  console.log('');
  console.log('  ' + C.bold(C.cyan('WALLETS')) + C.dim(`  ${ws.length} · market ${MARKET ? short(MARKET, 8, 6) : '(unset)'}${token ? ' · token ' + short(token, 6, 4) : ''}${unit ? ' · ' + unit.toPrecision(4) + ' USDC/tok' : ''}`));
  console.log('  ' + T.sep);
  console.log('  ' + T.header);
  console.log('  ' + T.sep);
  let ok = 0, i = 0, valTotal = 0n, tokTotal = 0n;
  for (const w of ws) {
    i++;
    const a = w.account.address;
    const need = parseUnits(String(w.amount), QUOTE_DECIMALS);
    const [inj, usdc, allow, tokBal] = await Promise.all([
      pub.getBalance({ address: a }).catch(() => null),
      pub.readContract({ address: QUOTE, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] }).catch(() => null),
      MARKET ? pub.readContract({ address: QUOTE, abi: ERC20_ABI, functionName: 'allowance', args: [a, MARKET] }).catch(() => null) : Promise.resolve(null),
      token ? pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [a] }).catch(() => null) : Promise.resolve(null),
    ]);
    const hasUsdc = usdc !== null && usdc >= need;
    const approved = allow === null ? null : allow >= need;
    const ready = hasUsdc && (approved === null || approved);
    if (ready) ok++;
    const usdcStr = usdc === null ? '?' : usd(usdc, QUOTE_DECIMALS);
    const injStr = inj === null ? '?' : Number(formatUnits(inj, 18)).toFixed(4);
    const apStr = approved === null ? C.dim('n/a') : approved ? C.green('yes') : C.yellow('no');
    let tokStr = C.dim('—'), valStr = C.dim('—');
    if (tokBal !== null) {
      tokTotal += tokBal;
      const v = Number(formatUnits(tokBal, tdec)) * unit;
      valTotal += BigInt(Math.round(v * 1e6));
      tokStr = tok(tokBal, tdec);
      valStr = v > 0 ? usd(BigInt(Math.round(v * 1e6))) : C.dim('$0');
    }
    console.log('  ' + T.row([
      String(i), short(a), `${w.amount}`,
      hasUsdc ? usdcStr : C.red(usdcStr),
      injStr, tokStr, valStr, apStr,
      ready ? C.green('✓') : C.red('✗'),
    ]));
  }
  console.log('  ' + T.sep);
  const okStr = ok === ws.length ? C.green(`${ok}/${ws.length} ready`) : C.yellow(`${ok}/${ws.length} ready`);
  const posStr = (tokTotal > 0n) ? C.dim('  ·  ') + `holdings ${C.bold(tok(tokTotal, tdec) + ' tok')}` + C.dim('  ·  ') + `value ${C.bold(usd(valTotal) + ' USDC')}` : '';
  console.log('  ' + okStr + posStr);
  console.log('');
}

async function cmdApprove() {
  if (!MARKET) throw new Error('need --market or MARKET');
  const ws = wallets();
  if (!ws.length) throw new Error('need PRIVATE_KEYS');
  log(`approving ${ws.length} wallet(s): USDC → market ${MARKET}`);
  for (const w of ws) {
    try { await ensureApproval(w, MARKET, parseUnits(String(w.amount), QUOTE_DECIMALS)); }
    catch (e) { log(`approve err ${w.account.address.slice(0, 10)}: ${e.shortMessage || e.details || e.message}`); }
  }
  log('approve pass done.');
}

// ---------- manual buy / sell ----------
function banner(kind, market, sub) {
  const arrow = kind === 'BUY' ? C.green('▲ BUY') : C.red('▼ SELL');
  console.log('');
  console.log('  ' + C.bold(arrow) + C.dim('  ' + market));
  console.log('  ' + C.dim(sub));
}

async function cmdBuy() {
  if (!MARKET) throw new Error('need --market or MARKET');
  const ws = wallets();
  if (!ws.length) throw new Error('need PRIVATE_KEYS');
  const slip = BigInt(opt('slippage', String(SLIPPAGE_BPS)));
  const jsonOut = flag('json');
  const feesCfg = await fees();
  const [phase, active] = await Promise.all([
    pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'phase' }).catch(() => null),
    pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'active' }).catch(() => null),
  ]);
  const amounts = ws.map(w => Number(opt('amount', w.amount)));
  const totalPlan = amounts.reduce((a, b) => a + b, 0);
  const mcBefore = await readMarketCap(pub, MARKET);

  const T = cols([
    { label: '#', w: 3, align: 'right' },
    { label: 'wallet', w: 15 },
    { label: 'amount', w: 11, align: 'right' },
    { label: 'min-out', w: 15, align: 'right' },
    { label: 'result', w: 26 },
  ]);
  if (!jsonOut) {
    const act = active ? C.green('active') : C.yellow('inactive');
    const mcStr = mcBefore ? ' · ' + C.bold('MC ' + mcap(mcBefore.cap)) : '';
    banner('BUY', MARKET, `phase ${phase} · ${act}${mcStr} · ${ws.length} wallets · ${totalPlan} USDC planned · slip ${pct(slip)}${DRY_RUN ? ' · ' + C.yellow('DRY RUN') : ''}`);
    console.log('  ' + T.sep);
    console.log('  ' + T.header);
    console.log('  ' + T.sep);
  }

  const results = [];
  let i = 0, ok = 0, spent = 0n, got = 0n, gas = 0n;
  for (const w of ws) {
    i++;
    const amount = opt('amount', w.amount);
    const maximum = parseUnits(String(amount), QUOTE_DECIMALS);
    const r = { i, wallet: w.account.address, amount, out: null, min: null, status: '?', hash: null, err: null, gas: null };
    try {
      await ensureApproval(w, MARKET, maximum);
      const [, outQ] = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'quoteBuy', args: [maximum] });
      const minimum = (outQ * (10000n - slip)) / 10000n;
      r.out = outQ; r.min = minimum;
      if (DRY_RUN) { r.status = 'dry'; }
      else {
        const hash = await w.wallet.writeContract({ address: MARKET, abi: MARKET_ABI, functionName: 'buy', args: [maximum, minimum, w.account.address, BigInt(now() + 600), active ?? true], ...feesCfg });
        r.hash = hash;
        const rc = await pub.waitForTransactionReceipt({ hash });
        r.status = rc.status;
        if (rc.gasUsed && rc.effectiveGasPrice) { r.gas = rc.gasUsed * rc.effectiveGasPrice; gas += r.gas; }
      }
      ok++; spent += maximum; got += outQ;
    } catch (e) {
      const m = e.shortMessage || e.details || e.message || '';
      r.status = 'err';
      r.err = (Number(phase) < 1 && /revert/i.test(m)) ? 'curve not open (phase 0)' : m;
    }
    results.push(r);
    if (!jsonOut) console.log('  ' + T.row([String(i), short(w.account.address), `${amount} USDC`, r.out !== null ? `${tok(r.out)} tok` : C.dim('—'), statusCell(r)]));
  }

  if (!jsonOut) {
    console.log('  ' + T.sep);
    const avg = got > 0n ? Number(formatUnits(spent, QUOTE_DECIMALS)) / Number(formatUnits(got, 18)) : 0;
    const mcAfter = await readMarketCap(pub, MARKET);
    const okStr = ok === ws.length ? C.green(`${ok}/${ws.length}`) : C.yellow(`${ok}/${ws.length}`);
    let line = `  ${okStr}${C.dim('  ·  ')}spent ${C.bold(usd(spent) + ' USDC')}${C.dim('  ·  ')}got ${C.bold(tok(got) + ' tok')}`;
    if (avg > 0) line += C.dim('  ·  ') + `avg ${avg.toPrecision(4)} USDC/tok`;
    if (gas > 0n) line += C.dim('  ·  ') + `gas ${Number(formatUnits(gas, 18)).toFixed(5)} INJ`;
    const mv = mcapMove(mcBefore, mcAfter);
    if (mv) line += C.dim('  ·  ') + mv;
    console.log(line);
    console.log('');
  }
  if (jsonOut) console.log(JSON.stringify({ market: MARKET, phase: phase != null ? Number(phase) : null, active: active ?? null, mcBefore: mcBefore?.cap ?? null, mcAfter: (await readMarketCap(pub, MARKET))?.cap ?? null, results }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

async function cmdSell() {
  if (!MARKET) throw new Error('need --market or MARKET');
  const ws = wallets();
  if (!ws.length) throw new Error('need PRIVATE_KEYS');
  const token = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'token' });
  const dec = Number(await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18));
  const slip = BigInt(opt('slippage', String(SLIPPAGE_BPS)));
  const tokensArg = opt('tokens', '');
  const jsonOut = flag('json');
  const feesCfg = await fees();
  const [phase, active] = await Promise.all([
    pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'phase' }).catch(() => null),
    pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'active' }).catch(() => null),
  ]);
  const mcBefore = await readMarketCap(pub, MARKET);

  const T = cols([
    { label: '#', w: 3, align: 'right' },
    { label: 'wallet', w: 15 },
    { label: 'sell', w: 16, align: 'right' },
    { label: 'min-out', w: 15, align: 'right' },
    { label: 'result', w: 26 },
  ]);
  if (!jsonOut) {
    const act = active ? C.green('active') : C.yellow('inactive');
    const mcStr = mcBefore ? ' · ' + C.bold('MC ' + mcap(mcBefore.cap)) : '';
    banner('SELL', MARKET, `token ${short(token, 8, 6)} · phase ${phase} · ${act}${mcStr} · ${ws.length} wallets · ${tokensArg ? tokensArg + ' tok each' : 'ALL tokens'} · slip ${pct(slip)}${DRY_RUN ? ' · ' + C.yellow('DRY RUN') : ''}`);
    console.log('  ' + T.sep);
    console.log('  ' + T.header);
    console.log('  ' + T.sep);
  }

  const results = [];
  let i = 0, ok = 0, sold = 0n, outTotal = 0n, gas = 0n;
  for (const w of ws) {
    i++;
    const r = { i, wallet: w.account.address, input: null, out: null, status: '?', hash: null, err: null, gas: null };
    try {
      const bal = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'balanceOf', args: [w.account.address] });
      let input = tokensArg ? parseUnits(String(tokensArg), dec) : bal;   // default: sell all
      if (input > bal) input = bal;
      r.input = input;
      if (input === 0n) { r.status = 'skip'; if (!jsonOut) console.log('  ' + T.row([String(i), short(w.account.address), C.dim('0 tok'), C.dim('—'), C.dim('○ nothing')])); results.push(r); continue; }
      const [outQ] = await pub.readContract({ address: MARKET, abi: MARKET_ABI, functionName: 'quoteSell', args: [input] });
      const minimum = (outQ * (10000n - slip)) / 10000n;
      r.out = outQ; r.min = minimum;
      const allow = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'allowance', args: [w.account.address, MARKET] });
      if (allow < input && !DRY_RUN) {
        const h = await w.wallet.writeContract({ address: token, abi: ERC20_ABI, functionName: 'approve', args: [MARKET, (1n << 256n) - 1n], ...feesCfg });
        await pub.waitForTransactionReceipt({ hash: h });
      }
      if (DRY_RUN) { r.status = 'dry'; }
      else {
        const hash = await w.wallet.writeContract({ address: MARKET, abi: MARKET_ABI, functionName: 'sell', args: [input, minimum, w.account.address, BigInt(now() + 600), active ?? true], ...feesCfg });
        r.hash = hash;
        const rc = await pub.waitForTransactionReceipt({ hash });
        r.status = rc.status;
        if (rc.gasUsed && rc.effectiveGasPrice) { r.gas = rc.gasUsed * rc.effectiveGasPrice; gas += r.gas; }
      }
      ok++; sold += input; outTotal += outQ;
    } catch (e) { r.status = 'err'; r.err = e.shortMessage || e.details || e.message; }
    results.push(r);
    if (!jsonOut) console.log('  ' + T.row([String(i), short(w.account.address), r.input !== null ? `${tok(r.input, dec)} tok` : C.dim('—'), r.out !== null ? `${usd(r.out)} USDC` : C.dim('—'), statusCell(r)]));
  }

  if (!jsonOut) {
    console.log('  ' + T.sep);
    const mcAfter = await readMarketCap(pub, MARKET);
    const okStr = ok === ws.length ? C.green(`${ok}/${ws.length}`) : C.yellow(`${ok}/${ws.length}`);
    let line = `  ${okStr}${C.dim('  ·  ')}sold ${C.bold(tok(sold, dec) + ' tok')}${C.dim('  ·  ')}got ${C.bold(usd(outTotal) + ' USDC')}`;
    if (gas > 0n) line += C.dim('  ·  ') + `gas ${Number(formatUnits(gas, 18)).toFixed(5)} INJ`;
    const mv = mcapMove(mcBefore, mcAfter);
    if (mv) line += C.dim('  ·  ') + mv;
    console.log(line);
    console.log('');
  }
  if (jsonOut) console.log(JSON.stringify({ market: MARKET, phase: phase != null ? Number(phase) : null, active: active ?? null, mcBefore: mcBefore?.cap ?? null, mcAfter: (await readMarketCap(pub, MARKET))?.cap ?? null, results }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2));
}

async function cmdWatch() {
  if (!FACTORY) throw new Error('need --factory or FACTORY');
  const seen = new Set();
  const known = await factoryCount(FACTORY).catch(() => 0);
  for (let i = 0; i < known; i++) { const c = await factoryLaunch(FACTORY, i); seen.add(c.market); }
  log(`watching factory ${FACTORY} (${known} existing coin(s)) ...`);

  const onCoin = (l) => { const { market, token } = l.args; if (seen.has(market)) return; seen.add(market); log(`NEW COIN market=${market} token=${token}`); };

  // WS: factory CoinLaunched + any market CurveOpened
  if (!NO_WS && WS_URL) {
    try {
      const wspub = createPublicClient({ chain, transport: webSocket(WS_URL, { retryCount: 8, retryDelay: 250, keepAlive: true, timeout: 20000 }) });
      wspub.watchContractEvent({ address: FACTORY, abi: FACTORY_ABI, eventName: 'CoinLaunched', onLogs: (logs) => logs.forEach(onCoin), onError: (e) => log('ws coin err', e.message) });
      wspub.watchContractEvent({ abi: MARKET_ABI, eventName: 'CurveOpened', onLogs: (logs) => logs.forEach((l) => log(`CURVE OPEN market=${l.address}`)), onError: (e) => log('ws curve err', e.message) });
      log(`WS armed: ${WS_URL} (CoinLaunched + CurveOpened)`);
    } catch (e) { log('ws setup err', e.message); }
  }

  // poll fallback (CoinLaunched + phases)
  pub.watchContractEvent({
    address: FACTORY, abi: FACTORY_ABI, eventName: 'CoinLaunched', poll: true, pollingInterval: 2000,
    onLogs: (logs) => logs.forEach(onCoin), onError: (e) => log('watch err', e.message),
  });
  while (true) {
    for (const m of seen) {
      const p = await pub.readContract({ address: m, abi: MARKET_ABI, functionName: 'phase' }).catch(() => null);
      if (p !== null) log(`market ${m} phase=${p}`);
    }
    await sleep(5000);
  }
}

async function cmdSnipe() {
  const ws = wallets();
  if (!ws.length) throw new Error('need PRIVATE_KEYS');
  let market = MARKET;
  if (!market) {
    if (!FACTORY) throw new Error('need --market or --factory');
    log('no --market: discovering newest coin from factory...');
    market = await newestMarket(FACTORY);
    log('newest market =', market);
  }
  // initial state
  let s = await marketState(market);
  const amtMap = {};
  for (const w of ws) amtMap[w.amount] = (amtMap[w.amount] || 0) + 1;
  const amtStr = Object.entries(amtMap).map(([a, n]) => `${n}×${a}`).join(' + ');
  log(`target ${market}  phase=${s.phase} active=${s.active} opening=${s.opening}  amounts=${amtStr} quote`);

  // Pre-arm each wallet (nonce + fees + signed buy). Re-arm on demand.
  // The pre-armed tx's deadline must still be valid when we fire → set it to (public open + DEADLINE_S)
  // when the open time is known, else now + DEADLINE_S.
  const armDeadline = Math.max((s.opening && Number(s.opening) > 0) ? Number(s.opening) + OPEN_DELAY_S : 0, now()) + DEADLINE_S;
  const baseFees = await fees();
  for (const w of ws) { try { await ensureApproval(w, market, parseUnits(String(w.amount), QUOTE_DECIMALS)); } catch (e) { log('approve err', w.account.address.slice(0, 10), e.shortMessage || e.message); } }
  let armed = {};
  const doArm = async () => {
    const results = await Promise.all(ws.map(async (w) => {
      try { return [w.account.address, await arm(market, w, { fees: baseFees, amount: w.amount, deadline: armDeadline })]; }
      catch (e) { log('arm err', w.account.address.slice(0, 10), e.shortMessage || e.message); return null; }
    }));
    for (const r of results) if (r) armed[r[0]] = r[1];
    log(`armed ${Object.keys(armed).length} wallet(s)  deadline=${new Date(armDeadline * 1000).toISOString()}`);
  };
  await doArm();

  let fired = false, reason = '';
  const triggerOnce = async (why) => {
    if (fired) return; fired = true; reason = why;
    log(`>>> TRIGGER (${why}) at ${now()}`);
    const rearm = async (w) => { const a = await arm(market, w, { fees: baseFees, amount: w.amount }); armed[w.account.address] = a; return a; };
    await Promise.all(Object.values(armed).map(a => fire(market, a, ws.find(w => w.account.address === a.tx.account.address), rearm)));
  };

  // Already open at start?
  if (s.phase === 1 || s.active === true) { await triggerOnce('already-active'); return; }

  const cleanups = [];

  // ---- WS layer: CurveOpened log (instant) + FoundingFinalized (early-open) + newHeads re-check ----
  if (!NO_WS && WS_URL) {
    try {
      const wspub = createPublicClient({ chain, transport: webSocket(WS_URL, { retryCount: 8, retryDelay: 250, keepAlive: true, timeout: 20000 }) });
      cleanups.push(wspub.watchContractEvent({
        address: market, abi: MARKET_ABI, eventName: 'CurveOpened',
        onLogs: () => triggerOnce('ws:CurveOpened'),
        onError: (e) => log('ws log err', e.message),
      }));
      // FoundingFinalized fires just before CurveOpened when the founding round ends — on SOLD OUT
      // (333/333) it can happen well before the scheduled open, so treat it as an early trigger too.
      cleanups.push(wspub.watchContractEvent({
        address: market, abi: MARKET_ABI, eventName: 'FoundingFinalized',
        onLogs: () => { log('ws:FoundingFinalized — founding closed, curve imminent'); triggerOnce('ws:FoundingFinalized'); },
        onError: (e) => log('ws finalize err', e.message),
      }));
      cleanups.push(wspub.watchBlocks({
        onBlock: async () => { try { const p = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'phase' }); if (p === 1) triggerOnce('ws:phase=1'); } catch {} },
        onError: (e) => log('ws head err', e.message),
      }));
      log(`WS armed: ${WS_URL} (CurveOpened + FoundingFinalized + newHeads)`);
    } catch (e) { log('ws setup err', e.message); }
  } else {
    log('WS disabled — polling only');
  }

  // ---- timer layer: fire LEAD_MS before the PUBLIC CURVE opens ----
  // `opening()` = founding start; public opens at opening + OPEN_DELAY_S (default 0; 3600 for a
  // founding market). The trigger re-checks phase so a mis-timed wake never burns the shot.
  if (s.opening && Number(s.opening) > 0) {
    const openMs = (Number(s.opening) + OPEN_DELAY_S) * 1000;
    const delay = openMs - LEAD_MS - Date.now();
    log(`public curve opens at ${new Date(openMs).toISOString()} (opening+${OPEN_DELAY_S}s, lead ${LEAD_MS}ms, in ${Math.round(delay / 1000)}s)`);
    const timerTrigger = async () => {
      const until = Date.now() + 6000;            // tight-poll window after the scheduled time
      while (Date.now() < until) {
        if (fired) return;
        try { const p = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'phase' }); if (Number(p) >= 1) return triggerOnce('timer:open'); } catch {}
        await sleep(40);
      }
      log('timer window elapsed, phase still <1 — relying on WS/poll');
    };
    if (delay <= 0) await timerTrigger();
    else { const t = setTimeout(timerTrigger, delay); cleanups.push(() => clearTimeout(t)); }
  }

  // ---- poll fallback (always on; cheap) ----
  let last = s.phase;
  const pollIv = setInterval(async () => {
    if (fired) return;
    try {
      const p = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'phase' });
      const a = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'active' });
      if (p === 1 || a === true) return triggerOnce(`poll:phase ${last}->${p}`);
      if (p !== last) { log(`phase ${last} -> ${p}`); last = p; }
    } catch {}
  }, POLL_MS);
  cleanups.push(() => clearInterval(pollIv));

  // ---- heartbeat ----
  const hbIv = setInterval(async () => {
    if (fired) return;
    try { const st = await marketState(market); log(`waiting... phase=${st.phase} active=${st.active} ticketsSold=${st.tSold}`); } catch {}
  }, 15000);
  cleanups.push(() => clearInterval(hbIv));

  while (!fired) await sleep(150);
  for (const c of cleanups) { try { c?.(); } catch {} }
  log(`snipe finished (${reason})`);
}

async function cmdConfig() {
  const v = await convexConfig();
  console.log(JSON.stringify(v, null, 2));
  if (v?.factory) log(`factory = ${v.factory}  quote = ${v.quote}  chainId = ${v.chainId}`);
}

async function main() {
  log(`chain=${CHAIN_ID} rpcs=${RPC_LIST.length} [${RPC_LIST.map(u => u.replace(/dkey=[^&]+/, 'dkey=***')).join(', ')}] ws=${NO_WS ? 'off' : (WS_URL || 'none')} dry=${DRY_RUN}`);
  // Auto-resolve the factory from the app's Convex config when not supplied.
  if (!FACTORY && ['scan', 'watch', 'snipe'].includes(cmd) && !(cmd === 'snipe' && MARKET)) {
    log('no FACTORY set — reading runup config from Convex (catalog:get)...');
    try {
      const v = await convexConfig();
      if (v?.factory) { FACTORY = v.factory; log(`factory resolved = ${FACTORY}`); }
      else log('convex config has no factory yet (pre-launch). Pass --factory explicitly or wait for launch.');
    } catch (e) { log('convex config err:', e.message); }
  }
  switch (cmd) {
    case 'config': return cmdConfig();
    case 'scan': return cmdScan();
    case 'monitor': return cmdMonitor();
    case 'founders': return cmdFounders();
    case 'wallets': return cmdWallets();
    case 'approve': return cmdApprove();
    case 'buy': return cmdBuy();
    case 'sell': return cmdSell();
    case 'watch': return cmdWatch();
    case 'snipe': return cmdSnipe();
    default:
      console.log(`RUNUP sniper
  node src/sniper.mjs config                          show live V4 deployment config (Convex catalog:get)
  node src/sniper.mjs scan   --factory 0x..           list coins on the factory
  node src/sniper.mjs monitor --market 0x..           print a market's live state
  node src/sniper.mjs founders --market 0x..          founding progress (tickets sold / cap) + open ETA
  node src/sniper.mjs wallets                          list wallets: INJ / USDC balance + approval
  node src/sniper.mjs approve                          approve USDC → market for every wallet
  node src/sniper.mjs buy  [--amount 20] [--json]      buy on the market with every wallet
  node src/sniper.mjs sell [--tokens 1000] [--json]    sell tokens back (default: all)
  node src/sniper.mjs watch  --factory 0x..           live-watch CoinLaunched + CurveOpened (WS)
  node src/sniper.mjs snipe  [--market 0x..] [--factory 0x..] [--dry] [--no-ws] [--ws wss://..]
flags: --rpc --ws --no-ws --amount --tokens --slippage --poll --lead --blast --maxfee --priority --json
env: PRIVATE_KEYS, AMOUNT, SLIPPAGE_BPS, WS_URL, MAX_FEE_GWEI, PRIORITY_GWEI, DRY_RUN`);
  }
}
main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
