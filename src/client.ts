// src/client.ts
import axios, { AxiosRequestConfig, AxiosResponse } from 'axios';
import { createX402Client } from "x402-solana";

export interface RelaiClientHooks {
  onPaymentRequired?: (info: { price: number; description?: string; network?: string }) => void;
  onPaymentVerified?: (info: { signature: string; price: number }) => void;
  onError?: (error: unknown) => void;
}

export interface RelaiClientConfig extends RelaiClientHooks {
  baseUrl?: string;                    // Optional: RelayAI base URL, default https://relai.fi
  network?: 'solana' | 'solana-devnet'; // Optional: Network to use
  rpcUrl?: string;                     // Optional: Solana RPC URL
  maxPaymentAmount?: bigint;           // Optional: Max payment amount in lamports
  wallet?: {                           // Required for payments
    address: string;
    signTransaction: (tx: any) => Promise<any>;
  };
  requestTimeoutMs?: number;           // Optional: HTTP timeout (ms), default 10000
}

export class RelaiClient {
  private config: RelaiClientConfig;
  private baseUrl: string;
  private x402Client: any;

  constructor(config: RelaiClientConfig = {}) {
    this.config = {
      network: "solana",
      baseUrl: "https://relai.fi",
      rpcUrl: "https://api.mainnet-beta.solana.com",
      maxPaymentAmount: BigInt(10_000_000), // Max 10 USDC
      requestTimeoutMs: 10000,
      ...config,
    };
    this.baseUrl = this.config.baseUrl!;

    // Initialize x402Client if wallet is provided
    if (this.config.wallet) {
      this.x402Client = createX402Client({
        wallet: this.config.wallet,
        network: this.config.network as any,
        rpcUrl: this.config.rpcUrl,
        maxPaymentAmount: this.config.maxPaymentAmount,
      });
    }
  }

  /**
   * Get an API instance for a specific apiId from the RelayAI marketplace
   */
  useApi(apiId: string) {
    return {
      call: async (opts: {
        path: string;
        method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
        body?: unknown;
      }): Promise<AxiosResponse> => {
        return this.callApi(apiId, opts);
      }
    };
  }

  /**
   * Call an API from RelayAI marketplace with automatic x402 payment
   */
  private async callApi(apiId: string, opts: {
    path: string;
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
    body?: unknown;
  }): Promise<AxiosResponse> {
    try {
      if (!this.x402Client) {
        throw new Error('Wallet required for payments. Please configure a wallet instance in RelaiClient config.');
      }

      // Use x402Client.fetch which handles 402 responses and payments automatically
      const response = await this.x402Client.fetch(
        `${this.baseUrl}/execute/${apiId}`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            path: opts.path,
            method: opts.method || "GET",
            body: opts.body,
          }),
        }
      );

      // Convert Response to AxiosResponse for backward compatibility
      const data = await response.json();
      return {
        data,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
        config: {} as any,
      } as AxiosResponse;

    } catch (err) {
      this.config.onError?.(err);
      throw err;
    }
  }

  /**
   * Legacy fetch method for backward compatibility (deprecated)
   */
  async fetch(url: string, options: AxiosRequestConfig = {}): Promise<AxiosResponse> {
    console.warn('RelaiClient.fetch() is deprecated. Use useApi(apiId).call() instead.');
    return axios(url, { ...options, timeout: this.config.requestTimeoutMs });
  }
}

export default RelaiClient;
