/**
 * React Hook for RelAI x402 Payments
 *
 * Single hook that auto-detects the network from the 402 response and uses
 * the correct signing method. Supports all RelAI facilitator networks:
 * Solana, Base, Avalanche, SKALE Base.
 *
 * @example
 * ```tsx
 * import { useRelaiPayment } from '@relai-fi/x402/react';
 *
 * function PayButton() {
 *   const {
 *     fetch,
 *     isLoading,
 *     status,
 *     error,
 *     transactionUrl,
 *     connectedChains,
 *   } = useRelaiPayment({
 *     wallets: { solana: solanaWallet, evm: evmWalletClient },
 *   });
 *
 *   return (
 *     <button onClick={() => fetch(url)} disabled={isLoading}>
 *       {isLoading ? 'Paying...' : 'Access'}
 *     </button>
 *   );
 * }
 * ```
 */

import { useState, useCallback, useMemo } from 'react';
import {
  createX402Client,
  type X402ClientConfig,
  type X402FetchInit,
  type X402RelayWsConfig,
  type X402IntegritasConfig,
  type X402NetworkSelectionMode,
} from '../client';
import type { SolanaWallet, EvmWallet, WalletSet } from '../types';
import {
  EXPLORER_TX_URL,
  NETWORK_LABELS,
  normalizeNetwork,
  type RelaiNetwork,
} from '../types';

// ============================================================================
// Types
// ============================================================================

export type PaymentStatus = 'idle' | 'pending' | 'success' | 'error';

export interface ConnectedChains {
  solana: boolean;
  evm: boolean;
}

export interface UseRelaiPaymentConfig {
  /** Wallets — pass both Solana + EVM and the hook picks automatically */
  wallets?: WalletSet;
  /** Optional Relay WebSocket transport for /relay/:apiId endpoints */
  relayWs?: X402RelayWsConfig;
  /** Default Integritas behavior for outgoing requests */
  integritas?: boolean | X402IntegritasConfig;
  /** Preferred network when multiple options available */
  preferredNetwork?: RelaiNetwork;
  /** Preferred-network handling mode when multiple accepts are returned */
  networkSelectionMode?: X402NetworkSelectionMode;
  /** Custom Solana RPC URL */
  solanaRpcUrl?: string;
  /** Custom facilitator URL (default: RelAI) */
  facilitatorUrl?: string;
  /** Maximum payment in atomic units (safety guard) */
  maxAmountAtomic?: string;
  /** Verbose console logging */
  verbose?: boolean;
}

export interface UseRelaiPaymentReturn {
  /** Fetch with automatic x402 payment handling */
  fetch: (input: string | URL | Request, init?: X402FetchInit) => Promise<Response>;
  /** Payment in progress */
  isLoading: boolean;
  /** Current status */
  status: PaymentStatus;
  /** Error on failure */
  error: Error | null;
  /** Transaction hash/signature on success */
  transactionId: string | null;
  /** Network the payment was made on */
  transactionNetwork: RelaiNetwork | null;
  /** Human-readable network label */
  transactionNetworkLabel: string | null;
  /** Block explorer URL for the transaction */
  transactionUrl: string | null;
  /** Which chain types have connected wallets */
  connectedChains: ConnectedChains;
  /** Whether any wallet is connected */
  isConnected: boolean;
  /** Reset hook state to idle */
  reset: () => void;
}

// ============================================================================
// Helpers
// ============================================================================

function isSolanaWalletConnected(wallet?: SolanaWallet): boolean {
  return !!(wallet?.publicKey && wallet?.signTransaction);
}

function isEvmWalletConnected(wallet?: EvmWallet): boolean {
  return !!(wallet?.address && wallet?.signTypedData);
}

// ============================================================================
// Hook
// ============================================================================

export function useRelaiPayment(config: UseRelaiPaymentConfig = {}): UseRelaiPaymentReturn {
  const {
    wallets = {},
    relayWs,
    integritas,
    preferredNetwork,
    networkSelectionMode,
    solanaRpcUrl,
    facilitatorUrl,
    maxAmountAtomic,
    verbose = false,
  } = config;

  // State
  const [isLoading, setIsLoading] = useState(false);
  const [status, setStatus] = useState<PaymentStatus>('idle');
  const [error, setError] = useState<Error | null>(null);
  const [transactionId, setTransactionId] = useState<string | null>(null);
  const [transactionNetwork, setTransactionNetwork] = useState<RelaiNetwork | null>(null);

  const log = useCallback((...args: unknown[]) => {
    if (verbose) console.log('[useRelaiPayment]', ...args);
  }, [verbose]);

  // Connected chains derived from wallets
  const connectedChains = useMemo((): ConnectedChains => ({
    solana: isSolanaWalletConnected(wallets.solana),
    evm: isEvmWalletConnected(wallets.evm),
  }), [wallets]);

  const isConnected = connectedChains.solana || connectedChains.evm;

  // Build x402 client (re-created when wallets change)
  const client = useMemo(() => {
    const cfg: X402ClientConfig = {
      wallets,
      relayWs,
      integritas,
      preferredNetwork,
      networkSelectionMode,
      maxAmountAtomic,
      verbose,
    };
    if (solanaRpcUrl) cfg.solanaRpcUrl = solanaRpcUrl;
    if (facilitatorUrl) cfg.facilitatorUrl = facilitatorUrl;
    return createX402Client(cfg);
  }, [
    wallets,
    relayWs,
    integritas,
    preferredNetwork,
    networkSelectionMode,
    solanaRpcUrl,
    facilitatorUrl,
    maxAmountAtomic,
    verbose,
  ]);

  // Reset
  const reset = useCallback(() => {
    setIsLoading(false);
    setStatus('idle');
    setError(null);
    setTransactionId(null);
    setTransactionNetwork(null);
  }, []);

  // Main fetch
  const fetchWithPayment = useCallback(async (
    input: string | URL | Request,
    init?: X402FetchInit,
  ): Promise<Response> => {
    setIsLoading(true);
    setStatus('pending');
    setError(null);
    setTransactionId(null);
    setTransactionNetwork(null);

    if (!isConnected) {
      const err = new Error('No wallet connected. Connect a Solana or EVM wallet.');
      setError(err);
      setStatus('error');
      setIsLoading(false);
      throw err;
    }

    try {
      log('Fetching with x402 client:', input);
      const response = await client.fetch(input, init);

      // Extract transaction info from PAYMENT-RESPONSE header
      const paymentResponse =
        response.headers.get('PAYMENT-RESPONSE') ||
        response.headers.get('payment-response');

      if (paymentResponse) {
        try {
          const decoded = JSON.parse(atob(paymentResponse));
          if (decoded.transaction) setTransactionId(decoded.transaction);
          if (decoded.network) {
            const net = normalizeNetwork(decoded.network);
            if (net) setTransactionNetwork(net);
          }
        } catch {
          log('Could not parse PAYMENT-RESPONSE header');
        }
      }

      setStatus('success');
      return response;
    } catch (err) {
      const e = err instanceof Error ? err : new Error(String(err));
      setError(e);
      setStatus('error');
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, [client, isConnected, log]);

  // Derived: explorer URL
  const transactionUrl = useMemo(() => {
    if (!transactionId || !transactionNetwork) return null;
    const fn = EXPLORER_TX_URL[transactionNetwork as RelaiNetwork];
    return fn ? fn(transactionId) : null;
  }, [transactionId, transactionNetwork]);

  // Derived: network label
  const transactionNetworkLabel = useMemo(() => {
    if (!transactionNetwork) return null;
    return NETWORK_LABELS[transactionNetwork as RelaiNetwork] || transactionNetwork;
  }, [transactionNetwork]);

  return {
    fetch: fetchWithPayment,
    isLoading,
    status,
    error,
    transactionId,
    transactionNetwork,
    transactionNetworkLabel,
    transactionUrl,
    connectedChains,
    isConnected,
    reset,
  };
}
