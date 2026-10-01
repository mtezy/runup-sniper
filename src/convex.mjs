// Fetch the live RUNUP V4 deployment config from the app's Convex backend.
// The frontend reads it via the Convex query `catalog:get` (see TradingApp bundle:
//   mt.watchQuery(ne.catalog.get, {}) ). It returns null until the V4 deployment goes live,
// then carries { chainId, factory, quote, markets, acceptancePassed, lcdUrl, indexerUrl, ... }.

const CONVEX = process.env.CONVEX_URL || 'https://energetic-bison-25.convex.cloud';

export async function convexConfig(path = 'catalog:get', args = {}) {
  const r = await fetch(`${CONVEX}/api/query`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ path, args, format: 'json' }),
  });
  if (!r.ok) throw new Error(`convex ${path} HTTP ${r.status}`);
  const j = await r.json();
  return j.value ?? null;
}

// Poll until the config (with a factory) appears — use at launch time.
export async function waitForFactory({ pollMs = 3000, onTick } = {}) {
  for (;;) {
    try {
      const v = await convexConfig();
      if (v && v.factory) return v;
      onTick?.(v);
    } catch (e) { onTick?.({ error: e.message }); }
    await new Promise(r => setTimeout(r, pollMs));
  }
}
