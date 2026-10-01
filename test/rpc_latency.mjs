import 'dotenv/config';
const list = (process.env.RPC_URLS || process.env.RPC_URL || '').split(',').map(s => s.trim()).filter(Boolean);
const pub = process.env.RPC_URL ? [process.env.RPC_URL] : [];
const all = [...new Set([...list, ...pub])];
const mask = (u) => u.replace(/(dkey=)[^&]+/, '$1***').replace(/(\/v2\/)[^/]+/, '$1***');
async function timeIt(url) {
  const times = [];
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_blockNumber', params: [] }) });
      const j = await r.json();
      const dt = performance.now() - t0;
      times.push({ dt, ok: !!j.result, block: j.result ? parseInt(j.result, 16) : null, err: j.error?.message });
    } catch (e) { times.push({ dt: performance.now() - t0, ok: false, err: e.message }); }
  }
  const ok = times.filter(t => t.ok);
  const avg = ok.length ? ok.reduce((s, t) => s + t.dt, 0) / ok.length : null;
  const min = ok.length ? Math.min(...ok.map(t => t.dt)) : null;
  const max = ok.length ? Math.max(...ok.map(t => t.dt)) : null;
  return { url: mask(url), ok: ok.length, total: times.length, avg, min, max, block: ok[0]?.block, err: times.find(t => !t.ok)?.err };
}
console.log('=== RPC latency (5x eth_blockNumber) ===');
for (const u of all) {
  const r = await timeIt(u);
  console.log(`${r.ok}/${r.total} ok  avg=${r.avg ? r.avg.toFixed(0) : '-'}ms  min=${r.min ? r.min.toFixed(0) : '-'}  max=${r.max ? r.max.toFixed(0) : '-'}  block=${r.block ?? '-'}  ${r.err ? 'ERR=' + r.err : ''}`);
  console.log(`   ${r.url}`);
}
