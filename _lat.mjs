import 'dotenv/config';
import { createPublicClient, http, fallback, webSocket, defineChain } from 'viem';
const chain = defineChain({ id: 1776, name: 'inj', nativeCurrency: { name: 'INJ', symbol: 'INJ', decimals: 18 }, rpcUrls: { default: { http: ['x'] } } });
const list = process.env.RPC_URLS.split(',').map(s => s.trim());
const httpPub = createPublicClient({ chain, transport: fallback(list.map(u => http(u, { timeout: 20000, retryCount: 0 })), { rank: false, retryCount: 1 }) });
const wsPub = createPublicClient({ chain, transport: webSocket(process.env.WS_URL, { retryCount: 5, retryDelay: 250, keepAlive: true, timeout: 20000 }) });

const wsHeads = [];   // {n, recv}
const pollHeads = []; // {n, recv}
const T0 = Date.now();

// WS head subscription — measure delivery lag vs block timestamp
const unWs = wsPub.watchBlocks({
  onBlock: (b) => { wsHeads.push({ n: Number(b.number), recv: Date.now(), ts: Number(b.timestamp) * 1000 }); },
  onError: (e) => console.log('ws err', e.message),
});

// tight HTTP poll every 30ms — when head advances, record time
let lastN = 0;
const pollIv = setInterval(async () => {
  try { const n = Number(await httpPub.getBlockNumber()); if (n > lastN) { lastN = n; pollHeads.push({ n, recv: Date.now() }); } } catch {}
}, 30);

// also measure raw sendRawTransaction-free RPC latency: repeated eth_blockNumber
const lat = [];
const latIv = setInterval(async () => {
  const t = performance.now();
  try { await httpPub.getBlockNumber(); lat.push(performance.now() - t); } catch {}
}, 200);

setTimeout(async () => {
  clearInterval(pollIv); clearInterval(latIv); try { await unWs(); } catch {}
  console.log(`ran ${((Date.now() - T0) / 1000).toFixed(0)}s`);
  // match heads by number: WS recv vs poll recv
  const wsMap = new Map(wsHeads.map(h => [h.n, h]));
  const deltas = [];
  for (const p of pollHeads) { const w = wsMap.get(p.n); if (w) deltas.push({ n: p.n, wsLeadMs: p.recv - w.recv, wsLagVsBlock: w.recv - w.ts }); }
  const avg = (a) => a.length ? (a.reduce((s, x) => s + x, 0) / a.length).toFixed(0) : '-';
  console.log(`\nWS heads: ${wsHeads.length}  poll heads: ${pollHeads.length}`);
  console.log(`WS delivery lag vs block.timestamp: avg ${avg(wsHeads.map(h => h.recv - h.ts))}ms  (min ${wsHeads.length ? Math.min(...wsHeads.map(h => h.recv - h.ts)) : '-'}, max ${wsHeads.length ? Math.max(...wsHeads.map(h => h.recv - h.ts)) : '-'})`);
  const leads = deltas.map(d => d.wsLeadMs).filter(x => x > -5000 && x < 5000);
  console.log(`WS LEAD over 30ms-poll: avg ${avg(leads)}ms  (min ${leads.length ? Math.min(...leads) : '-'}, max ${leads.length ? Math.max(...leads) : '-'})  [positive = WS faster]`);
  console.log(`HTTP eth_blockNumber latency: avg ${avg(lat)}ms  (min ${lat.length ? Math.min(...lat).toFixed(0) : '-'}, max ${lat.length ? Math.max(...lat).toFixed(0) : '-'})  n=${lat.length}`);
  // block interval
  const ns = wsHeads.map(h => h.n).sort((a, b) => a - b);
  const ivs = []; for (let i = 1; i < ns.length; i++) ivs.push(ns[i] - ns[i - 1]);
  console.log(`block interval: ${[...new Set(ivs)].slice(0, 5).join(',')} blocks (time ${((Date.now() - T0) / 1000 / Math.max(1, ns.length - 1)).toFixed(2)}s/block)`);
  process.exit(0);
}, 25000);
