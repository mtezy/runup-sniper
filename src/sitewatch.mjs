#!/usr/bin/env node
/**
 * RUNUP — unified realtime watcher: FRONTEND (bundle + Convex) + ON-CHAIN.
 * Alerts on ANY change:
 *   FRONTEND  - index bundle hash change (redeploy)
 *             - lazy chunk set change (added/removed/changed chunk hashes)
 *             - Convex `catalog:get` change (null -> live factory = launch imminent)
 *             - new deployment addresses inside the v4Curve chunk (factory / quote)
 *   ON-CHAIN  - factory.count() increase (a NEW coin launched) + the new market/token
 *             - tracked market phase change (0 founding -> 1 active = curve open)
 *             - tracked market opening() change (NEW scheduled launch time)
 *             - active / ticketsSold / founderCount snapshot
 *
 * Usage:
 *   node src/sitewatch.mjs                 # baseline, then watch live (run in screen)
 *   node src/sitewatch.mjs --once          # snapshot once, print, exit
 *   node src/sitewatch.mjs --test          # send one sample alert, exit
 *   node src/sitewatch.mjs --interval 20   # poll seconds (default 20)
 *   node src/sitewatch.mjs --no-chain      # frontend only
 *   node src/sitewatch.mjs --chat 12345    # override target chat
 *
 * Env: SITE, CONVEX_URL, RPC_URLS/RPC_URL, CHAIN_ID, FACTORY, MARKET, TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 */
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { createPublicClient, http, fallback, defineChain } from 'viem';
import { sendAlert, CHAT_ID } from './notify.mjs';
import { EntityBuilder } from './eb.mjs';
import { convexConfig } from './convex.mjs';
import { FACTORY_ABI, MARKET_ABI } from './abi.mjs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

const SITE = (opt('site', process.env.SITE || 'https://runup.fun')).replace(/\/$/, '');
const CHAT = opt('chat', CHAT_ID);
const INTERVAL = Math.max(5, Number(opt('interval', process.env.SITEWATCH_MS ? Number(process.env.SITEWATCH_MS) / 1000 : 20)));
const NO_CONVEX = flag('no-convex');
const NO_CHAIN = flag('no-chain');
const ONCE = flag('once');
const TEST = flag('test');
const STATE_FILE = opt('state', process.env.SITEWATCH_STATE || '.sitewatch.state.json');
const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

// ---- chain ----
const CHAIN_ID = Number(opt('chain', process.env.CHAIN_ID || 1776));
const DEFAULT_RPC = { 1776: 'https://sentry.evm-rpc.injective.network/', 1439: 'https://1439.rpc.thirdweb.com' };
const RPC_LIST = (opt('rpc', '') || process.env.RPC_URLS || process.env.RPC_URL || DEFAULT_RPC[CHAIN_ID]).split(',').map(s => s.trim()).filter(Boolean);
const ENV_FACTORY = (opt('factory', process.env.FACTORY || '')).trim();
const MARKET = (opt('market', process.env.MARKET || '')).trim();
const chain = defineChain({ id: CHAIN_ID, name: 'Injective EVM', nativeCurrency: { name: 'Injective', symbol: 'INJ', decimals: 18 }, rpcUrls: { default: { http: [RPC_LIST[0]] } } });
const pub = createPublicClient({ chain, transport: RPC_LIST.length === 1 ? http(RPC_LIST[0], { timeout: 20000, retryCount: 1 }) : fallback(RPC_LIST.map(u => http(u, { timeout: 20000, retryCount: 0 })), { rank: false, retryCount: 2 }) });

async function getText(url, timeoutMs = 20000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 runup-sitewatch' }, signal: ctl.signal });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } finally { clearTimeout(t); }
}
const uniqSorted = (arr) => [...new Set(arr)].sort();
const rx = (re, s) => [...s.matchAll(re)].map(m => m[0]);

// ---------- frontend snapshot ----------
async function frontendSnapshot() {
  const snap = { assets: [], chunks: [], convex: null, convexErr: null, v4: null, addrs: [] };
  const html = await getText(`${SITE}/`);
  snap.assets = uniqSorted(rx(/assets\/[A-Za-z0-9._-]+\.(?:js|css)/g, html));
  const indexJs = snap.assets.find(p => /\/index-.*\.js$/.test(p));
  if (indexJs) {
    const js = await getText(`${SITE}/${indexJs}`);
    snap.chunks = uniqSorted(rx(/assets\/[A-Za-z0-9._-]+\.js/g, js));
  }
  if (!NO_CONVEX) {
    try { snap.convex = await convexConfig(); } catch (e) { snap.convexErr = e.message; }
  }
  const v4 = snap.chunks.find(c => /v4Curve-/.test(c)) || snap.assets.find(a => /v4Curve-/.test(a));
  if (v4) {
    try { const t = await getText(`${SITE}/${v4}`); snap.v4 = v4; snap.addrs = uniqSorted(rx(/0x[a-fA-F0-9]{40}/g, t)); } catch {}
  }
  return snap;
}

// ---------- on-chain snapshot ----------
async function chainSnapshot(factoryHint) {
  const out = { factory: factoryHint || ENV_FACTORY || null, factoryCount: null, market: MARKET || null, phase: null, opening: null, ticketsSold: null, active: null, founderCap: null, launches: [] };
  if (NO_CHAIN || !out.factory) return out;
  try {
    out.factoryCount = Number(await pub.readContract({ address: out.factory, abi: FACTORY_ABI, functionName: 'count' }));
    const from = Math.max(0, out.factoryCount - 5);
    for (let i = from; i < out.factoryCount; i++) {
      const r = await pub.readContract({ address: out.factory, abi: FACTORY_ABI, functionName: 'launches', args: [BigInt(i)] }).catch(() => null);
      if (r) out.launches.push({ index: i, market: r[1], token: r[0], creator: r[5] });
    }
  } catch (e) { out.factoryErr = e.shortMessage || e.message; }
  if (out.market) {
    const q = (fn) => pub.readContract({ address: out.market, abi: MARKET_ABI, functionName: fn }).catch(() => null);
    const [phase, opening, ticketsSold, active, founderCap] = await Promise.all([q('phase'), q('opening'), q('ticketsSold'), q('active'), q('founderCount')]);
    out.phase = phase === null ? null : Number(phase);
    out.opening = opening === null ? null : Number(opening);
    out.ticketsSold = ticketsSold === null ? null : Number(ticketsSold);
    out.active = active;
    out.founderCap = founderCap === null ? null : Number(founderCap);
  }
  return out;
}

async function snapshot() {
  const fe = await frontendSnapshot();
  const factoryHint = fe.convex?.factory || ENV_FACTORY;
  const ch = await chainSnapshot(factoryHint);
  return { ts: Date.now(), ...fe, chain: ch };
}

// ---- diff ----
function chunkMap(list) { return Object.fromEntries(list.map(p => { const m = p.match(/assets\/(.+?)-([A-Za-z0-9_-]+)\.js$/); return m ? [m[1], p] : [p, p]; })); }

function diff(prev, cur) {
  const ev = { fe: {}, ch: {}, any: false };
  // ---- frontend ----
  const f = { chunkAdded: [], chunkRemoved: [], chunkChanged: [], newAddrs: [] };
  const prevIdx = (prev.assets || []).find(p => /\/index-.*\.js$/.test(p));
  const curIdx = (cur.assets || []).find(p => /\/index-.*\.js$/.test(p));
  if (prevIdx && curIdx && prevIdx !== curIdx) { f.redeploy = true; f.indexOld = prevIdx; f.indexNew = curIdx; }
  const pm = chunkMap(prev.chunks || []), cm = chunkMap(cur.chunks || []);
  for (const [name, path] of Object.entries(cm)) {
    if (!pm[name]) f.chunkAdded.push(path);
    else if (pm[name] !== path) f.chunkChanged.push({ name, old: pm[name], new: path });
  }
  for (const [name, path] of Object.entries(pm)) if (!cm[name]) f.chunkRemoved.push(path);
  const pv = prev.convex, cv = cur.convex;
  if (JSON.stringify(pv) !== JSON.stringify(cv)) {
    f.convexChanged = true;
    if ((!pv || !pv.factory) && cv && cv.factory) { f.convexLive = true; f.factory = cv.factory; }
    else if (cv && cv.factory) f.factory = cv.factory;
    if (cv && cv.quote) f.quote = cv.quote;
  }
  const pa = new Set(prev.addrs || []);
  f.newAddrs = (cur.addrs || []).filter(a => !pa.has(a) && a !== '0x0000000000000000000000000000000000000000');
  ev.fe = f;

  // ---- on-chain ----
  const c = {};
  const pc = prev.chain || {}, cc = cur.chain || {};
  if (pc.factory && cc.factory && pc.factory.toLowerCase() !== cc.factory.toLowerCase()) { c.newFactory = true; c.factoryOld = pc.factory; c.factoryNew = cc.factory; }
  if (pc.factoryCount != null && cc.factoryCount != null && cc.factoryCount > pc.factoryCount) {
    c.newLaunches = (cc.launches || []).filter(l => l.index >= pc.factoryCount);
    c.countOld = pc.factoryCount; c.countNew = cc.factoryCount;
  }
  if (pc.market && cc.market && pc.market.toLowerCase() === cc.market.toLowerCase()) {
    if (pc.phase != null && cc.phase != null && pc.phase !== cc.phase) c.phaseChange = { old: pc.phase, new: cc.phase };
    if (pc.opening != null && cc.opening != null && pc.opening !== cc.opening) c.openingChange = { old: pc.opening, new: cc.opening };
  }
  ev.ch = c;

  ev.any = !!(f.redeploy || f.chunkAdded.length || f.chunkRemoved.length || f.chunkChanged.length || f.convexChanged || f.newAddrs.length ||
    c.newFactory || c.newLaunches || c.phaseChange || c.openingChange);
  return ev;
}

const iso = (s) => (s ? new Date(s * 1000).toISOString().replace('.000Z', 'Z') : '?');
const PHASE_LABEL = { 0: 'founding', 1: 'active (curve open)', 2: 'graduated' };

function buildMsg(ev) {
  const f = ev.fe || {}, c = ev.ch || {};
  const eb = new EntityBuilder();
  eb.add('🔧 ').bold('RUNUP UPDATE').add('  ').italic('frontend + onchain').nl();
  // ---- frontend ----
  if (f.redeploy) eb.add('🚀 ').bold('REDEPLOY').add('  index ').code(f.indexOld).add(' → ').code(f.indexNew).nl();
  if (f.convexLive) eb.add('🏭 ').bold('FACTORY LIVE').add('  convex catalog now returns a deployment').nl();
  if (f.factory) eb.add('factory ').code(f.factory).nl();
  if (f.quote) eb.add('quote   ').code(f.quote).nl();
  if (f.chunkAdded?.length) eb.add('📦 +chunk  ').code(f.chunkAdded.map(x => x.replace('assets/', '')).join(' ')).nl();
  if (f.chunkRemoved?.length) eb.add('📦 −chunk  ').code(f.chunkRemoved.map(x => x.replace('assets/', '')).join(' ')).nl();
  if (f.chunkChanged?.length) eb.add('♻️ changed  ').code(f.chunkChanged.map(x => x.new.replace('assets/', '')).join(' ')).nl();
  if (f.newAddrs?.length) eb.add('🆕 addr  ').code(f.newAddrs.slice(0, 6).join('  ')).nl();
  // ---- on-chain ----
  if (c.newFactory) eb.add('⛓️ ').bold('NEW FACTORY').add('  ').code(c.factoryOld).add(' → ').code(c.factoryNew).nl();
  if (c.newLaunches?.length) {
    eb.add('🪙 ').bold('NEW LAUNCH').add(`  factory count ${c.countOld} → ${c.countNew}`).nl();
    for (const l of c.newLaunches.slice(0, 4)) { eb.add(`  #${l.index}  market `).code(l.market).nl(); eb.add('       token  ').code(l.token).nl(); }
  }
  if (c.openingChange) eb.add('🕐 ').bold('NEW LAUNCH TIME').add('  ').add(iso(c.openingChange.old)).add(' → ').bold(iso(c.openingChange.new)).nl();
  if (c.phaseChange) eb.add('🔓 ').bold(`PHASE ${c.phaseChange.old} → ${c.phaseChange.new}`).add('  ').add(PHASE_LABEL[c.phaseChange.new] || '').nl();
  return { built: eb.build(), replyMarkup: { inline_keyboard: [[{ text: '🌐 runup.fun', url: SITE }]] } };
}

function loadState() { try { return existsSync(STATE_FILE) ? JSON.parse(readFileSync(STATE_FILE, 'utf8')) : null; } catch { return null; } }
function saveState(s) { try { writeFileSync(STATE_FILE, JSON.stringify(s, null, 2)); } catch {} }

async function main() {
  log(`site=${SITE} interval=${INTERVAL}s convex=${NO_CONVEX ? 'off' : 'on'} chain=${NO_CHAIN ? 'off' : 'on'} factory=${ENV_FACTORY || '(auto)'} market=${MARKET || '(none)'} chat=${CHAT}`);

  if (TEST) {
    const ev = { any: true, fe: { redeploy: true, indexOld: 'assets/index-OLD.js', indexNew: 'assets/index-NEW.js', convexLive: true, factory: '0xef1a648373dC19072D692429B704Bb63cf597950', quote: '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a', chunkChanged: [{ name: 'v4Curve', new: 'assets/v4Curve-NEW.js' }], newAddrs: ['0x0C382e685bbeeFE5d3d9C29e29E341fEE8E84C5d'] }, ch: { newLaunches: [{ index: 1, market: '0x8399aF15A225314d7bE75BEeBf1E83D001380074', token: '0xe2906863a4Dc9261B1D0c25b5EF983C84130D893' }], countOld: 1, countNew: 2, openingChange: { old: 1790868600, new: 1790875800 } } };
    const { built, replyMarkup } = buildMsg(ev);
    console.log(built.text);
    const mid = await sendAlert(built, { chatId: CHAT, replyMarkup });
    log(`test alert -> msg ${mid ?? 'FAILED'}`);
    return;
  }

  let prev = loadState();
  let cur = await snapshot();
  if (!prev) { saveState(cur); log(`baseline: ${cur.assets.length} asset(s), ${cur.chunks.length} chunk(s), convex=${cur.convex ? 'set' : 'null'}, factory=${cur.chain?.factory || '-'}, count=${cur.chain?.factoryCount ?? '-'}, phase=${cur.chain?.phase ?? '-'}`); }
  prev = cur;   // ensure prev is set even on the very first run (no prior state)
  if (ONCE) { console.log(JSON.stringify(cur, null, 2)); return; }

  for (;;) {
    await new Promise(r => setTimeout(r, INTERVAL * 1000));
    try {
      cur = await snapshot();
      const ev = diff(prev, cur);
      if (ev.any) {
        const { built, replyMarkup } = buildMsg(ev);
        const mid = await sendAlert(built, { chatId: CHAT, replyMarkup });
        log(`UPDATE -> msg ${mid ?? 'FAILED'} (fe.redeploy=${ev.fe.redeploy} chunks+${ev.fe.chunkAdded.length}/-${ev.fe.chunkRemoved.length}/~${ev.fe.chunkChanged.length} convex=${ev.fe.convexChanged} | chain: launch=${!!ev.ch.newLaunches} phase=${!!ev.ch.phaseChange} opening=${!!ev.ch.openingChange})`);
        saveState(cur);
      }
      prev = cur;
    } catch (e) { log('poll err', e.message); }
  }
}
main().catch(e => { console.error('FATAL', e.message); process.exit(1); });
