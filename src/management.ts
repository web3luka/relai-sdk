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
  websiteUrl?: string;
  logoUrl?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ApiEndpointInput {
  path: string;
  method: string;
  usdPrice: number;
  enabled?: boolean;
}

export interface ApiEndpoint extends ApiEndpointInput {
  network: string;
  enabled: boolean;
}

export interface CreateApiInput {
  name: string;
  baseUrl: string;
  merchantWallet: string;
  network: string;
  description?: string;
  websiteUrl?: string;
  logoUrl?: string;
  endpoints?: ApiEndpointInput[];
}

export interface UpdateApiInput {
  name?: string;
  description?: string;
  baseUrl?: string;
  merchantWallet?: string;
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
  };
}
