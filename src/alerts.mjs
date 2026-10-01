#!/usr/bin/env node
/**
 * RUNUP — new-token launch watcher.
 * Watches the V4 LaunchpadFactory for `CoinLaunched`, enriches each launch with on-chain
 * metadata, and pushes a formatted alert to Telegram (@digidawbbot → langris DM).
 *
 * Usage:
 *   node src/alerts.mjs                       # WS + poll, live
 *   node src/alerts.mjs --no-ws               # poll only
 *   node src/alerts.mjs --once                # scan existing, alert, exit (backfill)
 *   node src/alerts.mjs --test                # send one sample launch alert, exit
 *   node src/alerts.mjs --test-surge          # send one sample MC-surge alert, exit
 *   node src/alerts.mjs --no-surge            # disable the MC-surge watcher
 *   node src/alerts.mjs --chat 12345          # override target chat
 *
 * Env: FACTORY, RPC_URLS/RPC_URL, WS_URL, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID,
 *      ALERT_SURGE_PCT, ALERT_SURGE_WINDOW_MS, ALERT_SURGE_MIN_MC, ALERT_SURGE_POLL_MS
 */
import 'dotenv/config';
import { createPublicClient, http, webSocket, fallback, defineChain, formatUnits } from 'viem';
import { FACTORY_ABI, MARKET_ABI, ERC20_ABI } from './abi.mjs';
import { sendTelegram, CHAT_ID, esc } from './notify.mjs';
import { mcap } from './fmt.mjs';
import { readMarketCap } from './curve.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

const CHAIN_ID = Number(opt('chain', process.env.CHAIN_ID || 1776));
const DEFAULT_RPC = { 1776: 'https://sentry.evm-rpc.injective.network/', 1439: 'https://1439.rpc.thirdweb.com' };
const RPC_LIST = (opt('rpcs', '') || opt('rpc', '') || process.env.RPC_URLS || process.env.RPC_URL || DEFAULT_RPC[CHAIN_ID])
  .split(',').map(s => s.trim()).filter(Boolean);
const WS_URL = opt('ws', process.env.WS_URL || (CHAIN_ID === 1776 ? 'wss://sentry.evm-ws.injective.network' : 'wss://testnet.sentry.evm-ws.injective.network'));
const NO_WS = flag('no-ws');
const ONCE = flag('once');
const TEST = flag('test');
const FACTORY = (opt('factory', process.env.FACTORY || '')).trim();
const CHAT = opt('chat', CHAT_ID);
const POLL_MS = Number(opt('poll', process.env.ALERT_POLL_MS || 15000));
// MC-surge watcher
const SURGE = !flag('no-surge');
const SURGE_PCT = Number(opt('surge', process.env.ALERT_SURGE_PCT || 25));
const SURGE_WINDOW_MS = Number(opt('surge-window', process.env.ALERT_SURGE_WINDOW_MS || 300000));
const SURGE_MIN_MC = Number(opt('surge-min', process.env.ALERT_SURGE_MIN_MC || 500));
const SURGE_POLL_MS = Number(opt('surge-poll', process.env.ALERT_SURGE_POLL_MS || 30000));
// curve-open / founding-progress watcher
const CURVE_POLL_MS = Number(opt('curve-poll', process.env.ALERT_CURVE_POLL_MS || 8000));

const chain = defineChain({ id: CHAIN_ID, name: 'Injective EVM', nativeCurrency: { name: 'Injective', symbol: 'INJ', decimals: 18 }, rpcUrls: { default: { http: [RPC_LIST[0]] } } });
const httpTransport = () => RPC_LIST.length === 1
  ? http(RPC_LIST[0], { timeout: 20000, retryCount: 1 })
  : fallback(RPC_LIST.map(u => http(u, { timeout: 20000, retryCount: 0 })), { rank: false, retryCount: 2 });
const pub = createPublicClient({ chain, transport: httpTransport() });
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---------- enrich ----------
async function tokenMeta(token) {
  try {
    const [name, symbol, decimals, supply, metaUri] = await Promise.all([
      pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'name' }).catch(() => ''),
      pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => ''),
      pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'decimals' }).catch(() => 18),
      pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null),
      pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'metadataURI' }).catch(() => null),
    ]);
    let image = '', avatar = '', description = '';
    if (metaUri) {
      try { const m = JSON.parse(metaUri); image = m.image || ''; avatar = m.avatar || ''; description = m.description || ''; } catch {}
    }
    return { name, symbol, decimals: Number(decimals), supply, image, avatar, description };
  } catch { return { name: '', symbol: '', decimals: 18, supply: null, image: '', avatar: '', description: '' }; }
}

async function marketMeta(market) {
  const q = (fn) => pub.readContract({ address: market, abi: MARKET_ABI, functionName: fn }).catch(() => null);
  const [phase, active, opening, ticket, ticketTokens, gradQuote, ticketsSold, founderCap, token, quote, creator, preset, feeBps] = await Promise.all([
    q('phase'), q('active'), q('opening'), q('TICKET'), q('TICKET_TOKENS'), q('graduationQuote'), q('ticketsSold'), q('founderCount'), q('token'), q('quoteToken'), q('creator'), q('preset'), q('FEE_BPS'),
  ]);
  return { phase, active, opening, ticket, ticketTokens, gradQuote, ticketsSold, founderCap, token, quote, creator, preset, feeBps };
}

function fmtUsd(raw, decimals = 6) {
  if (raw === null || raw === undefined) return '?';
  const n = Number(formatUnits(raw, decimals));
  return n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });
}

// ---------- message ----------
const markets = new Map(); // market(lower) -> { market, token, symbol }
function register(market, token, symbol) {
  if (!market) return;
  const k = market.toLowerCase();
  const cur = markets.get(k);
  markets.set(k, { market, token: token || cur?.token, symbol: symbol || cur?.symbol });
}

async function buildAlert({ index, creator, market, token, vault, schedule, adapter, leverage, shortThesis, profile, preset }) {
  const [meta, mk] = await Promise.all([tokenMeta(token), marketMeta(market)]);
  register(market, token, meta.symbol);
  const mc = await readMarketCap(pub, market).catch(() => null);
  const price = mk.quote && mk.ticket ? `${fmtUsd(mk.ticket)} ${'USDC'} ticket` : '';
  const openTs = mk.opening && Number(mk.opening) > 0 ? new Date(Number(mk.opening) * 1000).toISOString().replace('.000Z', 'Z') : 'TBD';
  const name = meta.name || '(unknown)';
  const sym = meta.symbol ? `$${meta.symbol}` : '';
  const side = shortThesis ? 'SHORT' : 'LONG';
  const unitStr = mc ? (mc.unit < 0.001 ? mc.unit.toPrecision(3) : mc.unit.toFixed(5)) + ' USDC/tok' : '';

  const lines = [];
  lines.push(`🆕 <b>NEW RUNUP LAUNCH</b>  #${index}`);
  lines.push('');
  lines.push(`<b>${esc(name)}</b> ${esc(sym)}`);
  if (meta.description) lines.push(`<i>${esc(meta.description)}</i>`);
  if (meta.image) lines.push(`🖼 <a href="${meta.image}">artwork</a>`);
  else if (meta.avatar) lines.push(`🖼 avatar  <code>${esc(meta.avatar)}</code>`);
  lines.push(`market  <code>${market}</code>`);
  lines.push(`token   <code>${token}</code>`);
  lines.push(`creator <code>${creator}</code>`);
  lines.push('');
  if (mc) lines.push(`📊 <b>MC ${mcap(mc.cap)}</b>  ·  ${unitStr}`);
  lines.push(`💵 ${esc(price)}  ·  ${mk.ticketTokens ? Number(formatUnits(mk.ticketTokens, meta.decimals)).toLocaleString('en-US', { maximumFractionDigits: 0 }) : '?'} tok`);
  if (Number(mk.phase) === 0 && mk.founderCap) {
    const sold = Number(mk.ticketsSold || 0), cap = Number(mk.founderCap);
    lines.push(`🎟️ founding  <b>${sold}/${cap}</b>  (${((sold / cap) * 100).toFixed(1)}% sold — sold out → curve opens early)`);
  }
  if (mk.gradQuote && Number(mk.gradQuote) > 0) lines.push(`🎯 graduation  ~${fmtUsd(mk.gradQuote)} USDC`);
  lines.push(`⚙️ ${esc(side)} ${leverage}× · preset ${preset} · profile ${profile} · fee ${(Number(mk.feeBps || 0) / 100).toFixed(2)}%`);
  lines.push(`🕐 founding opens  ${esc(openTs)}  (public +1h)`);
  lines.push('');
  lines.push(`<a href="https://runup.fun/coin/${market}">runup.fun/coin/…</a>  ·  <a href="https://blockscout.injective.network/address/${market}">explorer</a>`);
  return lines.join('\n');
}

// ---------- dispatch ----------
const seen = new Set();
async function handleLaunch(args, tag) {
  const idx = Number(args.index);
  if (seen.has(idx)) return;
  seen.add(idx);
  try {
    const msg = await buildAlert({
      index: idx,
      creator: args.creator,
      market: args.market,
      token: args.token,
      vault: args.vault,
      schedule: args.schedule,
      adapter: args.adapter,
      leverage: args.leverage,
      shortThesis: args.shortThesis,
      profile: args.profile,
      preset: args.preset,
    });
    const mid = await sendTelegram(msg, { chatId: CHAT });
    log(`alert #${idx} ${args.token.slice(0, 10)} (${tag}) -> msg ${mid ?? 'FAILED'}`);
  } catch (e) {
    log(`alert #${idx} err: ${e.shortMessage || e.message}`);
  }
}

async function backfill(fromIndex = 0) {
  const n = Number(await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'count' }));
  for (let i = fromIndex; i < n; i++) {
    const r = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'launches', args: [BigInt(i)] });
    register(r[1], r[0], null);
    await handleLaunch({ index: BigInt(i), creator: r[5], market: r[1], token: r[0], vault: r[2], schedule: r[3], adapter: r[4], marketId: r[6], shortThesis: r[7], leverage: r[8], profile: r[9], preset: r[10] }, 'backfill');
  }
}

// ---------- MC surge (metadata-enriched) ----------
const samples = new Map();   // market(lower) -> [{t, mc}]
const lastSurge = new Map(); // market(lower) -> ts

const SPARK = '▁▂▃▄▅▆▇█';
function spark(vals) {
  if (!vals || vals.length < 2) return '';
  const min = Math.min(...vals), max = Math.max(...vals), rng = (max - min) || 1;
  return vals.map(v => SPARK[Math.min(7, Math.max(0, Math.round(((v - min) / rng) * 7)))]).join('');
}
const PHASE_NAME = { 0: 'founding', 1: 'active (curve)', 2: 'graduated' };
const usdN = (raw, dec = 6) => Number(formatUnits(raw, dec));
const usdFmt = (n) => n.toLocaleString('en-US', { maximumFractionDigits: n < 100 ? 2 : 0 });

// pull a full metadata bundle for a market (token + curve state + MC)
async function richMarket(market, token) {
  const q = (fn) => pub.readContract({ address: market, abi: MARKET_ABI, functionName: fn }).catch(() => null);
  const [meta, phase, active, opening, ticket, ticketTokens, gradQuote, ticketsSold, founderCap, realQuote, creator, preset, feeBps] = await Promise.all([
    tokenMeta(token), q('phase'), q('active'), q('opening'), q('TICKET'), q('TICKET_TOKENS'), q('graduationQuote'),
    q('ticketsSold'), q('founderCount'), q('realQuote'), q('creator'), q('preset'), q('FEE_BPS'),
  ]);
  const mc = await readMarketCap(pub, market).catch(() => null);
  return { meta, phase, active, opening, ticket, ticketTokens, gradQuote, ticketsSold, founderCap, realQuote, creator, preset, feeBps, mc };
}

async function surgeMsg(m, from, to, pct, mins, hist) {
  const rich = await richMarket(m.market, m.token).catch(() => null);
  const meta = rich?.meta || {};
  const name = meta.name || '(unknown)';
  const sym = meta.symbol || m.symbol || '';
  const ph = rich?.phase != null ? Number(rich.phase) : null;
  const L = [];
  L.push(`🚀 <b>MC SURGE</b>  <b>${esc(name)}</b> ${sym ? '$' + esc(sym) : ''}`);
  if (meta.description) L.push(`<i>${esc(meta.description)}</i>`);
  L.push('');
  L.push(`📈 <b>${mcap(from)} → ${mcap(to)}</b>  (<b>+${pct.toFixed(0)}%</b> in ${mins}m)`);
  if (hist && hist.length > 1) L.push(`<code>${spark(hist)}</code>  <i>${mcap(Math.min(...hist))} – ${mcap(Math.max(...hist))}</i>`);
  if (rich?.mc) L.push(`💲 price  ${rich.mc.unit < 0.001 ? rich.mc.unit.toPrecision(3) : rich.mc.unit.toFixed(6)} USDC/tok`);
  if (ph != null) L.push(`⚙️ phase  ${ph} · ${esc(PHASE_NAME[ph] || '?')}`);
  if (ph === 0 && rich?.founderCap) {
    const sold = Number(rich.ticketsSold || 0), cap = Number(rich.founderCap);
    L.push(`🎟️ founding  <b>${sold}/${cap}</b>  (${((sold / cap) * 100).toFixed(1)}% — sold out → early open)`);
  }
  if (rich?.realQuote != null && rich?.gradQuote != null && Number(rich.gradQuote) > 0) {
    const rq = usdN(rich.realQuote), gq = usdN(rich.gradQuote);
    L.push(`💧 curve  ${usdFmt(rq)} / ${usdFmt(gq)} USDC  (${((rq / gq) * 100).toFixed(1)}% to grad)`);
  }
  if (rich?.feeBps) L.push(`🧾 fee  ${(Number(rich.feeBps) / 100).toFixed(2)}%`);
  L.push('');
  L.push(`market  <code>${m.market}</code>`);
  if (m.token) L.push(`token   <code>${m.token}</code>`);
  if (rich?.creator) L.push(`creator <code>${rich.creator}</code>`);
  L.push('');
  L.push(`<a href="https://runup.fun/coin/${m.market}">runup.fun/coin/…</a>  ·  <a href="https://blockscout.injective.network/address/${m.market}">explorer</a>`);
  return L.join('\n');
}

async function surgeTick() {
  for (const [key, m] of markets) {
    try {
      if (!m.symbol && m.token) {
        const s = await pub.readContract({ address: m.token, abi: ERC20_ABI, functionName: 'symbol' }).catch(() => null);
        if (s) m.symbol = s;
      }
      const mc = await readMarketCap(pub, m.market);
      if (!mc || !isFinite(mc.cap) || mc.cap <= 0) continue;
      const now = Date.now();
      const arr = samples.get(key) || [];
      arr.push({ t: now, mc: mc.cap });
      const cut = now - SURGE_WINDOW_MS * 2;
      while (arr.length && arr[0].t < cut) arr.shift();
      samples.set(key, arr);
      if (mc.cap < SURGE_MIN_MC) continue;
      const target = now - SURGE_WINDOW_MS;
      const base = arr.find(s => s.t <= target);
      if (!base || base.mc <= 0) continue;
      const pct = ((mc.cap - base.mc) / base.mc) * 100;
      const la = lastSurge.get(key) || 0;
      if (pct >= SURGE_PCT && now - la > SURGE_WINDOW_MS) {
        lastSurge.set(key, now);
        const mins = Math.max(1, Math.round((now - base.t) / 60000));
        const hist = arr.filter(s => s.t >= target).map(s => s.mc);
        const msg = await surgeMsg(m, base.mc, mc.cap, pct, mins, hist);
        const mid = await sendTelegram(msg, { chatId: CHAT });
        log(`surge ${m.symbol || key.slice(0, 8)} +${pct.toFixed(0)}% (${mcap(base.mc)}→${mcap(mc.cap)}) -> msg ${mid ?? 'FAILED'}`);
      }
    } catch (e) { log('surge err', e.shortMessage || e.message); }
  }
}

// ---------- curve open / founding progress ----------
const lastPhase = new Map();   // market(lower) -> phase
const foundingPinged = new Map(); // market(lower) -> Set of milestone % already alerted

async function curveTick() {
  for (const [key, m] of markets) {
    try {
      const [phase, sold, cap] = await Promise.all([
        pub.readContract({ address: m.market, abi: MARKET_ABI, functionName: 'phase' }).catch(() => null),
        pub.readContract({ address: m.market, abi: MARKET_ABI, functionName: 'ticketsSold' }).catch(() => null),
        pub.readContract({ address: m.market, abi: MARKET_ABI, functionName: 'founderCount' }).catch(() => null),
      ]);
      if (phase === null) continue;
      const ph = Number(phase);
      const prev = lastPhase.get(key);
      const sym = m.symbol ? '$' + esc(m.symbol) : 'token';

      // phase 0 -> 1 : the public curve just opened (early on SOLD OUT, or on schedule)
      if (prev === 0 && ph >= 1) {
        const msg = [`🔓 <b>CURVE OPEN</b>  ${sym}`, '', `public curve is live — phase 0 → ${ph}`,
          `market  <code>${m.market}</code>`, m.token ? `token   <code>${m.token}</code>` : '',
          '', `<a href="https://runup.fun/coin/${m.market}">runup.fun/coin/…</a>`].filter(Boolean).join('\n');
        const mid = await sendTelegram(msg, { chatId: CHAT });
        log(`curve open ${m.symbol || key.slice(0, 8)} -> msg ${mid ?? 'FAILED'}`);
      }
      // founding milestones (90% / sold out) while still phase 0
      if (ph === 0 && cap && Number(cap) > 0) {
        const pct = (Number(sold || 0) / Number(cap)) * 100;
        const pinged = foundingPinged.get(key) || new Set();
        for (const mark of [90, 100]) {
          if (pct >= mark && !pinged.has(mark)) {
            pinged.add(mark);
            foundingPinged.set(key, pinged);
            const head = mark >= 100 ? '🔥 <b>FOUNDING SOLD OUT</b>' : '⚠️ <b>FOUNDING 90%</b>';
            const msg = [head + '  ' + sym, '', `tickets  <b>${Number(sold)}/${Number(cap)}</b>  (${pct.toFixed(1)}%)`,
              mark >= 100 ? 'curve opens imminently' : 'nearly full — curve opens early on sell-out',
              `market  <code>${m.market}</code>`, '', `<a href="https://runup.fun/coin/${m.market}">runup.fun/coin/…</a>`].join('\n');
            const mid = await sendTelegram(msg, { chatId: CHAT });
            log(`founding ${mark}% ${m.symbol || key.slice(0, 8)} (${sold}/${cap}) -> msg ${mid ?? 'FAILED'}`);
          }
        }
      }
      lastPhase.set(key, ph);
    } catch (e) { log('curve err', e.shortMessage || e.message); }
  }
}

async function main() {
  if (!FACTORY) { console.error('need FACTORY (env or --factory)'); process.exit(1); }
  log(`chain=${CHAIN_ID} factory=${FACTORY} chat=${CHAT} ws=${NO_WS ? 'off' : WS_URL} poll=${POLL_MS}ms`);

  if (TEST) {
    const n = Number(await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'count' }).catch(() => 0));
    const i = Math.max(0, n - 1);
    const r = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'launches', args: [BigInt(i)] });
    const msg = await buildAlert({ index: i, creator: r[5], market: r[1], token: r[0], vault: r[2], schedule: r[3], adapter: r[4], leverage: r[8], shortThesis: r[7], profile: r[9], preset: r[10] });
    console.log(msg);
    const mid = await sendTelegram(msg, { chatId: CHAT });
    log(`test alert -> msg ${mid ?? 'FAILED'}`);
    return;
  }

  if (flag('test-surge')) {
    const n = Number(await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'count' }).catch(() => 0));
    const r = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'launches', args: [BigInt(Math.max(0, n - 1))] });
    const sym = await pub.readContract({ address: r[0], abi: ERC20_ABI, functionName: 'symbol' }).catch(() => 'TOKEN');
    const m = { market: r[1], token: r[0], symbol: sym };
    const mc = await readMarketCap(pub, m.market).catch(() => null);
    const to = mc ? mc.cap : 1500, from = to / 1.5;
    const hist = [from, from * 1.05, from * 1.12, from * 1.25, from * 1.33, to];
    const msg = await surgeMsg(m, from, to, 50, 5, hist);
    console.log(msg);
    const mid = await sendTelegram(msg, { chatId: CHAT });
    log(`test surge -> msg ${mid ?? 'FAILED'}`);
    return;
  }

  // seed known launches (so we only alert on NEW ones), then alert on everything after
  const known = Number(await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'count' }).catch(() => 0));
  for (let i = 0; i < known; i++) {
    seen.add(i);
    try {
      const r = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'launches', args: [BigInt(i)] });
      register(r[1], r[0], null);
      const ph = await pub.readContract({ address: r[1], abi: MARKET_ABI, functionName: 'phase' }).catch(() => null);
      if (ph !== null) lastPhase.set(String(r[1]).toLowerCase(), Number(ph));
    } catch {}
  }
  log(`factory has ${known} existing launch(es); watching for new...`);
  if (ONCE) { await backfill(known); log('once scan done'); return; }

  // WS layer
  if (!NO_WS && WS_URL) {
    try {
      const wspub = createPublicClient({ chain, transport: webSocket(WS_URL, { retryCount: 8, retryDelay: 300, keepAlive: true, timeout: 20000 }) });
      wspub.watchContractEvent({
        address: FACTORY, abi: FACTORY_ABI, eventName: 'CoinLaunched',
        onLogs: (logs) => { for (const l of logs) handleLaunch(l.args, 'ws'); },
        onError: (e) => log('ws err', e.message),
      });
      log(`WS armed: ${WS_URL} (CoinLaunched)`);
    } catch (e) { log('ws setup err', e.message); }
  }

  // poll fallback: factory.count() increase → read the new indices
  let lastCount = known;
  setInterval(async () => {
    try {
      const n = Number(await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'count' }));
      if (n > lastCount) { for (let i = lastCount; i < n; i++) { const r = await pub.readContract({ address: FACTORY, abi: FACTORY_ABI, functionName: 'launches', args: [BigInt(i)] }); await handleLaunch({ index: BigInt(i), creator: r[5], market: r[1], token: r[0], vault: r[2], schedule: r[3], adapter: r[4], marketId: r[6], shortThesis: r[7], leverage: r[8], profile: r[9], preset: r[10] }, 'poll'); } lastCount = n; }
    } catch {}
  }, POLL_MS);

  // MC-surge watcher (tracks every known market)
  if (SURGE) {
    setInterval(surgeTick, SURGE_POLL_MS);
    log(`surge watcher: +${SURGE_PCT}% / ${SURGE_WINDOW_MS / 60000}m, min MC ${mcap(SURGE_MIN_MC)}, every ${SURGE_POLL_MS}ms (${markets.size} market(s))`);
  }

  // curve-open + founding-progress watcher (catches EARLY open on sell-out)
  setInterval(curveTick, CURVE_POLL_MS);
  log(`curve watcher: every ${CURVE_POLL_MS}ms — founding milestones + phase 0→1 (curve open) (${markets.size} market(s))`);

  log('watching... (ctrl-c to stop)');
}

main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
