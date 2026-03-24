/**
 * Bridge charge method for MPP — shared schema used by both server and client.
 *
 * Enables cross-chain payments: the client pays on a source chain (e.g. Base),
 * the bridge settles on the merchant's target chain (e.g. SKALE).
 *
 * Composable with direct evm/charge methods via Mppx.compose() — the client
 * receives both challenges and picks direct payment if it has the right wallet,
 * or bridge if it needs cross-chain routing.
 */
import { Method, z } from 'mppx'

export const charge = Method.from({
  intent: 'charge',
  name: 'bridge',
  schema: {
    credential: {
      payload: z.object({
        /** "settled" = client called bridge settle, targetTxHash is proof */
        type: z.string(),
        /** Target chain tx hash (0x-prefixed) — server verifies on-chain */
        targetTxHash: z.optional(z.string()),
        /** Source chain tx hash/signature (for auditing) */
        sourceTxHash: z.optional(z.string()),
        /** CAIP-2 source chain used */
        sourceChain: z.optional(z.string()),
      }),
    },
    request: z.object({
      /** Amount in target token base units */
      amount: z.string(),
      /** Target ERC-20 token contract address */
      currency: z.string(),
      /** Target chain recipient address (merchant) */
      recipient: z.string(),
      /** Human-readable description */
      description: z.optional(z.string()),
      methodDetails: z.object({
        /** Target chain ID (where the merchant gets paid) */
        targetChainId: z.number(),
        /** Human-readable target network name (e.g. "skale-base") */
        targetNetwork: z.optional(z.string()),
        /** Target chain RPC URL (for server-side verification) */
        targetRpcUrl: z.optional(z.string()),
        /** Target token decimals */
        targetDecimals: z.optional(z.number()),
        /** Bridge settle endpoint URL */
        settleEndpoint: z.string(),
        /** Supported source chains (CAIP-2 format, e.g. ["eip155:8453", "solana:5eykt4..."]) */
        supportedSourceChains: z.array(z.string()),
        /** Supported source token addresses */
        supportedSourceAssets: z.optional(z.array(z.string())),
        /** Bridge receiver addresses per source chain: { [caip2]: address } */
        payToMap: z.record(z.string(), z.string()),
        /** Solana fee payer address (bridge facilitator sponsors gas) */
        feePayerSvm: z.optional(z.string()),
        /** Bridge fee in basis points */
        feeBps: z.optional(z.number()),
        /** Payment facilitator URL */
        paymentFacilitator: z.optional(z.string()),
        /** Unique reference ID (for replay protection) */
        reference: z.string(),
      }),
    }),
  },
})
