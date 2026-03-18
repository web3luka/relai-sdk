// src/relay-feedback.ts
// Standalone utility for submitting ERC-8004 feedback about third-party APIs.
// Not a plugin — call directly from your relay/aggregator application code.

import { ethers } from 'ethers';

export interface RelayFeedbackConfig {
  /**
   * ERC-8004 agentId (NFT tokenId) of the **target API** you are calling.
   */
  agentId: string | number;
  /**
   * Whether the API call succeeded.
   */
  success: boolean;
  /**
   * Elapsed milliseconds for the API call.
   */
  responseTimeMs?: number;
  /**
   * Endpoint path of the called API (e.g. '/v1/data').
   */
  endpoint?: string;
  /**
   * Private key of the **relay/third-party** wallet that signs feedback.
   * MUST be different from the API owner's wallet — ReputationRegistry
   * may restrict self-feedback. Wallet needs CREDIT tokens on SKALE Base.
   * Default: process.env.FEEDBACK_WALLET_PRIVATE_KEY
   */
  feedbackWalletPrivateKey?: string;
  /**
   * SKALE Base Sepolia RPC URL.
   * Default: process.env.ERC8004_RPC_URL or SKALE Base Sepolia public RPC.
   */
  rpcUrl?: string;
  /**
   * ERC-8004 ReputationRegistry contract address.
   * Default: process.env.ERC8004_REPUTATION_REGISTRY
   */
  reputationRegistryAddress?: string;
}

const RELAY_FEEDBACK_REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external',
];

/**
 * Submit ERC-8004 on-chain feedback about a **third-party API** you called.
 *
 * Call this fire-and-forget from your relay/aggregator after every external API call.
 * Uses a separate relay wallet (not the API owner's key) to avoid self-feedback restrictions.
 *
 * Records:
 * - `successRate`: 10000 (= 100%) on success, 0 on failure — 2 decimal places
 * - `responseTime`: elapsed milliseconds
 *
 * @example
 * ```typescript
 * import { submitRelayFeedback } from '@relai-fi/x402/relay-feedback';
 *
 * // after calling an external API:
 * const start = Date.now();
 * const result = await fetch('https://other-api.com/data');
 * submitRelayFeedback({
 *   agentId: '5',
 *   success: result.ok,
 *   responseTimeMs: Date.now() - start,
 *   endpoint: '/data',
 * });
 * ```
 */
export function submitRelayFeedback(config: RelayFeedbackConfig): void {
  const agentId = String(config.agentId);
  const endpoint = config.endpoint ?? '';
  const responseTimeMs = config.responseTimeMs ?? 0;

  const privateKey = config.feedbackWalletPrivateKey
    ?? (typeof process !== 'undefined'
      ? process.env?.FEEDBACK_WALLET_PRIVATE_KEY ?? process.env?.ERC8004_FEEDBACK_WALLET_PRIVATE_KEY
      : undefined);
  const reputationAddress = config.reputationRegistryAddress
    ?? (typeof process !== 'undefined' ? process.env?.ERC8004_REPUTATION_REGISTRY : undefined);
  const rpcUrl = config.rpcUrl
    ?? (typeof process !== 'undefined' ? process.env?.ERC8004_RPC_URL : undefined)
    ?? 'https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha';

  if (!privateKey || !reputationAddress) {
    console.warn('[relai:submitRelayFeedback] FEEDBACK_WALLET_PRIVATE_KEY or ERC8004_REPUTATION_REGISTRY not set — skipping');
    return;
  }

  const provider = new ethers.JsonRpcProvider(rpcUrl);
  const signer = new ethers.Wallet(privateKey, provider);
  const reputation = new ethers.Contract(reputationAddress, RELAY_FEEDBACK_REPUTATION_ABI, signer);
  const id = BigInt(agentId);

  (async () => {
    const successValue = config.success ? 10000n : 0n;
    try {
      const srTx = await reputation.giveFeedback(
        id, successValue, 2, 'successRate', '', endpoint, '', ethers.ZeroHash,
      );
      await srTx.wait();
      console.log(`[relai:submitRelayFeedback] successRate confirmed agentId=${agentId} success=${config.success}`);
    } catch (err: any) {
      console.warn(`[relai:submitRelayFeedback] successRate failed (non-fatal): ${err?.message}`);
    }

    if (responseTimeMs > 0) {
      try {
        const rtTx = await reputation.giveFeedback(
          id, BigInt(Math.max(0, Math.round(responseTimeMs))), 0, 'responseTime', '', endpoint, '', ethers.ZeroHash,
        );
        console.log(`[relai:submitRelayFeedback] responseTime sent agentId=${agentId} ms=${responseTimeMs} tx=${rtTx.hash}`);
      } catch (err: any) {
        console.warn(`[relai:submitRelayFeedback] responseTime failed (non-fatal): ${err?.message}`);
      }
    }
  })();
}
