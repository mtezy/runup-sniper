#!/usr/bin/env node
/**
 * RUNUP — funder. Sends USDC (ERC20) + native INJ (gas) from ONE funder wallet
 * to each sniper wallet.
 *
 * Usage:
 *   node src/fund.mjs --funder 0xKEY [--wallets wallets.json] [--usdc 20] [--inj 0.05] [--dry]
 *   FUNDER_KEY=0x.. node src/fund.mjs
 *
 * Targets come from (first match): --keys k1,k2  |  --wallets file.json  |  PRIVATE_KEYS in .env.
 */
import 'dotenv/config';
import { createPublicClient, createWalletClient, http, fallback, defineChain, parseUnits, formatUnits } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ERC20_ABI } from './abi.mjs';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const flag = (n) => argv.includes('--' + n);

const CHAIN_ID = Number(opt('chain', process.env.CHAIN_ID || 1776));
const DEFAULT_RPC = { 1776: 'https://sentry.evm-rpc.injective.network/', 1439: 'https://1439.rpc.thirdweb.com' };
const RPC_LIST = (opt('rpcs', '') || opt('rpc', '') || process.env.RPC_URLS || process.env.RPC_URL || DEFAULT_RPC[CHAIN_ID])
  .split(',').map(s => s.trim()).filter(Boolean);
const chain = defineChain({ id: CHAIN_ID, name: 'Injective EVM', nativeCurrency: { name: 'Injective', symbol: 'INJ', decimals: 18 }, rpcUrls: { default: { http: [RPC_LIST[0]] } } });
const httpTransport = () => RPC_LIST.length === 1
  ? http(RPC_LIST[0], { timeout: 20000, retryCount: 1 })
  : fallback(RPC_LIST.map(u => http(u, { timeout: 20000, retryCount: 0 })), { rank: false, retryCount: 2 });
const pub = createPublicClient({ chain, transport: httpTransport() });

const USDC = (opt('usdc-token', process.env.QUOTE || '0xa00C59fF5a080D2b954d0c75e46E22a0c371235a')).trim();
const USDC_DECIMALS = Number(opt('usdc-decimals', process.env.QUOTE_DECIMALS || 6));
const USDC_EACH = opt('usdc', '20');       // per-wallet USDC
const INJ_EACH = opt('inj', '0.05');       // per-wallet INJ (gas)
const DRY = flag('dry') || String(process.env.DRY_RUN).toLowerCase() === 'true';

const FUNDER_KEY = opt('funder', process.env.FUNDER_KEY || process.env.PRIVATE_KEY || '');
if (!FUNDER_KEY) { console.error('need --funder 0xKEY or FUNDER_KEY env'); process.exit(1); }
const funder = privateKeyToAccount(FUNDER_KEY.startsWith('0x') ? FUNDER_KEY : '0x' + FUNDER_KEY);
const wallet = createWalletClient({ account: funder, chain, transport: httpTransport() });

// ---- resolve targets ----
let targets = [];
const keysArg = opt('keys', '');
if (keysArg) {
  targets = keysArg.split(',').map(s => s.trim()).filter(Boolean).map(k => privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k).address);
} else if (opt('wallets', '')) {
  targets = JSON.parse(readFileSync(opt('wallets'), 'utf8')).map(w => w.address);
} else if (process.env.PRIVATE_KEYS) {
  targets = process.env.PRIVATE_KEYS.split(',').map(s => s.trim()).filter(Boolean).map(k => privateKeyToAccount(k.startsWith('0x') ? k : '0x' + k).address);
}
targets = [...new Set(targets.map(a => a.toLowerCase()))];
if (!targets.length) { console.error('no targets (use --keys, --wallets, or PRIVATE_KEYS)'); process.exit(1); }

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function main() {
  const usdcEach = parseUnits(String(USDC_EACH), USDC_DECIMALS);
  const injEach = parseUnits(String(INJ_EACH), 18);
  const usdcTotal = usdcEach * BigInt(targets.length);
  const injTotal = injEach * BigInt(targets.length);

  const [fUsdc, fInj] = await Promise.all([
    pub.readContract({ address: USDC, abi: ERC20_ABI, functionName: 'balanceOf', args: [funder.address] }),
    pub.getBalance({ address: funder.address }),
  ]);
  log(`funder ${funder.address}`);
  log(`  USDC ${formatUnits(fUsdc, USDC_DECIMALS)} (need ${formatUnits(usdcTotal, USDC_DECIMALS)})`);
  log(`  INJ  ${formatUnits(fInj, 18)} (need ${formatUnits(injTotal, 18)} + gas)`);
  log(`targets: ${targets.length} × (${USDC_EACH} USDC + ${INJ_EACH} INJ)  chain=${CHAIN_ID} dry=${DRY}`);
  if (fUsdc < usdcTotal) log(`WARN: funder USDC short by ${formatUnits(usdcTotal - fUsdc, USDC_DECIMALS)}`);
  if (fInj < injTotal) log(`WARN: funder INJ short by ${formatUnits(injTotal - fInj, 18)}`);

  let nonce = await pub.getTransactionCount({ address: funder.address, blockTag: 'pending' });
  for (let i = 0; i < targets.length; i++) {
    const to = targets[i];
    // 1) native INJ for gas
    try {
      if (DRY) { log(`[DRY] #${i} → ${to}: ${INJ_EACH} INJ + ${USDC_EACH} USDC`); }
      else {
        const h1 = await wallet.sendTransaction({ to, value: injEach, nonce: nonce++, gas: 21000n });
        await pub.waitForTransactionReceipt({ hash: h1 });
        log(`#${i} INJ sent → ${to} (${h1.slice(0, 12)}…)`);
        const h2 = await wallet.writeContract({ address: USDC, abi: ERC20_ABI, functionName: 'transfer', args: [to, usdcEach], nonce: nonce++ });
        await pub.waitForTransactionReceipt({ hash: h2 });
        log(`#${i} USDC sent → ${to} (${h2.slice(0, 12)}…)`);
      }
    } catch (e) {
      log(`#${i} ERR → ${to}: ${e.shortMessage || e.details || e.message}`);
      nonce = await pub.getTransactionCount({ address: funder.address, blockTag: 'pending' }); // resync
    }
  }
  log('done.');
}
main().catch(e => { console.error('FATAL', e.shortMessage || e.message); process.exit(1); });
