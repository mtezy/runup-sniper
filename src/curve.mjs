// RUNUP — market-cap helper.
// Mirrors runup.fun's frontend: marketCap = unitPrice * 1e9  (total supply = 1e9 tokens).
// price() returns an 18-decimal fixed-point USD/token value; supply is 18-decimal.
import { formatUnits } from 'viem';
import { MARKET_ABI, ERC20_ABI } from './abi.mjs';

export async function readMarketCap(pub, market) {
  try {
    const priceRaw = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'price' });
    const token = await pub.readContract({ address: market, abi: MARKET_ABI, functionName: 'token' }).catch(() => null);
    let supply = null;
    if (token) supply = await pub.readContract({ address: token, abi: ERC20_ABI, functionName: 'totalSupply' }).catch(() => null);
    const unit = Number(formatUnits(priceRaw, 18));                       // USD per token
    const supplyNum = supply != null ? Number(formatUnits(supply, 18)) : 1e9;
    return { priceRaw, unit, supply: supplyNum, cap: unit * supplyNum };
  } catch { return null; }
}
