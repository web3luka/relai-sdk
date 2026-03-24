/**
 * Bridge MPP server — verifies bridged cross-chain payments.
 *
 * The client pays on a source chain and calls the bridge settle endpoint.
 * The settle endpoint executes the cross-chain swap and pays the merchant
 * on the target chain. This server method verifies the target chain tx.
 *
 * Usage:
 * ```ts
 * import { Mppx } from 'mppx/server'
 * import { bridgeCharge } from '@relai-fi/x402/mpp/bridge-server'
 * import { evmCharge } from '@relai-fi/x402/mpp/evm-server'
 *
 * const mppx = Mppx.create({
 *   secretKey: process.env.MPP_SECRET_KEY,
 *   methods: [
 *     // Direct payment on SKALE
 *     evmCharge({ recipient: '0x...', tokenAddress: '0x...', chainId: 1187947933, rpcUrl: '...' }),
 *     // Cross-chain bridge to SKALE
 *     bridgeCharge({ recipient: '0x...', tokenAddress: '0x...', chainId: 1187947933, rpcUrl: '...' }),
 *   ],
 * })
 * ```
 */
import { Method, Receipt } from 'mppx'
import { charge as BridgeChargeMethod } from './bridge-method.js'
import { verifyErc20Transfer } from './verify-erc20.js'
import { verifySplTransfer } from './verify-spl.js'

const RELAI_API_BASE = 'https://api.relai.fi'

export interface BridgeChargeConfig {
  /** Target chain: recipient (merchant) EVM address */
  recipient: string
  /** Target chain: ERC-20 token contract address */
  tokenAddress: string
  /** Target chain: EVM chain ID */
  chainId: number
  /** Target chain: RPC URL for verification */
  rpcUrl: string
  /** Target chain: token decimals (default 6) */
  decimals?: number
  /** Target chain: human-readable network name (e.g. "skale-base") */
  network?: string

  /** Bridge settle endpoint (auto-discovered from /bridge/info if not set) */
  settleEndpoint?: string
  /** Supported source chains in CAIP-2 (auto-discovered if not set) */
  supportedSourceChains?: string[]
  /** Supported source token addresses (auto-discovered if not set) */
  supportedSourceAssets?: string[]
  /** Bridge payTo map: { [caip2]: bridgeReceiverAddress } (auto-discovered if not set) */
  payTo?: Record<string, string>
  /** Solana fee payer address (auto-discovered if not set) */
  feePayerSvm?: string
  /** Bridge fee in basis points (auto-discovered if not set) */
  feeBps?: number
  /** Payment facilitator URL (auto-discovered if not set) */
  paymentFacilitator?: string
  /** RelAI API base URL for auto-discovery (default: https://api.relai.fi) */
  baseUrl?: string
  /** Service key hash for tracking */
  serviceKeyHash?: string
}

interface BridgeInfo {
  settleEndpoint: string
  supportedSourceChains: string[]
  supportedSourceAssets: string[]
  payTo: Record<string, string>
  feePayerSvm: string | null
  feeBps: number
  paymentFacilitator: string
}

let bridgeInfoCache: BridgeInfo | null = null
let bridgeInfoFetchedAt = 0
const BRIDGE_INFO_TTL_MS = 5 * 60 * 1000 // 5 minutes

async function fetchBridgeInfo(baseUrl: string): Promise<BridgeInfo | null> {
  const now = Date.now()
  if (bridgeInfoCache && now - bridgeInfoFetchedAt < BRIDGE_INFO_TTL_MS) {
    return bridgeInfoCache
  }

  try {
    const res = await fetch(`${baseUrl}/bridge/info`)
    if (!res.ok) {
      console.warn(`[relai:bridge-mpp] Failed to fetch /bridge/info: ${res.status}`)
      return bridgeInfoCache // return stale cache if available
    }
    const data = await res.json() as any
    bridgeInfoCache = {
      settleEndpoint: data.settleEndpoint,
      supportedSourceChains: data.supportedSourceChains || [],
      supportedSourceAssets: data.supportedSourceAssets || [],
      payTo: data.payTo || {},
      feePayerSvm: data.feePayerSvm ?? null,
      feeBps: data.feeBps ?? 100,
      paymentFacilitator: data.paymentFacilitator || 'https://facilitator.x402.fi',
    }
    bridgeInfoFetchedAt = now
    return bridgeInfoCache
  } catch (err) {
    console.warn(`[relai:bridge-mpp] Failed to fetch bridge info: ${err}`)
    return bridgeInfoCache
  }
}

export function bridgeCharge(config: BridgeChargeConfig): Method.AnyServer {
  const {
    recipient,
    tokenAddress,
    decimals = 6,
    chainId,
    rpcUrl,
    network,
  } = config

  const baseUrl = (config.baseUrl ?? RELAI_API_BASE).replace(/\/$/, '')

  return Method.toServer(BridgeChargeMethod, {
    defaults: {
      currency: tokenAddress,
      recipient: '',
      methodDetails: {
        reference: '',
        targetChainId: chainId,
        settleEndpoint: '',
        supportedSourceChains: [],
        payToMap: {},
      },
    },

    async request({ credential, request }) {
      if (credential) {
        return credential.challenge.request as typeof request
      }

      // Fetch bridge info (cached)
      const info = await fetchBridgeInfo(baseUrl)

      const settleEndpoint = config.settleEndpoint || info?.settleEndpoint || ''
      const supportedSourceChains = config.supportedSourceChains || info?.supportedSourceChains || []
      const supportedSourceAssets = config.supportedSourceAssets || info?.supportedSourceAssets || []
      const payToMap = config.payTo || info?.payTo || {}
      const feePayerSvm = config.feePayerSvm ?? info?.feePayerSvm ?? undefined
      const feeBps = config.feeBps ?? info?.feeBps ?? 100
      const paymentFacilitator = config.paymentFacilitator || info?.paymentFacilitator || 'https://facilitator.x402.fi'

      // Filter out target chain from source chains AND assets (no self-bridging)
      // The chains and assets arrays are aligned by index, so filter both together.
      const targetCaip2 = `eip155:${chainId}`
      const filteredSourceChains: string[] = []
      const filteredSourceAssets: string[] = []
      for (let i = 0; i < supportedSourceChains.length; i++) {
        if (supportedSourceChains[i] !== targetCaip2) {
          filteredSourceChains.push(supportedSourceChains[i])
          if (supportedSourceAssets[i]) {
            filteredSourceAssets.push(supportedSourceAssets[i])
          }
        }
      }

      return {
        ...request,
        recipient,
        currency: tokenAddress,
        methodDetails: {
          targetChainId: chainId,
          targetNetwork: network || '',
          targetRpcUrl: rpcUrl,
          targetDecimals: decimals,
          settleEndpoint,
          supportedSourceChains: filteredSourceChains,
          supportedSourceAssets: filteredSourceAssets,
          payToMap,
          ...(feePayerSvm ? { feePayerSvm } : {}),
          feeBps,
          paymentFacilitator,
          ...(config.serviceKeyHash ? { serviceKeyHash: config.serviceKeyHash } : {}),
          reference: crypto.randomUUID(),
        },
      }
    },

    async verify({ credential }) {
      const cred = credential as unknown as {
        payload: { type?: string; targetTxHash?: string; sourceTxHash?: string; sourceChain?: string }
        challenge: { request: { amount: string; currency: string; recipient: string } }
      }

      const targetTxHash = cred.payload?.targetTxHash
      if (!targetTxHash) {
        throw new Error('Missing targetTxHash in bridge credential payload')
      }

      const isSolanaTarget = network?.startsWith('solana:') || false

      if (isSolanaTarget) {
        // Solana target — verify SPL token transfer
        await verifySplTransfer({
          txSignature: targetTxHash,
          rpcUrl,
          tokenMint: tokenAddress,
          recipient,
          expectedAmount: BigInt(cred.challenge.request.amount),
        })
      } else {
        // EVM target — verify ERC-20 Transfer event
        if (!targetTxHash.startsWith('0x')) {
          throw new Error('Invalid EVM targetTxHash (expected 0x-prefix)')
        }
        await verifyErc20Transfer({
          txHash: targetTxHash,
          rpcUrl,
          tokenAddress,
          recipient,
          expectedAmount: BigInt(cred.challenge.request.amount),
        })
      }

      return Receipt.from({
        method: 'bridge',
        reference: targetTxHash,
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
}
