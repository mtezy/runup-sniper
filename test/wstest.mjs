import { createPublicClient, webSocket, defineChain } from 'viem';
const chain = defineChain({ id: 1776, name: 'Injective EVM', nativeCurrency: { name: 'INJ', symbol: 'INJ', decimals: 18 },
  rpcUrls: { default: { http: ['https://sentry.evm-rpc.injective.network/'] } } });
const c = createPublicClient({ chain, transport: webSocket('wss://sentry.evm-ws.injective.network', { retryCount: 3, keepAlive: true }) });
console.log('subscribing to newHeads...');
let n = 0;
const un = c.watchBlockNumber({ onBlockNumber: (b) => { console.log('block', b.toString()); if (++n >= 3) { un(); process.exit(0); } }, onError: (e) => console.error('err', e.message) });
setTimeout(() => { console.log('timeout — no blocks'); process.exit(1); }, 30000);
