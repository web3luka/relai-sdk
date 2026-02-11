/**
 * Utility to convert x402 payment payloads between v1 and v2 formats.
 * 
 * V1 PaymentPayload format:
 * {
 *   "x402Version": 1,
 *   "scheme": "exact",
 *   "network": "solana",
 *   "payload": { ... }
 * }
 * 
 * V2 PaymentPayload format:
 * {
 *   "x402Version": 2,
 *   "resource": { "url": "...", "description": "...", "mimeType": "..." },
 *   "accepted": { "scheme": "exact", "network": "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", ... },
 *   "payload": { ... }
 * }
 */

// Network name mappings between v1 (simple names) and v2 (CAIP-2)
export const NETWORK_V1_TO_V2: Record<string, string> = {
  'solana': 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  'base': 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  'ethereum': 'eip155:1',
  'polygon': 'eip155:137',
  'avalanche': 'eip155:43114',
  'skale-base': 'eip155:1187947933',
  'peaq': 'eip155:3338',
  'sei': 'eip155:1329',
};

export const NETWORK_V2_TO_V1: Record<string, string> = Object.fromEntries(
  Object.entries(NETWORK_V1_TO_V2).map(([k, v]) => [v, k])
);

/**
 * Convert CAIP-2 network identifier to simple v1 network name
 */
export function networkV2ToV1(caip2Network: string): string {
  if (!caip2Network) return 'solana';
  
  // Direct lookup
  if (NETWORK_V2_TO_V1[caip2Network]) {
    return NETWORK_V2_TO_V1[caip2Network];
  }
  
  // Handle partial matches for Solana
  if (caip2Network.startsWith('solana:')) {
    const chainId = caip2Network.split(':')[1];
    if (chainId === '5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp') return 'solana';
    if (chainId === 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1') return 'solana-devnet';
    return 'solana';
  }
  
  // Handle EVM chains by chain ID
  if (caip2Network.startsWith('eip155:')) {
    const chainId = caip2Network.split(':')[1];
    const mapping: Record<string, string> = {
      '1': 'ethereum',
      '137': 'polygon',
      '8453': 'base',
      '84532': 'base-sepolia',
      '43114': 'avalanche',
      '1187947933': 'skale-base',
      '3338': 'peaq',
      '1329': 'sei',
    };
    return mapping[chainId] || caip2Network;
  }
  
  return caip2Network;
}

/**
 * Convert simple v1 network name to CAIP-2 identifier
 */
export function networkV1ToV2(v1Network: string): string {
  if (!v1Network) return 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
  return NETWORK_V1_TO_V2[v1Network] || v1Network;
}

export type X402Version = 1 | 2;

export interface V1PaymentPayload {
  x402Version: 1;
  scheme: string;
  network: string;
  payload: {
    transaction?: string;
    signature?: string;
    authorization?: unknown;
  };
  facilitatorUrl?: string;
}

export interface V2PaymentPayload {
  x402Version: 2;
  resource: {
    url: string;
    description?: string;
    mimeType?: string;
  };
  accepted: {
    scheme: string;
    network: string;
    amount?: string;
    maxAmountRequired?: string;
    asset?: string;
    payTo?: string;
    maxTimeoutSeconds?: number;
    extra?: Record<string, unknown>;
  };
  payload: {
    transaction?: string;
    signature?: string;
    authorization?: unknown;
  };
  facilitatorUrl?: string;
}

export type PaymentPayload = V1PaymentPayload | V2PaymentPayload;

/**
 * Detect x402 version from payload
 */
export function detectPayloadVersion(payload: unknown): X402Version | null {
  if (!payload || typeof payload !== 'object') return null;
  
  const p = payload as Record<string, unknown>;
  
  if (p.x402Version === 1) return 1;
  if (p.x402Version === 2) return 2;
  
  // Heuristics if x402Version is missing
  if ('accepted' in p && 'resource' in p) return 2;
  if ('scheme' in p && 'network' in p && !('accepted' in p)) return 1;
  
  return null;
}

/**
 * Convert v2 payment payload to v1 format
 */
export function convertV2ToV1(v2Payload: V2PaymentPayload): V1PaymentPayload {
  const accepted = v2Payload.accepted || {};
  
  return {
    x402Version: 1,
    scheme: accepted.scheme || 'exact',
    network: networkV2ToV1(accepted.network),
    payload: v2Payload.payload,
  };
}

/**
 * Convert v1 payment payload to v2 format
 */
export function convertV1ToV2(
  v1Payload: V1PaymentPayload,
  resourceInfo: { url?: string; description?: string; mimeType?: string } = {}
): V2PaymentPayload {
  return {
    x402Version: 2,
    resource: {
      url: resourceInfo.url || '',
      description: resourceInfo.description || '',
      mimeType: resourceInfo.mimeType || 'application/json',
    },
    accepted: {
      scheme: v1Payload.scheme || 'exact',
      network: networkV1ToV2(v1Payload.network),
    },
    payload: v1Payload.payload,
  };
}

/**
 * Convert payment payload to target version
 */
export function convertPayloadToVersion(
  payload: PaymentPayload,
  targetVersion: X402Version,
  options: { resourceInfo?: { url?: string; description?: string; mimeType?: string } } = {}
): PaymentPayload | null {
  const sourceVersion = detectPayloadVersion(payload);
  
  if (!sourceVersion) {
    console.warn('[payload-converter] Could not detect source payload version');
    return null;
  }
  
  // No conversion needed
  if (sourceVersion === targetVersion) {
    return payload;
  }
  
  // V2 -> V1
  if (sourceVersion === 2 && targetVersion === 1) {
    return convertV2ToV1(payload as V2PaymentPayload);
  }
  
  // V1 -> V2
  if (sourceVersion === 1 && targetVersion === 2) {
    return convertV1ToV2(payload as V1PaymentPayload, options.resourceInfo);
  }
  
  return null;
}

/**
 * Normalize payment header for target x402 version
 */
export function normalizePaymentHeader(
  base64Header: string,
  targetVersion: X402Version,
  options: { resourceInfo?: { url?: string; description?: string; mimeType?: string } } = {}
): { header: string; payload: PaymentPayload } | null {
  if (!base64Header) return null;
  
  try {
    const decoded = JSON.parse(
      typeof window !== 'undefined' 
        ? atob(base64Header) 
        : Buffer.from(base64Header, 'base64').toString()
    );
    const converted = convertPayloadToVersion(decoded, targetVersion, options);
    
    if (!converted) {
      return null;
    }
    
    const encoded = typeof window !== 'undefined'
      ? btoa(JSON.stringify(converted))
      : Buffer.from(JSON.stringify(converted)).toString('base64');
    
    return {
      header: encoded,
      payload: converted,
    };
  } catch (e) {
    console.error('[payload-converter] Failed to normalize header:', e);
    return null;
  }
}

/**
 * Check if network is Solana-based
 */
export function isSolanaNetwork(network: string): boolean {
  return network === 'solana' || 
         network === 'solana-devnet' || 
         network.startsWith('solana:');
}

/**
 * Check if network is EVM-based
 */
export function isEvmNetwork(network: string): boolean {
  const evmNetworks = ['base', 'base-sepolia', 'ethereum', 'polygon', 'avalanche', 'skale-base', 'peaq', 'sei'];
  return evmNetworks.includes(network) || network.startsWith('eip155:');
}

// ============================================================================
// Amount Conversion Utilities
// ============================================================================

/**
 * Convert USD amount to atomic units
 * @param usd - Amount in USD (e.g., 0.05)
 * @param decimals - Token decimals (default: 6 for USDC)
 * @returns Atomic units as string
 */
export function toAtomicUnits(usd: number, decimals: number = 6): string {
  return Math.floor(usd * Math.pow(10, decimals)).toString();
}

/**
 * Convert atomic units to USD amount
 * @param atomic - Atomic units (string or bigint)
 * @param decimals - Token decimals (default: 6 for USDC)
 * @returns USD amount as number
 */
export function fromAtomicUnits(atomic: string | bigint, decimals: number = 6): number {
  const value = typeof atomic === 'bigint' ? atomic : BigInt(atomic);
  return Number(value) / Math.pow(10, decimals);
}

/**
 * Format USD amount for display
 * @param usd - Amount in USD
 * @param maxDecimals - Maximum decimal places (default: 4)
 * @returns Formatted string
 */
export function formatUsd(usd: number, maxDecimals: number = 4): string {
  if (usd < 0.0001) return '<$0.0001';
  return `$${usd.toFixed(maxDecimals).replace(/\.?0+$/, '')}`;
}
