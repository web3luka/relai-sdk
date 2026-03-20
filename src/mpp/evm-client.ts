/**
 * EVM MPP client — signs and broadcasts ERC-20 transfers for MPP payment.
 *
 * Usage:
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { evmCharge } from '@relai-fi/x402/mpp/evm-client'
 *
 * const mppx = Mppx.create({
 *   methods: [evmCharge({ account })],
 *   polyfill: false,
 * })
 * ```
 */
import { Method, Credential } from 'mppx'
import {
  createWalletClient,
  http,
  encodeFunctionData,
  type Account,
  type Chain,
} from 'viem'
import { charge as EvmChargeMethod } from './evm-method.js'

// ERC-20 transfer ABI
const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export interface EvmChargeClientConfig {
  /** viem Account (from privateKeyToAccount or similar) */
  account: Account
  /** Optional custom RPC URL — if not provided, uses the one from the challenge */
  rpcUrl?: string
}

export function evmCharge(config: EvmChargeClientConfig) {
  const { account, rpcUrl: configRpcUrl } = config

  return Method.toClient(EvmChargeMethod, {
    async createCredential({ challenge }) {
      const request = challenge.request as {
        amount: string
        currency: string
        recipient: string
        methodDetails: {
          chainId: number
          network?: string
          rpcUrl?: string
          reference: string
        }
      }

      const { amount, currency: tokenAddress, recipient, methodDetails } = request
      const { chainId, rpcUrl: challengeRpcUrl } = methodDetails
      const rpcUrl = configRpcUrl || challengeRpcUrl

      if (!rpcUrl) {
        throw new Error('No RPC URL available — provide one in config or challenge must include it')
      }

      // Build a minimal chain definition for viem
      const chain: Chain = {
        id: chainId,
        name: methodDetails.network || `eip155:${chainId}`,
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }

      const walletClient = createWalletClient({
        account,
        chain,
        transport: http(rpcUrl),
      })

      // Send ERC-20 transfer
      const txHash = await walletClient.sendTransaction({
        to: tokenAddress as `0x${string}`,
        data: encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [recipient as `0x${string}`, BigInt(amount)],
        }),
      })

      // Wait for confirmation
      const confirmed = await waitForReceipt(rpcUrl, txHash)
      if (!confirmed) {
        throw new Error('Transaction not confirmed within timeout')
      }

      return Credential.serialize({
        challenge,
        payload: { type: 'hash', hash: txHash },
        source: `did:pkh:eip155:${chainId}:${account.address}`,
      })
    },
  })
}

async function waitForReceipt(rpcUrl: string, txHash: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    })
    const data = await res.json() as { result?: { status: string } }
    if (data.result) {
      return data.result.status === '0x1'
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}
