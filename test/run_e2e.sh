#!/usr/bin/env bash
# End-to-end test of the RUNUP sniper against a local anvil mock market.
set -e
export PATH="$HOME/.foundry/bin:$PATH"
cd /root/runup-sniper
PK=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
# separate sniper wallet (anvil account #1) so its nonce is not touched by setPhase
SPK=0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d
WALLET=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
RPC=http://127.0.0.1:8545

pkill -f 'anvil --silent' 2>/dev/null || true
sleep 1
anvil --silent --port 8545 >/tmp/anvil.log 2>&1 &
sleep 2

QOUT=$(forge create test/Mock.sol:MockQuote --private-key $PK --rpc-url $RPC --broadcast 2>/dev/null | grep 'Deployed to:' | awk '{print $3}')
MKT=$(forge create test/Mock.sol:MockMarket --private-key $PK --rpc-url $RPC --broadcast --constructor-args $QOUT 0x000000000000000000000000000000000000dEaD 2>/dev/null | grep 'Deployed to:' | awk '{print $3}')
echo "QUOTE=$QOUT"
echo "MARKET=$MKT"

cast send $QOUT "mint(address,uint256)" $WALLET 1000000000 --private-key $PK --rpc-url $RPC >/dev/null
echo "minted 1000 USDC to wallet"

echo "--- starting sniper (WS mode, waits for phase 0->1) ---"
PRIVATE_KEYS=$SPK node src/sniper.mjs snipe --market $MKT --rpc $RPC --ws ws://127.0.0.1:8545 --chain 31337 \
  --amount 20 --quote $QOUT --quoteDecimals 6 --poll 150 --slippage 3000 >/tmp/sniper.log 2>&1 &
SPID=$!
sleep 3
echo "--- flipping phase -> 1 (public curve opens) ---"
cast send $MKT "setPhase(uint8)" 1 --private-key $PK --rpc-url $RPC >/dev/null
sleep 5
kill $SPID 2>/dev/null || true
echo "========== sniper log =========="
cat /tmp/sniper.log
echo "========== on-chain check =========="
echo -n "realQuote = "; cast call $MKT "realQuote()(uint256)" --rpc-url $RPC
echo -n "realTokens = "; cast call $MKT "realTokens()(uint256)" --rpc-url $RPC
