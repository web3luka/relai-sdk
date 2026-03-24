/**
 * Core bridge utilities — shared between x402 and MPP clients.
 *
 * Auto-discovers bridge info from the RelAI API and provides helpers
 * for executing cross-chain payments transparently.
 *
 * Usage (MPP):
 * ```ts
 * import { evmChargeWithBridge } from '@relai-fi/x402/mpp/with-bridge'
 * ```
 *
 * Usage (x402):
 * ```ts
 * import { createX402Client } from '@relai-fi/x402'
 * const client = createX402Client({ ..., bridge: { enabled: true } })
 * ```
 */

const RELAI_API_BASE = 'https://api.relai.fi'

export interface BridgeInfo {
  settleEndpoint: string
  supportedSourceChains: string[]
  supportedSourceAssets: string[]
  payTo: Record<string, string>
  feePayerSvm: string | null
  feeBps: number
  paymentFacilitator: string
}

export interface BridgeSettleRequest {
  /** x402 mode: base64-encoded payment header */
  sourcePayment?: string
  /** MPP mode: source tx hash */
  sourceTxHash?: string
  /** MPP mode: wallet address that sent the source tx */
  senderAddress?: string
  /** MPP mode: signature of (sourceTxHash + JSON(targetAccept)) */
  senderSignature?: string
  /** CAIP-2 source chain identifier */
  sourceChain: string
  targetAccept: {
    scheme: 'exact'
    network: string
    asset: string
    payTo: string
    amount: string
  }
  /** x402 payment requirements (full 402 body) — needed by settle for x402 flow */
  requirements?: any
  resource?: string
  paymentFacilitator?: string | null
}

export interface BridgeSettleResponse {
  success?: boolean
  targetTxId?: string
  sourceTxId?: string
  /** x402 payment header (returned by x402-flavored settle) */
  xPayment?: string
}

// ── Cache (keyed by base URL) ──────────────────────────────────────────

const _cacheMap = new Map<string, { info: BridgeInfo; time: number }>()
const CACHE_TTL = 5 * 60 * 1000 // 5 minutes

/**
 * Fetch bridge info from the RelAI API (cached per base URL for 5 minutes).
 */
export async function getBridgeInfo(baseUrl = RELAI_API_BASE): Promise<BridgeInfo> {
  const key = baseUrl.replace(/\/$/, '')
  const now = Date.now()
  const cached = _cacheMap.get(key)
  if (cached && now - cached.time < CACHE_TTL) return cached.info

  const url = `${key}/bridge/info`
  const res = await fetch(url)
  if (!res.ok) {
    if (cached) return cached.info // stale cache better than failure
    throw new Error(`[relai:bridge] Failed to fetch ${url}: ${res.status}`)
  }

  const data = (await res.json()) as any
  const info: BridgeInfo = {
    settleEndpoint: data.settleEndpoint,
    supportedSourceChains: data.supportedSourceChains || [],
    supportedSourceAssets: data.supportedSourceAssets || [],
    payTo: data.payTo || {},
    feePayerSvm: data.feePayerSvm ?? null,
    feeBps: data.feeBps ?? 100,
    paymentFacilitator: data.paymentFacilitator || 'https://facilitator.x402.fi',
  }
  _cacheMap.set(key, { info, time: now })
  return info
}

/**
 * Call the bridge settle endpoint.
 */
export async function settleBridge(
  settleEndpoint: string,
  body: BridgeSettleRequest,
): Promise<BridgeSettleResponse> {
  const res = await fetch(settleEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as any
    throw new Error(`[relai:bridge] settle failed: ${err.error || res.status}${err.details ? ' — ' + err.details : ''}`)
  }

  return res.json() as Promise<BridgeSettleResponse>
}

/**
 * Select a source chain from supported chains that matches the available wallet.
 */
export function selectSourceChain(
  supportedChains: string[],
  hasEvmWallet: boolean,
  hasSolanaWallet: boolean,
  preferredSourceChainId?: number,
): { type: 'evm' | 'solana'; chain: string } | null {
  // If a specific source chain is preferred, try it first
  if (preferredSourceChainId && hasEvmWallet) {
    const preferred = `eip155:${preferredSourceChainId}`
    if (supportedChains.includes(preferred)) {
      return { type: 'evm', chain: preferred }
    }
  }

  // Solana first (lower fees)
  if (hasSolanaWallet) {
    const sol = supportedChains.find((c) => c.startsWith('solana:'))
    if (sol) return { type: 'solana', chain: sol }
  }

  // Then any EVM chain
  if (hasEvmWallet) {
    for (const chain of supportedChains) {
      if (chain.startsWith('eip155:')) {
        return { type: 'evm', chain }
      }
    }
  }

  return null
}

/**
 * Compute source amount including bridge fee.
 */
export function computeSourceAmount(targetAmount: bigint, feeBps: number): bigint {
  const fee = (targetAmount * BigInt(feeBps)) / 10000n
  return targetAmount + fee
}

// Known EVM RPC URLs (fallback)
export const DEFAULT_EVM_RPC: Record<string, string> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:137': 'https://polygon-rpc.com',
  'eip155:1': 'https://eth.llamarpc.com',
  'eip155:42161': 'https://arb1.arbitrum.io/rpc',
  'eip155:43114': 'https://api.avax.network/ext/bc/C/rpc',
  'eip155:1187947933': 'https://skale-base.skalenodes.com/v1/base',
}
