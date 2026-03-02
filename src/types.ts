// src/types.ts

// ============================================================================
// Constants
// ============================================================================

/** RelAI Facilitator URL */
export const RELAI_FACILITATOR_URL = 'https://facilitator.x402.fi';

// ============================================================================
// Supported Networks
// ============================================================================

/** All networks supported by RelAI facilitator */
export type RelaiNetwork =
  | 'solana'
  | 'base'
  | 'avalanche'
  | 'skale-base'
  | 'skale-base-sepolia'
  | 'skale-bite'
  | 'polygon'
  | 'ethereum'
  | 'telos';

/** CAIP-2 network identifiers */
export const NETWORK_CAIP2: Record<RelaiNetwork, string> = {
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'base': 'eip155:8453',
  'avalanche': 'eip155:43114',
  'skale-base': 'eip155:1187947933',
  'skale-base-sepolia': 'eip155:324705682',
  'skale-bite': 'eip155:103698795',
  'polygon': 'eip155:137',
  'ethereum': 'eip155:1',
  'telos': 'eip155:40',
};

/** Reverse lookup: CAIP-2 → simple network name */
export const CAIP2_TO_NETWORK: Record<string, RelaiNetwork> = Object.fromEntries(
  Object.entries(NETWORK_CAIP2).map(([k, v]) => [v, k as RelaiNetwork])
) as Record<string, RelaiNetwork>;

/** Chain IDs for EVM networks */
export const CHAIN_IDS: Record<string, number> = {
  'base': 8453,
  'avalanche': 43114,
  'skale-base': 1187947933,
  'skale-base-sepolia': 324705682,
  'skale-bite': 103698795,
  'polygon': 137,
  'ethereum': 1,
  'telos': 40,
};

export interface NetworkToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  domainVersion?: string;
  isStableUsd?: boolean;
  standards?: string[];
}

/** Token metadata per network (default token is always the first entry) */
export const NETWORK_TOKENS: Partial<Record<RelaiNetwork, NetworkToken[]>> = {
  'solana': [
    {
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
    },
  ],
  'base': [
    { address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', symbol: 'USDC', name: 'USD Coin', decimals: 6, domainVersion: '2', isStableUsd: true },
  ],
  'avalanche': [
    {
      address: '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
      isStableUsd: true,
    },
  ],
  'telos': [
    {
      address: '0x818ec0a7fe18ff94269904fced6ae3dae6d6dc0b',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      isStableUsd: true,
      standards: ['eip2612'],
    },
  ],
  'skale-base': [
    {
      address: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
      symbol: 'USDC',
      name: 'Bridged USDC (SKALE Bridge)',
      decimals: 6,
      domainVersion: '2',
      isStableUsd: true,
    },
    {
      address: '0x2bF5bF154b515EaA82C31a65ec11554fF5aF7fCA',
      symbol: 'USDT',
      name: 'Bridged USDT (SKALE Bridge)',
      decimals: 6,
      domainVersion: '1',
      isStableUsd: true,
    },
    {
      address: '0x1aeeCFE5454c83B42D8A316246CAc9739E7f690e',
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      decimals: 8,
      domainVersion: '1',
      isStableUsd: false,
    },
    {
      address: '0x7bD39ABBd0Dd13103542cAe3276C7fA332bCA486',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      domainVersion: '1',
      isStableUsd: false,
    },
  ],
  'skale-base-sepolia': [
    {
      address: '0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
      symbol: 'USDC',
      name: 'Bridged USDC (SKALE Bridge)',
      decimals: 6,
      domainVersion: '2',
      isStableUsd: true,
    },
    {
      address: '0x3ca0a49f511c2c89c4dcbbf1731120d8919050bf',
      symbol: 'USDT',
      name: 'Bridged USDT (SKALE Bridge)',
      decimals: 6,
      domainVersion: '1',
      isStableUsd: true,
    },
    {
      address: '0x4512eacd4186b025186e1cf6cc0d89497c530e87',
      symbol: 'WBTC',
      name: 'Wrapped Bitcoin',
      decimals: 8,
      domainVersion: '1',
      isStableUsd: false,
    },
    {
      address: '0xf94056bd7f6965db3757e1b145f200b7346b4fc0',
      symbol: 'WETH',
      name: 'Wrapped Ether',
      decimals: 18,
      domainVersion: '1',
      isStableUsd: false,
    },
  ],
  'skale-bite': [
    {
      address: '0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8',
      symbol: 'USDC',
      name: 'USDC',
      decimals: 6,
      domainVersion: '1',
      isStableUsd: true,
    },
  ],
  'polygon': [
    {
      address: '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
      isStableUsd: true,
    },
  ],
  'ethereum': [
    {
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USD Coin',
      decimals: 6,
      domainVersion: '2',
      isStableUsd: true,
    },
  ],
};

export function resolveToken(network: RelaiNetwork, asset?: string): NetworkToken | null {
  const tokens = NETWORK_TOKENS[network];
  if (!tokens || tokens.length === 0) return null;
  if (!asset) return tokens[0];

  const normalized = String(asset).toLowerCase();
  return tokens.find((token) => token.address.toLowerCase() === normalized) || null;
}

/** USDC contract addresses per network */
export const USDC_ADDRESSES: Record<RelaiNetwork, string> = {
  'solana': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'avalanche': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  'skale-base': '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
  'skale-base-sepolia': '0x2e08028E3C4c2356572E096d8EF835cD5C6030bD',
  'skale-bite': '0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8',
  'polygon': '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359',
  'ethereum': '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  'telos': '0x818ec0a7fe18ff94269904fced6ae3dae6d6dc0b',
};

/** Explorer URLs per network */
export const EXPLORER_TX_URL: Record<RelaiNetwork, (tx: string) => string> = {
  'solana': (tx) => `https://solscan.io/tx/${tx}`,
  'base': (tx) => `https://basescan.org/tx/${tx}`,
  'avalanche': (tx) => `https://snowtrace.io/tx/${tx}`,
  'skale-base': (tx) => `https://skale-base-explorer.skalenodes.com/tx/${tx}`,
  'skale-base-sepolia': (tx) => `https://base-sepolia-testnet-explorer.skalenodes.com/tx/${tx}`,
  'skale-bite': (tx) => `https://base-sepolia-testnet.explorer.skalenodes.com/tx/${tx}`,
  'polygon': (tx) => `https://polygonscan.com/tx/${tx}`,
  'ethereum': (tx) => `https://etherscan.io/tx/${tx}`,
  'telos': (tx) => `https://teloscan.io/tx/${tx}`,
};

/** Human-readable network labels */
export const NETWORK_LABELS: Record<RelaiNetwork, string> = {
  'solana': 'Solana',
  'base': 'Base',
  'avalanche': 'Avalanche',
  'skale-base': 'SKALE Base',
  'skale-base-sepolia': 'SKALE Base Sepolia',
  'skale-bite': 'SKALE BITE V2',
  'polygon': 'Polygon',
  'ethereum': 'Ethereum',
  'telos': 'Telos EVM',
};

/** Legacy CAIP-2 exports for backward compatibility */
export const SOLANA_MAINNET_NETWORK = NETWORK_CAIP2['solana'];
export const BASE_MAINNET_NETWORK = NETWORK_CAIP2['base'];

/** Legacy USDC exports for backward compatibility */
export const USDC_SOLANA = USDC_ADDRESSES['solana'];
export const USDC_BASE = USDC_ADDRESSES['base'];

/** All supported RelAI networks list */
export const RELAI_NETWORKS: RelaiNetwork[] = [
  'solana',
  'base',
  'avalanche',
  'skale-base',
  'skale-base-sepolia',
  'skale-bite',
  'polygon',
  'ethereum',
  'telos',
];

/** Check if a network is Solana-based */
export function isSolana(network: string): boolean {
  return network === 'solana' || network.startsWith('solana:');
}

/** Check if a network is EVM-based */
export function isEvm(network: string): boolean {
  return ['base', 'avalanche', 'skale-base', 'skale-base-sepolia', 'skale-bite', 'polygon', 'ethereum', 'telos'].includes(network) || network.startsWith('eip155:');
}

/** Normalize CAIP-2 or simple name to RelaiNetwork */
export function normalizeNetwork(network: string): RelaiNetwork | null {
  if (RELAI_NETWORKS.includes(network as RelaiNetwork)) return network as RelaiNetwork;
  const fromCaip2 = CAIP2_TO_NETWORK[network];
  if (fromCaip2) return fromCaip2;
  // Partial match
  if (network.startsWith('solana:')) return 'solana';
  if (network.startsWith('eip155:')) {
    const chainId = parseInt(network.split(':')[1]);
    const entry = Object.entries(CHAIN_IDS).find(([, id]) => id === chainId);
    if (entry) return entry[0] as RelaiNetwork;
  }
  return null;
}

// ============================================================================
// Wallet Types
// ============================================================================

/** Solana wallet interface */
export interface SolanaWallet {
  publicKey: { toString(): string } | null;
  signTransaction: ((tx: unknown) => Promise<unknown>) | null;
  signAllTransactions?: ((txs: unknown[]) => Promise<unknown[]>) | null;
}

/** EVM wallet interface (viem-compatible) */
export interface EvmWallet {
  address: string;
  signTypedData: (params: unknown) => Promise<string>;
  chain?: { id: number };
}

/** Wallet set for multi-chain support */
export interface WalletSet {
  solana?: SolanaWallet;
  evm?: EvmWallet;
}

// ============================================================================
// Payment Types
// ============================================================================

/** Extra fields in payment requirements */
export interface AcceptsExtra {
  feePayer?: string;
  decimals?: number;
  name?: string;
  version?: string;
  [key: string]: unknown;
}

/** A single payment option */
export interface PaymentAccept {
  x402Version?: 1 | 2;
  scheme: string;
  network: string;
  maxAmountRequired?: string;
  amount?: string;
  asset: string;
  payTo: string;
  maxTimeoutSeconds?: number;
  extra?: AcceptsExtra;
  resource?: string;
  description?: string;
  mimeType?: string;
  outputSchema?: unknown;
}

/** Resource info for v2 */
export interface ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
}

/** Payment requirements (402 response) */
export interface PaymentRequired {
  x402Version: 1 | 2;
  error?: string;
  accepts: PaymentAccept[];
  resource?: ResourceInfo;
  extensions?: Record<string, unknown>;
}

// ============================================================================
// Config Types (server-specific types are in server.ts)
// ============================================================================
