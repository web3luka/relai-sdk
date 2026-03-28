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
  encodeFunctionData,
  type Account,
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

// ERC-20 transfer gas is well-known and stable
const ERC20_TRANSFER_GAS = 65_000n

export interface EvmChargeClientConfig {
  /** viem Account (from privateKeyToAccount or similar) */
  account: Account
  /** Optional custom RPC URL — if not provided, uses the one from the challenge */
  rpcUrl?: string
}

// Raw JSON-RPC helper — single call, no viem overhead
async function rpcCall(rpcUrl: string, method: string, params: unknown[]): Promise<any> {
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const json = await res.json() as { result?: any; error?: { message: string } }
  if (json.error) throw new Error(`RPC error: ${json.error.message}`)
  return json.result
}

// Local nonce tracker per address+chainId to avoid stale nonce from RPC
const nonceCache = new Map<string, number>()

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
      const decimals = (methodDetails as any).decimals ?? 6
      const rpcUrl = configRpcUrl || challengeRpcUrl

      if (!rpcUrl) {
        throw new Error('No RPC URL available — provide one in config or challenge must include it')
      }

      // Amount may be in USD decimal ("0.050000") or already atomic ("50000")
      let atomicAmount: bigint
      try {
        atomicAmount = BigInt(amount)
      } catch {
        atomicAmount = BigInt(Math.round(parseFloat(amount) * 10 ** decimals))
      }

      const data = encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [recipient as `0x${string}`, atomicAmount],
      })

      // Fetch nonce and gas price in parallel (2 RPC calls instead of viem's 4+ sequential)
      const cacheKey = `${account.address}:${chainId}`
      const [nonceHex, feeData] = await Promise.all([
        rpcCall(rpcUrl, 'eth_getTransactionCount', [account.address, 'pending']),
        rpcCall(rpcUrl, 'eth_gasPrice', []).then((gp: string) => ({ gasPrice: gp })),
      ])

      const rpcNonce = parseInt(nonceHex, 16)
      const cachedNonce = nonceCache.get(cacheKey) ?? -1
      const nonce = Math.max(rpcNonce, cachedNonce)
      nonceCache.set(cacheKey, nonce + 1)

      // Use gasPrice (works on all EVM chains including SKALE which requires high gasPrice)
      const gasPrice = BigInt(feeData.gasPrice)
      const txParams = {
        to: tokenAddress as `0x${string}`,
        data,
        gas: ERC20_TRANSFER_GAS,
        nonce,
        gasPrice,
        chainId,
      }

      // Sign locally and broadcast raw — single RPC call
      const signedTx = await account.signTransaction!(txParams as any)
      const txHash = await rpcCall(rpcUrl, 'eth_sendRawTransaction', [signedTx])

      // Brief receipt check — if the receipt is already available (Flashblocks, fast chains),
      // grab it to confirm the nonce was consumed. Don't block long — the server verifies independently.
      // 3 attempts × 200ms = 600ms max, enough for Flashblocks (200ms) and most fast chains.
      for (let i = 0; i < 3; i++) {
        if (i > 0) await new Promise((r) => setTimeout(r, 200))
        try {
          const receipt = await rpcCall(rpcUrl, 'eth_getTransactionReceipt', [txHash])
          if (receipt) break
        } catch { /* ignore */ }
      }

      return Credential.serialize({
        challenge,
        payload: { type: 'hash', hash: txHash },
        source: `did:pkh:eip155:${chainId}:${account.address}`,
      })
    },
  })
}
