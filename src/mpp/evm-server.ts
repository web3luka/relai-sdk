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

const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

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

      const expectedAmount = BigInt(cred.challenge.request.amount)

      // Fetch tx receipt
      const receiptRes = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 1,
          method: 'eth_getTransactionReceipt',
          params: [txHash],
        }),
      })
      const receiptData = await receiptRes.json() as { result?: any; error?: { message: string } }

      if (receiptData.error) {
        throw new Error(`RPC error: ${receiptData.error.message}`)
      }

      const receipt = receiptData.result
      if (!receipt) {
        throw new Error('Transaction not found or not yet confirmed')
      }
      if (receipt.status !== '0x1') {
        throw new Error('Transaction failed on-chain')
      }

      // Verify ERC-20 Transfer event
      const recipientPadded = '0x' + recipient.slice(2).toLowerCase().padStart(64, '0')
      const tokenLower = tokenAddress.toLowerCase()

      const matchingLog = (receipt.logs as any[]).find((log: any) => {
        if (log.address.toLowerCase() !== tokenLower) return false
        if (log.topics[0] !== TRANSFER_EVENT_TOPIC) return false
        if (log.topics[2]?.toLowerCase() !== recipientPadded) return false
        return BigInt(log.data) >= expectedAmount
      })

      if (!matchingLog) {
        throw new Error('No matching ERC-20 Transfer found for recipient and amount')
      }

      return Receipt.from({
        method: 'evm',
        reference: txHash,
        status: 'success',
        timestamp: new Date().toISOString(),
      })
    },
  })
}
