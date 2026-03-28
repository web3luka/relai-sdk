/**
 * EVM MPP server — verifies ERC-20 transfers on-chain for any EVM chain.
 *
 * Usage:
 * ```ts
 * import { Mppx } from 'mppx/server'
 * import { evmCharge } from '@relai-fi/x402/mpp/evm-server'
 *
 * const mppx = Mppx.create({
 *   secretKey: process.env.MPP_SECRET_KEY,
 *   methods: [evmCharge({
 *     recipient: '0x...',
 *     tokenAddress: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20',
 *     chainId: 1187947933,
 *     rpcUrl: 'https://skale-base.skalenodes.com/v1/base',
 *   })],
 * })
 * ```
 */
import { Method, Receipt } from 'mppx'
import { charge as EvmChargeMethod } from './evm-method.js'
import { verifyErc20Transfer } from './verify-erc20.js'

export interface EvmChargeConfig {
  /** Recipient EVM address */
  recipient: string
  /** ERC-20 token contract address (e.g. USDC) */
  tokenAddress: string
  /** Token decimals (default 6) */
  decimals?: number
  /** EVM chain ID */
  chainId: number
  /** RPC URL for this chain */
  rpcUrl: string
  /** Human-readable network name (e.g. "skale-base") */
  network?: string
}

export function evmCharge(config: EvmChargeConfig) {
  const {
    recipient,
    tokenAddress,
    decimals = 6,
    chainId,
    rpcUrl,
    network,
  } = config

  return Method.toServer(EvmChargeMethod, {
    defaults: {
      currency: tokenAddress,
      recipient: '',
      methodDetails: {
        reference: '',
        chainId,
      },
    },

    async request({ credential, request }) {
      if (credential) {
        return credential.challenge.request as typeof request
      }

      return {
        ...request,
        recipient,
        currency: tokenAddress,
        methodDetails: {
          chainId,
          network: network || '',
          decimals,
          rpcUrl,
          reference: crypto.randomUUID(),
        },
      }
    },

    async verify({ credential }) {
      const cred = credential as unknown as {
        payload: { type?: string; hash?: string }
        challenge: { request: { amount: string; currency: string; recipient: string; methodDetails: { chainId: number } } }
      }

      const txHash = cred.payload?.hash
      if (!txHash || !txHash.startsWith('0x')) {
        throw new Error('Missing or invalid transaction hash in credential payload')
      }

      // Amount may be in USD decimal ("0.050000") or already atomic ("50000")
      let expectedAmount: bigint
      try {
        expectedAmount = BigInt(cred.challenge.request.amount)
      } catch {
        expectedAmount = BigInt(Math.round(parseFloat(cred.challenge.request.amount) * 10 ** decimals))
      }

      await verifyErc20Transfer({
        txHash,
        rpcUrl,
        tokenAddress,
        recipient,
        expectedAmount,
      })
      return Receipt.from({
        method: 'evm',
        reference: txHash,
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
}
