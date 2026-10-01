#!/usr/bin/env bash
# E2E of buy + sell commands: anvil + mock USDC/token/market, then real buy then real sell.
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd /root/runup-sniper
FUNDER=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0
SNIPER=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d   # anvil #1
SNIPER_ADDR=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
RPC=http://127.0.0.1:8545

pkill -f 'anvil --silent' 2>/dev/null || true
sleep 1
anvil --silent --port 8545 >/tmp/anvil.log 2>&1 &
sleep 2

USDC=$(forge create test/Mock.sol:MockQuote --private-key $FUNDER --rpc-url $RPC --broadcast 2>/dev/null | grep 'Deployed to:' | awk '{print $3}')
TOKEN=$(forge create test/Mock.sol:MockToken --private-key $FUNDER --rpc-url $RPC --broadcast 2>/dev/null | grep 'Deployed to:' | awk '{print $3}')
MARKET=$(forge create test/Mock.sol:MockMarket --private-key $FUNDER --rpc-url $RPC --broadcast --constructor-args $USDC $TOKEN 2>/dev/null | grep 'Deployed to:' | awk '{print $3}')
echo "USDC=$USDC TOKEN=$TOKEN MARKET=$MARKET"

cast send $USDC "mint(address,uint256)" $SNIPER_ADDR 100000000 --private-key $FUNDER --rpc-url $RPC >/dev/null   # 100 USDC
cast send $MARKET "setPhase(uint8)" 1 --private-key $FUNDER --rpc-url $RPC >/dev/null                          # curve open
echo "funded sniper 100 USDC; market phase=1"

echo "--- BUY (20 USDC) ---"
PRIVATE_KEYS=$SNIPER DRY_RUN=false node src/sniper.mjs buy --market $MARKET --amount 20 \
  --rpc $RPC --chain 31337 --quote $USDC 2>&1 | tail -4

echo "--- SELL (all) ---"
PRIVATE_KEYS=$SNIPER DRY_RUN=false node src/sniper.mjs sell --market $MARKET \
  --rpc $RPC --chain 31337 --quote $USDC 2>&1 | tail -4

echo "--- balances after ---"
echo "sniper USDC: $(cast call $USDC 'balanceOf(address)(uint256)' $SNIPER_ADDR --rpc-url $RPC)"
echo "sniper TOKEN: $(cast call $TOKEN 'balanceOf(address)(uint256)' $SNIPER_ADDR --rpc-url $RPC)"
pkill -f 'anvil --silent' 2>/dev/null || true
