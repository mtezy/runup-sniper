// RUNUP — terminal formatting helpers (colors, tables, number formatting).
import { formatUnits } from 'viem';

export const useColor = !!process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (c) => (s) => (useColor ? `\x1b[${c}m${s}\x1b[0m` : String(s));
export const C = {
  bold: wrap('1'), dim: wrap('2'),
  red: wrap('31'), green: wrap('32'), yellow: wrap('33'),
  blue: wrap('34'), magenta: wrap('35'), cyan: wrap('36'), gray: wrap('90'),
};

export const short = (a, head = 6, tail = 4) =>
  (a && a.length > head + tail + 2) ? `${a.slice(0, head)}…${a.slice(-tail)}` : a;

export const trunc = (s, n = 24) => { s = String(s ?? ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

// visible width, ignoring ANSI escapes
export const vlen = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '').length;
export const padEndV = (s, n) => { const v = vlen(s); return v >= n ? s : s + ' '.repeat(n - v); };
export const padStartV = (s, n) => { const v = vlen(s); return v >= n ? s : ' '.repeat(n - v) + s; };

export function num(raw, dec = 6) {
  if (raw === null || raw === undefined) return '?';
  const n = Number(formatUnits(raw, dec));
  const abs = Math.abs(n);
  const dp = abs >= 1000 ? 0 : abs >= 1 ? 3 : 6;
  return n.toLocaleString('en-US', { maximumFractionDigits: dp });
}
export const usd = (raw, dec = 6) => num(raw, dec);
export const tok = (raw, dec = 18) => num(raw, dec);
export const pct = (bps) => `${(Number(bps) / 100).toFixed(2)}%`;

// compact USD market cap: $340, $23.9K, $1.24M, $3.10B
export function mcap(n) {
  if (n === null || n === undefined || !isFinite(n)) return '?';
  const a = Math.abs(n);
  if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
  if (a >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
  if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
  return '$' + n.toFixed(2);
}
// "MC $23.9K → $24.2K" (or a single value when unchanged/absent)
export function mcapMove(before, after) {
  if (before == null && after == null) return '';
  const b = before ? mcap(before.cap) : '?';
  const a = after ? mcap(after.cap) : b;
  const up = after && before && after.cap > before.cap;
  const dn = after && before && after.cap < before.cap;
  const arrow = up ? C.green('→ ' + a) : dn ? C.red('→ ' + a) : C.dim('· ' + a);
  return C.bold('MC ') + b + (after && before && after.cap !== before.cap ? '  ' + arrow : '');
}

// column table renderer; defs = [{label, w, align:'left'|'right'}]
export function cols(defs) {
  const header = defs.map(d => padEndV(C.dim(d.label), d.w)).join('  ');
  const sep = C.dim('─'.repeat(defs.reduce((s, d) => s + d.w, 0) + 2 * (defs.length - 1)));
  const row = (vals) => defs.map((d, i) => {
    const v = String(vals[i] ?? '');
    return d.align === 'right' ? padStartV(v, d.w) : padEndV(v, d.w);
  }).join('  ');
  return { header, sep, row, width: defs.reduce((s, d) => s + d.w, 0) + 2 * (defs.length - 1) };
}

export const rule = (w = 66) => C.dim('─'.repeat(w));

// colored result cell shared by buy/sell
export function statusCell(r) {
  if (r.status === 'err') return C.red('✗ ' + trunc(r.err || 'error', 22));
  if (r.status === 'dry') return C.yellow('○ dry');
  if (r.status === 'success') return C.green('✓ ') + C.gray(r.hash ? short(r.hash) : 'ok');
  if (r.status === 'reverted') return C.red('✗ reverted');
  return C.gray(String(r.status));
}
