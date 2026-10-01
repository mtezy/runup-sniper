#!/usr/bin/env node
/**
 * RUNUP — wallet generator.
 * Creates N fresh EVM wallets, writes them to wallets.json + a paste-ready keys line,
 * and prints the addresses (never the private keys).
 *
 * Usage: node src/genwallets.mjs [--count 10] [--out wallets.json]
 */
import 'dotenv/config';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { writeFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const opt = (n, d) => { const i = argv.indexOf('--' + n); return i >= 0 ? argv[i + 1] : d; };
const COUNT = Number(opt('count', 10));
const OUT = opt('out', 'wallets.json');

const wallets = [];
for (let i = 0; i < COUNT; i++) {
  const privateKey = generatePrivateKey();
  const { address } = privateKeyToAccount(privateKey);
  wallets.push({ index: i, address, privateKey });
}

writeFileSync(OUT, JSON.stringify(wallets, null, 2));
// write the paste-ready env NEXT TO the out file (derive name from OUT) so tests don't clobber the real one
const envOut = OUT.replace(/\.json$/i, '') + '.env';
writeFileSync(envOut, `PRIVATE_KEYS=${wallets.map(w => w.privateKey).join(',')}\n`);

console.log(`generated ${COUNT} wallets → ${OUT} (+ ${envOut})`);
console.log('addresses:');
for (const w of wallets) console.log(`  #${String(w.index).padStart(2)}  ${w.address}`);
console.log('\nprivate keys are in wallets.json / wallets.env — NOT printed here.');
