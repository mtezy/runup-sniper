#!/usr/bin/env bash
# E2E test of the funder: anvil + mock USDC, fund 3 wallets, assert balances.
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd /root/runup-sniper
FUNDER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
RPC=http://127.0.0.1:8545

pkill -f 'anvil --silent' 2>/dev/null || true
sleep 1
anvil --silent --port 8545 >/tmp/anvil.log 2>&1 &
sleep 2

USDC=$(forge create test/Mock.sol:MockQuote --private-key $FUNDER --rpc-url $RPC --broadcast 2>/dev/null | grep 'Deployed to:' | awk '{print $3}')
echo "USDC=$USDC"
cast send $USDC "mint(address,uint256)" 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266 1000000000 --private-key $FUNDER --rpc-url $RPC >/dev/null
echo "minted 1000 USDC to funder"

# generate 3 fresh wallets
node src/genwallets.mjs --count 3 --out /tmp/w3.json >/dev/null
echo "targets:"; node -e "JSON.parse(require('fs').readFileSync('/tmp/w3.json')).forEach(w=>console.log('  '+w.address))"

echo "--- running funder (live) ---"
DRY_RUN=false node src/fund.mjs --funder $FUNDER --wallets /tmp/w3.json --usdc 20 --inj 0.05 \
  --rpc $RPC --chain 31337 --usdc-token $USDC --usdc-decimals 6 2>&1 | tail -12

echo "--- verify balances ---"
node -e "
const {createPublicClient,http,defineChain,formatUnits}=require('viem');
const {ERC20_ABI}=require('./src/abi.mjs');
" 2>/dev/null || true
node --input-type=module -e "
import {createPublicClient,http,defineChain,formatUnits} from 'viem';
import {ERC20_ABI} from './src/abi.mjs';
import {readFileSync} from 'node:fs';
const chain=defineChain({id:31337,name:'a',nativeCurrency:{name:'I',symbol:'I',decimals:18},rpcUrls:{default:{http:['http://127.0.0.1:8545']}}});
const c=createPublicClient({chain,transport:http('http://127.0.0.1:8545')});
const usdc='$USDC';
for(const w of JSON.parse(readFileSync('/tmp/w3.json','utf8'))){
  const b=await c.readContract({address:usdc,abi:ERC20_ABI,functionName:'balanceOf',args:[w.address]});
  const inj=await c.getBalance({address:w.address});
  console.log(w.address,'USDC='+formatUnits(b,6),'INJ='+formatUnits(inj,18), b>=20000000n&&inj>0n?'OK':'FAIL');
}
"
pkill -f 'anvil --silent' 2>/dev/null || true
