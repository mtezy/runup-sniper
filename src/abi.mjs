// RUNUP V4 — LaunchpadFactory (UUPS) + per-coin Market (bonding curve) ABIs.
// Extracted from the live runup.fun bundle (v4Curve chunk) + on-chain verified ABI.
// Chain: Injective EVM mainnet chainId 1776 (native injective-1), testnet 1439.

export const FACTORY_ABI = [
  { type: 'function', name: 'count', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'quoteToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'isMarket', stateMutability: 'view', inputs: [{ type: 'address', name: 'key' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'platform', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  {
    type: 'function', name: 'launches', stateMutability: 'view',
    inputs: [{ type: 'uint256', name: 'index' }],
    outputs: [
      { type: 'address', name: 'token' },
      { type: 'address', name: 'market' },
      { type: 'address', name: 'vault' },
      { type: 'address', name: 'schedule' },
      { type: 'address', name: 'adapter' },
      { type: 'address', name: 'creator' },
      { type: 'bytes32', name: 'marketId' },
      { type: 'bool', name: 'shortThesis' },
      { type: 'uint8', name: 'leverage' },
      { type: 'uint8', name: 'profile' },
      { type: 'uint8', name: 'preset' },
    ],
  },
  {
    type: 'event', name: 'CoinLaunched', anonymous: false,
    inputs: [
      { type: 'uint256', name: 'index', indexed: true },
      { type: 'address', name: 'creator', indexed: true },
      { type: 'address', name: 'market', indexed: true },
      { type: 'address', name: 'token', indexed: false },
      { type: 'address', name: 'vault', indexed: false },
      { type: 'address', name: 'schedule', indexed: false },
      { type: 'address', name: 'adapter', indexed: false },
      { type: 'bytes32', name: 'marketId', indexed: false },
      { type: 'bool', name: 'shortThesis', indexed: false },
      { type: 'uint8', name: 'leverage', indexed: false },
      { type: 'uint8', name: 'profile', indexed: false },
      { type: 'uint8', name: 'preset', indexed: false },
    ],
  },
];

export const MARKET_ABI = [
  // ---- trade ----
  {
    type: 'function', name: 'buy', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'maximum' },   // max quote (USDC) to spend
      { type: 'uint256', name: 'minimum' },   // min tokens out (slippage guard)
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'deadline' },  // unix ts
      { type: 'bool', name: 'expectedActive' },
    ],
    outputs: [{ type: 'uint256', name: 'spent' }, { type: 'uint256', name: 'out' }],
  },
  {
    type: 'function', name: 'sell', stateMutability: 'nonpayable',
    inputs: [
      { type: 'uint256', name: 'input' },
      { type: 'uint256', name: 'minimum' },
      { type: 'address', name: 'recipient' },
      { type: 'uint256', name: 'deadline' },
      { type: 'bool', name: 'expectedActive' },
    ],
    outputs: [{ type: 'uint256', name: 'out' }],
  },
  { type: 'function', name: 'quoteBuy', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'maximum' }], outputs: [{ type: 'uint256', name: 'spent' }, { type: 'uint256', name: 'out' }, { type: 'uint256', name: 'fee' }, { type: 'bool', name: 'graduates' }] },
  { type: 'function', name: 'quoteSell', stateMutability: 'view', inputs: [{ type: 'uint256', name: 'input' }], outputs: [{ type: 'uint256', name: 'out' }, { type: 'uint256', name: 'fee' }] },

  // ---- phase / state ----
  { type: 'function', name: 'phase', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },          // 0 founding, 1 active, 2 graduated
  { type: 'function', name: 'active', stateMutability: 'view', inputs: [], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'opening', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },       // curve-open timestamp
  { type: 'function', name: 'price', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'realQuote', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'realTokens', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'reserves', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256', name: 'tokens' }, { type: 'uint256', name: 'quote' }] },
  { type: 'function', name: 'graduationQuote', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'curveProduct', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'TICKET', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'TICKET_TOKENS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'ticketsSold', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'founderCount', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'token', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'vault', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'quoteToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'creator', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
  { type: 'function', name: 'preset', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'FEE_BPS', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint16' }] },

  // ---- phase advance (permissionless) ----
  { type: 'function', name: 'advancePhase', stateMutability: 'nonpayable', inputs: [], outputs: [] },
  { type: 'function', name: 'finalizeFounders', stateMutability: 'nonpayable', inputs: [{ type: 'uint256', name: 'opens' }], outputs: [] },
  { type: 'function', name: 'subscribe', stateMutability: 'nonpayable', inputs: [], outputs: [] },

  // ---- events ----
  { type: 'event', name: 'CurveOpened', anonymous: false, inputs: [{ type: 'uint256', name: 'tickets' }, { type: 'uint256', name: 'principal' }, { type: 'uint256', name: 'graduationPrincipal' }] },
  { type: 'event', name: 'FoundingFinalized', anonymous: false, inputs: [{ type: 'uint256', name: 'opening' }, { type: 'uint256', name: 'deadline' }] },
  { type: 'event', name: 'TicketPurchased', anonymous: false, inputs: [{ type: 'address', name: 'buyer', indexed: true }, { type: 'uint256', name: 'tokens' }] },
  { type: 'event', name: 'Traded', anonymous: false, inputs: [{ type: 'address', name: 'trader', indexed: true }, { type: 'address', name: 'recipient', indexed: true }, { type: 'bool', name: 'buy' }, { type: 'uint256', name: 'quoteAmount' }, { type: 'uint256', name: 'tokens' }, { type: 'uint256', name: 'fee' }] },
  { type: 'event', name: 'Graduated', anonymous: false, inputs: [{ type: 'uint256', name: 'poolQuote' }, { type: 'uint256', name: 'treasuryCapital' }] },
];

// Minimal ERC20 for approve/balance/allowance
export const ERC20_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ type: 'address', name: 'to' }, { type: 'uint256', name: 'amount' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ type: 'address', name: 'spender' }, { type: 'uint256', name: 'amount' }], outputs: [{ type: 'bool' }] },
  { type: 'function', name: 'allowance', stateMutability: 'view', inputs: [{ type: 'address', name: 'owner' }, { type: 'address', name: 'spender' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address', name: 'account' }], outputs: [{ type: 'uint256' }] },
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] },
  // RUNUP coins carry their off-chain metadata as a JSON string on the token:
  //   metadataURI() -> '{"image":"https://...","description":"...","avatar":"rocket"}'
  { type: 'function', name: 'metadataURI', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
];
