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
export type RelaiNetwork = 'solana' | 'base' | 'avalanche' | 'skale-base';

/** CAIP-2 network identifiers */
export const NETWORK_CAIP2: Record<RelaiNetwork, string> = {
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'base': 'eip155:8453',
  'avalanche': 'eip155:43114',
  'skale-base': 'eip155:1187947933',
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
};

/** USDC contract addresses per network */
export const USDC_ADDRESSES: Record<RelaiNetwork, string> = {
  'solana': 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
  'base': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'avalanche': '0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E',
  'skale-base': '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
};

/** Explorer URLs per network */
export const EXPLORER_TX_URL: Record<RelaiNetwork, (tx: string) => string> = {
  'solana': (tx) => `https://solscan.io/tx/${tx}`,
  'base': (tx) => `https://basescan.org/tx/${tx}`,
  'avalanche': (tx) => `https://snowtrace.io/tx/${tx}`,
  'skale-base': (tx) => `https://skale-base-explorer.skalenodes.com/tx/${tx}`,
};

/** Human-readable network labels */
export const NETWORK_LABELS: Record<RelaiNetwork, string> = {
  'solana': 'Solana',
  'base': 'Base',
  'avalanche': 'Avalanche',
  'skale-base': 'SKALE Base',
};

/** Legacy CAIP-2 exports for backward compatibility */
export const SOLANA_MAINNET_NETWORK = NETWORK_CAIP2['solana'];
export const BASE_MAINNET_NETWORK = NETWORK_CAIP2['base'];

/** Legacy USDC exports for backward compatibility */
export const USDC_SOLANA = USDC_ADDRESSES['solana'];
export const USDC_BASE = USDC_ADDRESSES['base'];

/** All supported RelAI networks list */
export const RELAI_NETWORKS: RelaiNetwork[] = ['solana', 'base', 'avalanche', 'skale-base'];

/** Check if a network is Solana-based */
export function isSolana(network: string): boolean {
  return network === 'solana' || network.startsWith('solana:');
}

/** Check if a network is EVM-based */
export function isEvm(network: string): boolean {
  return ['base', 'avalanche', 'skale-base'].includes(network) || network.startsWith('eip155:');
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
