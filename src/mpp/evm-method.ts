/**
 * EVM charge method for MPP — shared schema used by both server and client.
 *
 * Supports ERC-20 token transfers on any EVM chain (SKALE, Base, Polygon, etc.).
 * The client sends a tx hash after broadcasting, and the server verifies the
 * Transfer event on-chain.
 *
 * SKALE chains are gas-free, making them ideal for MPP micropayments.
 */
import { Method, z } from 'mppx'

export const charge = Method.from({
  intent: 'charge',
  name: 'evm',
  schema: {
    credential: {
      payload: z.object({
        /** "hash" = client already broadcast, server verifies on-chain */
        type: z.string(),
        /** Transaction hash (0x-prefixed) */
        hash: z.optional(z.string()),
      }),
    },
    request: z.object({
      /** Amount in token base units (e.g. "10000" for $0.01 USDC with 6 decimals) */
      amount: z.string(),
      /** ERC-20 token contract address */
      currency: z.string(),
      /** Recipient EVM address */
      recipient: z.string(),
      /** Human-readable description */
      description: z.optional(z.string()),
      methodDetails: z.object({
        /** EVM chain ID */
        chainId: z.number(),
        /** Human-readable network name (e.g. "skale-base") */
        network: z.optional(z.string()),
        /** Token decimals */
        decimals: z.optional(z.number()),
        /** RPC URL for the chain (optional, server provides for client convenience) */
        rpcUrl: z.optional(z.string()),
        /** Unique reference ID */
        reference: z.string(),
      }),
    }),
  },
})
