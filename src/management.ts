// src/management.ts
// RelAI Management API client — create and manage monetised APIs programmatically.
// Docs: https://relai.fi/documentation/management-api

const RELAI_API_BASE = 'https://api.relai.fi';
const BOOTSTRAP_URL = `${RELAI_API_BASE}/mcp/management/bootstrap/agent`;

// ============================================================================
// Types
// ============================================================================

export interface ManagementClientConfig {
  /** Service key (sk_live_...) for authenticating management API calls */
  serviceKey: string;
  /** Override base URL (default: https://api.relai.fi) */
  baseUrl?: string;
}

export interface RelaiApi {
  apiId: string;
  name: string;
  description?: string;
  baseUrl: string;
  subdomain?: string | null;
  network: string;
  facilitator: string;
  x402Version: number;
  status: string;
  merchantWallet: string;
  solanaWallet?: string | null;
  /** EVM wallet for cross-chain payments. Only relevant when network is Solana. */
  evmCrossChainWallet?: string | null;
  websiteUrl?: string;
  logoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * OpenAPI-style parameter descriptor (query / path / header).
 * Shown on the marketplace test form so buyers can fill required inputs.
 */
export interface OpenApiParameter {
  name: string;
  in: 'query' | 'path' | 'header';
  required?: boolean;
  description?: string;
  schema?: Record<string, unknown>;
}

/**
 * OpenAPI-style request body descriptor.
 * Accepts either the full OpenAPI shape
 * ({ required, content: { 'application/json': { schema } } })
 * or a simplified { description?, required?: string[], properties?: {...} } shape.
 */
export type OpenApiRequestBody = Record<string, unknown>;

/**
 * Known facilitator identifiers. `string` is kept in the union so new
 * facilitators can be passed without bumping the SDK — the server validates.
 *
 * Support matrix (at time of writing — server is source of truth):
 * - `payai`           solana, solana-devnet, base, base-sepolia, peaq, polygon, sei (v1/v2; peaq+polygon+sei = v1)
 * - `dexter`          solana, base (v2)
 * - `openfacilitator` solana, base (v2)
 * - `relai`           solana, solana-devnet, base, base-sepolia, skale-base, skale-base-sepolia, avalanche, polygon, ethereum, telos (v2)
 * - `autoincentive`   base, base-sepolia (v2)
 * - `stratum`         solana, base (v2)
 * - `thirdweb`        ethereum (v1)
 * - `0xgasless`       avalanche (v2)
 * - `custom`          most networks (v1/v2)
 */
export type Facilitator =
  | 'payai'
  | 'dexter'
  | 'openfacilitator'
  | 'relai'
  | 'autoincentive'
  | 'stratum'
  | 'thirdweb'
  | '0xgasless'
  | 'custom'
  | (string & {});

/** x402 protocol version. */
export type X402Version = 1 | 2;

export interface ApiEndpointInput {
  path: string;
  method: string;
  usdPrice: number;
  enabled?: boolean;
  description?: string;
  /** Query / path / header parameter descriptors (OpenAPI shape). */
  parameters?: OpenApiParameter[];
  /** Request body descriptor for POST/PUT/PATCH endpoints (OpenAPI shape). */
  requestBody?: OpenApiRequestBody;
}

export interface ApiEndpoint extends ApiEndpointInput {
  network: string;
  enabled: boolean;
}

export interface CreateApiInput {
  name: string;
  baseUrl: string;
  merchantWallet: string;
  /** Solana wallet for cross-chain payments. Only relevant when network is EVM. */
  solanaWallet?: string;
  /** EVM wallet for cross-chain payments. Only relevant when network is Solana. */
  evmCrossChainWallet?: string;
  network: string;
  /**
   * Facilitator to settle payments through. Defaults to `relai` whenever the
   * network supports it (every network except `peaq` and `sei`, which fall back
   * to `payai`). Server rejects unsupported (facilitator, network) combinations
   * with a 400.
   */
  facilitator?: Facilitator;
  /**
   * x402 protocol version. Defaults to `2` whenever the (facilitator, network)
   * pair supports v2; v1-only pairs (e.g. `thirdweb` on ethereum) fall back
   * to v1. Validated server-side.
   */
  x402Version?: X402Version;
  description?: string;
  websiteUrl?: string;
  logoUrl?: string;
  endpoints?: ApiEndpointInput[];
  /**
   * Full OpenAPI 3.x specification (object or JSON string). When provided, the spec
   * is saved and the marketplace UI renders full schemas. If `endpoints` is omitted,
   * endpoints are derived from the spec's paths with a default price.
   */
  openApi?: Record<string, unknown> | string;
}

export interface UpdateApiInput {
  name?: string;
  description?: string;
  baseUrl?: string;
  merchantWallet?: string;
  /** Solana wallet for cross-chain payments. Set to null to remove. */
  solanaWallet?: string | null;
  /** EVM wallet for cross-chain payments. Set to null to remove. */
  evmCrossChainWallet?: string | null;
  websiteUrl?: string;
  logoUrl?: string;
}

export interface ApiStats {
  apiId: string;
  totalRequests: number;
  totalRevenue: number;
  currency: string;
}

export interface ApiPayment {
  transaction: string;
  path: string;
  method: string;
  amount: number;
  currency: string;
  network: string;
  status: string;
  success: boolean;
  payer: string;
  createdAt: string;
}

export interface ApiPaymentsResult {
  apiId: string;
  payments: ApiPayment[];
  nextCursor: string | null;
}

export interface ApiLogItem {
  id: string;
  timestamp: string;
  method: string;
  path: string;
  status: string;
  cost: number;
  currency: string;
  duration: number;
  transaction: string;
  network: string;
  success: boolean;
  payer: string;
}

export interface ApiLogsResult {
  items: ApiLogItem[];
  nextCursor: string | null;
}

// ── Bridge types ─────────────────────────────────────────────────────────────

export interface BridgeQuoteResult {
  inputAmount: number;
  outputAmount: number;
  fee: number;
  feeBps: number;
  inputUsd: number;
  outputUsd: number;
  direction: 'solana-to-skale' | 'skale-to-solana';
  from: string;
  to: string;
}

export interface BridgeBalances {
  solana:   { atomic: number; usd: number };
  skaleBase: { atomic: number; usd: number };
  base:      { atomic: number; usd: number };
}

export interface BridgeResult {
  success: boolean;
  direction: 'solana-to-skale' | 'skale-to-solana';
  destinationWallet: string;
  amountOut: number;
  amountOutUsd: number;
  txHash: string;
  explorerUrl: string;
}

export interface AgentBootstrapResult {
  key: string;
  label: string;
  active: boolean;
  createdAt: string;
}

// ============================================================================
// Agent bootstrap (autonomous key provisioning)
// ============================================================================

/**
 * Bootstrap a service key for a Solana agent.
 * Run once — store the returned key securely.
 *
 * @param keypair  A Solana Keypair (from @solana/web3.js)
 * @param label    Human-readable label for the key
 */
export async function bootstrapAgentKeySolana(
  keypair: { publicKey: { toBase58(): string }; secretKey: Uint8Array },
  label = 'agent',
): Promise<AgentBootstrapResult> {
  const { sign } = await import('tweetnacl');

  const publicKey = keypair.publicKey.toBase58();

  // Step 1 — request challenge
  const challengeRes = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  if (!challengeRes.ok) throw new Error(`Challenge request failed: ${challengeRes.status}`);
  const { message } = await challengeRes.json() as { message: string };

  // Step 2 — sign
  const msgBytes = new TextEncoder().encode(message);
  const sigBytes = sign.detached(msgBytes, keypair.secretKey);
  const signature = Buffer.from(sigBytes).toString('base64');

  // Step 3 — get service key
  const keyRes = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, signature, message, label }),
  });
  if (!keyRes.ok) throw new Error(`Key provisioning failed: ${keyRes.status}`);
  return keyRes.json() as Promise<AgentBootstrapResult>;
}

/**
 * Bootstrap a service key for an EVM agent.
 * Run once — store the returned key securely.
 *
 * @param wallet  An ethers.js Wallet or Signer with address + signMessage
 * @param label   Human-readable label for the key
 */
export async function bootstrapAgentKeyEvm(
  wallet: { address: string; signMessage(message: string): Promise<string> },
  label = 'agent',
): Promise<AgentBootstrapResult> {
  const publicKey = wallet.address;

  // Step 1 — request challenge
  const challengeRes = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey }),
  });
  if (!challengeRes.ok) throw new Error(`Challenge request failed: ${challengeRes.status}`);
  const { message } = await challengeRes.json() as { message: string };

  // Step 2+3 — sign and get key
  const signature = await wallet.signMessage(message);
  const keyRes = await fetch(BOOTSTRAP_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ publicKey, signature, message, label }),
  });
  if (!keyRes.ok) throw new Error(`Key provisioning failed: ${keyRes.status}`);
  return keyRes.json() as Promise<AgentBootstrapResult>;
}

// ============================================================================
// Management client
// ============================================================================

export interface RelaiManagementClient {
  // APIs
  createApi(input: CreateApiInput): Promise<RelaiApi>;
  listApis(): Promise<RelaiApi[]>;
  getApi(apiId: string): Promise<RelaiApi>;
  updateApi(apiId: string, input: UpdateApiInput): Promise<RelaiApi>;
  deleteApi(apiId: string): Promise<{ success: boolean; apiId: string }>;

  // Pricing
  getPricing(apiId: string): Promise<{ apiId: string; endpoints: ApiEndpoint[] }>;
  setPricing(apiId: string, endpoints: ApiEndpointInput[]): Promise<{ success: boolean; apiId: string; updated: number }>;

  // Analytics
  getStats(apiId: string): Promise<ApiStats>;
  getPayments(apiId: string, options?: { limit?: number; from?: string; cursor?: string }): Promise<ApiPaymentsResult>;
  getLogs(apiId: string, options?: { limit?: number; from?: string; cursor?: string }): Promise<ApiLogsResult>;

  // Bridge
  /**
   * Get a bridge quote — fee and net output for a given USD amount.
   * @param amount  Amount in USD (e.g. 10.0)
   * @param from    Source network: 'solana' | 'skale-base' (default: 'solana')
   */
  getBridgeQuote(amount: number, from?: 'solana' | 'skale-base'): Promise<BridgeQuoteResult>;

  /**
   * Get current USDC liquidity on all bridge networks.
   * Use this before bridging to confirm availability.
   */
  getBridgeBalances(): Promise<BridgeBalances>;

  /**
   * Bridge USDC from Solana to SKALE Base via x402 payment.
   * This call returns HTTP 402 — pass a createX402Client instance to handle payment automatically.
   *
   * @param amount            Amount in USD
   * @param destinationWallet EVM address on SKALE Base
   * @param x402Client        A configured createX402Client instance for Solana
   */
  bridgeSolanaToSkale(
    amount: number,
    destinationWallet: string,
    x402Client: { fetch(url: string, init?: RequestInit): Promise<Response> },
  ): Promise<BridgeResult>;

  /**
   * Bridge USDC from SKALE Base to Solana via x402 payment.
   *
   * @param amount            Amount in USD
   * @param destinationWallet Solana public key (base58)
   * @param x402Client        A configured createX402Client instance for EVM/SKALE Base
   */
  bridgeSkaleToSolana(
    amount: number,
    destinationWallet: string,
    x402Client: { fetch(url: string, init?: RequestInit): Promise<Response> },
  ): Promise<BridgeResult>;
}

/**
 * Create a RelAI Management API client.
 *
 * @example
 * ```typescript
 * import { createManagementClient } from '@relai-fi/x402/management';
 *
 * const mgmt = createManagementClient({ serviceKey: process.env.RELAI_SERVICE_KEY! });
 *
 * const api = await mgmt.createApi({
 *   name: 'My ML API',
 *   baseUrl: 'https://inference.example.com',
 *   merchantWallet: '0xYourWallet',
 *   network: 'base',
 *   endpoints: [{ path: '/v1/predict', method: 'post', usdPrice: 0.05 }],
 * });
 * ```
 */
export function createManagementClient(config: ManagementClientConfig): RelaiManagementClient {
  const base = (config.baseUrl ?? RELAI_API_BASE).replace(/\/$/, '');
  const headers = {
    'X-Service-Key': config.serviceKey,
    'Content-Type': 'application/json',
  };

  async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`[relai-mgmt] ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async function bridgeReq<T>(
    method: string,
    path: string,
    x402Client: { fetch(url: string, init?: RequestInit): Promise<Response> },
    body?: unknown,
  ): Promise<T> {
    const res = await x402Client.fetch(`${base}${path}`, {
      method,
      headers: { ...headers, 'Content-Type': 'application/json' },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      let parsed: Record<string, unknown> = {};
      try { parsed = JSON.parse(text); } catch { /* ignore */ }
      if (res.status === 503 && parsed['reason'] === 'insufficient_liquidity') {
        const avail = parsed['available'] as number | undefined;
        throw new Error(
          `Bridge temporarily unavailable — insufficient liquidity` +
          (avail != null ? ` (available: $${Number(avail).toFixed(2)} USDC)` : ''),
        );
      }
      throw new Error(`[relai-bridge] ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  return {
    // ── APIs ──────────────────────────────────────────────────────────────

    createApi(input) {
      return req<RelaiApi>('POST', '/v1/apis', input);
    },

    async listApis() {
      const data = await req<{ apis: RelaiApi[] }>('GET', '/v1/apis');
      return data.apis;
    },

    getApi(apiId) {
      return req<RelaiApi>('GET', `/v1/apis/${apiId}`);
    },

    updateApi(apiId, input) {
      return req<RelaiApi>('PATCH', `/v1/apis/${apiId}`, input);
    },

    deleteApi(apiId) {
      return req<{ success: boolean; apiId: string }>('DELETE', `/v1/apis/${apiId}`);
    },

    // ── Pricing ──────────────────────────────────────────────────────────

    getPricing(apiId) {
      return req<{ apiId: string; endpoints: ApiEndpoint[] }>('GET', `/v1/apis/${apiId}/pricing`);
    },

    setPricing(apiId, endpoints) {
      return req<{ success: boolean; apiId: string; updated: number }>('PUT', `/v1/apis/${apiId}/pricing`, { endpoints });
    },

    // ── Analytics ────────────────────────────────────────────────────────

    getStats(apiId) {
      return req<ApiStats>('GET', `/v1/apis/${apiId}/stats`);
    },

    getPayments(apiId, options = {}) {
      const params = new URLSearchParams();
      if (options.limit)  params.set('limit',  String(options.limit));
      if (options.from)   params.set('from',   options.from);
      if (options.cursor) params.set('cursor', options.cursor);
      const qs = params.toString() ? `?${params}` : '';
      return req<ApiPaymentsResult>('GET', `/v1/apis/${apiId}/payments${qs}`);
    },

    getLogs(apiId, options = {}) {
      const params = new URLSearchParams();
      if (options.limit)  params.set('limit',  String(options.limit));
      if (options.from)   params.set('from',   options.from);
      if (options.cursor) params.set('cursor', options.cursor);
      const qs = params.toString() ? `?${params}` : '';
      return req<ApiLogsResult>('GET', `/v1/apis/${apiId}/logs${qs}`);
    },

    // ── Bridge ──────────────────────────────────────────────────

    getBridgeQuote(amount, from = 'solana') {
      const params = new URLSearchParams({ amount: String(amount), from });
      return req<BridgeQuoteResult>('GET', `/v1/bridge/quote?${params}`);
    },

    getBridgeBalances() {
      return req<BridgeBalances>('GET', '/v1/bridge/balances');
    },

    async bridgeSolanaToSkale(amount, destinationWallet, x402Client) {
      return bridgeReq<BridgeResult>(
        'POST',
        '/v1/bridge/solana-to-skale',
        x402Client,
        { amount, destinationWallet },
      );
    },

    async bridgeSkaleToSolana(amount, destinationWallet, x402Client) {
      return bridgeReq<BridgeResult>(
        'POST',
        '/v1/bridge/skale-to-solana',
        x402Client,
        { amount, destinationWallet },
      );
    },
  };
}
