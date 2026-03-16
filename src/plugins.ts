// src/plugins.ts
// RelAI Plugin System - extensible middleware hooks for Relai.protect()

import type { RelaiNetwork } from './types';
import type { SettleResult } from './server';

const RELAI_API_BASE = 'https://api.relai.fi';

// ============================================================================
// Plugin Interface
// ============================================================================

export interface PluginContext {
  /** Network for this endpoint */
  network: RelaiNetwork;
  /** Price in USD */
  price: number;
  /** Request path */
  path: string;
  /** HTTP method */
  method: string;
}

export interface PluginResult {
  /** If true, skip payment and serve content for free */
  skip?: boolean;
  /** Extra response headers to set */
  headers?: Record<string, string>;
  /** Metadata attached to req.pluginMeta */
  meta?: Record<string, unknown>;
}

export interface RelaiPlugin {
  /** Unique plugin name */
  name: string;

  /**
   * Called before the 402 payment check.
   * Return { skip: true } to bypass payment entirely.
   */
  beforePaymentCheck?(req: any, ctx: PluginContext): Promise<PluginResult>;

  /**
   * Called after a successful payment settlement.
   * Use for analytics, logging, webhooks, etc.
   */
  afterSettled?(req: any, result: SettleResult, ctx: PluginContext): Promise<void>;

  /**
   * Called once when the Relai instance initializes (server start).
   * Use to sync config to RelAI backend or validate credentials.
   */
  onInit?(): Promise<void>;

  /**
   * Called before sending the 402 response. Allows plugins to add
   * extensions or modify the response body (e.g. bridge info).
   */
  enrich402Response?(response: any, ctx: PluginContext): any;
}

// ============================================================================
// Free Tier Plugin
// ============================================================================

export interface FreeTierPluginConfig {
  /** Service key (sk_live_...) for authenticating with RelAI API */
  serviceKey: string;
  /** Max free calls per buyer per period */
  perBuyerLimit: number;
  /** Reset period for per-buyer counters */
  resetPeriod?: 'never' | 'daily' | 'monthly';
  /** Optional global cap across all buyers */
  globalCap?: number;
  /** Specific paths to apply free tier to (default: '*' = all) */
  paths?: string[];
  /** Override RelAI API base URL (default: https://api.relai.fi) */
  baseUrl?: string;
  /** Cache TTL in ms for check results (default: 5000) */
  cacheTtlMs?: number;
}

interface FreeTierCheckResponse {
  free: boolean;
  remaining?: number;
  total?: number;
  reason?: string;
  globalRemaining?: number;
}

/**
 * Free Tier plugin - gives buyers a number of free API calls
 * before requiring payment.
 *
 * State is stored in the RelAI backend, keyed by your service key.
 * Config can be set here (SDK-side) or overridden in the relai.fi dashboard.
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { freeTier } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'base',
 *   plugins: [
 *     freeTier({
 *       serviceKey: process.env.RELAI_SERVICE_KEY!,
 *       perBuyerLimit: 10,
 *       resetPeriod: 'daily',
 *     }),
 *   ],
 * });
 *
 * app.get('/api/data', relai.protect({
 *   payTo: '0xYourWallet',
 *   price: 0.01,
 * }), (req, res) => {
 *   res.json({ data: 'paid content' });
 * });
 * ```
 */
// ============================================================================
// Bridge Plugin
// ============================================================================

export interface BridgePluginConfig {
  /** RelAI API base URL (default: https://api.relai.fi) */
  baseUrl?: string;
  /** Override settle endpoint (auto-discovered from /bridge/info if not set) */
  settleEndpoint?: string;
  /** Override supported source chains (auto-discovered if not set) */
  supportedSourceChains?: string[];
  /** Override supported source assets (auto-discovered if not set) */
  supportedSourceAssets?: string[];
  /** Override bridge payTo map: { [caip2]: address } */
  payTo?: Record<string, string>;
  /** Override Solana fee payer address (auto-discovered if not set) */
  feePayerSvm?: string;
  /** Override payment facilitator URL */
  paymentFacilitator?: string;
  /** Bridge fee in basis points (default: auto-discovered) */
  feeBps?: number;
}

interface BridgeInfo {
  settleEndpoint: string;
  supportedSourceChains: string[];
  supportedSourceAssets: string[];
  payTo: Record<string, string>;
  feePayerSvm: string | null;
  feeBps: number;
  paymentFacilitator: string;
}

/**
 * Bridge plugin - enables cross-chain payments via the RelAI bridge.
 *
 * When a buyer's wallet is on a different chain than the merchant accepts,
 * the client SDK can automatically route the payment through the bridge.
 * This plugin adds `extensions.bridge` to the 402 response with all the
 * info the client needs to execute a cross-chain payment.
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { bridge } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'skale-base',
 *   plugins: [
 *     bridge(), // auto-discovers from https://api.relai.fi
 *   ],
 * });
 *
 * // Buyer on Solana can now pay for a SKALE endpoint
 * app.get('/api/data', relai.protect({
 *   payTo: '0xYourWallet',
 *   price: 0.05,
 * }), (req, res) => {
 *   res.json({ data: 'paid content' });
 * });
 * ```
 */
export function bridge(config?: BridgePluginConfig): RelaiPlugin {
  const base = (config?.baseUrl ?? RELAI_API_BASE).replace(/\/$/, '');
  let bridgeInfo: BridgeInfo | null = null;

  async function fetchBridgeInfo(): Promise<BridgeInfo | null> {
    try {
      const res = await fetch(`${base}/bridge/info`);
      if (!res.ok) {
        console.warn(`[relai:bridge] Failed to fetch /bridge/info: ${res.status}`);
        return null;
      }
      const data = await res.json() as any;
      return {
        settleEndpoint: config?.settleEndpoint || data.settleEndpoint,
        supportedSourceChains: config?.supportedSourceChains || data.supportedSourceChains || [],
        supportedSourceAssets: config?.supportedSourceAssets || data.supportedSourceAssets || [],
        payTo: config?.payTo || data.payTo || {},
        feePayerSvm: config?.feePayerSvm ?? data.feePayerSvm ?? null,
        feeBps: config?.feeBps ?? data.feeBps ?? 100,
        paymentFacilitator: config?.paymentFacilitator || data.paymentFacilitator || 'https://facilitator.x402.fi',
      };
    } catch (err) {
      console.warn(`[relai:bridge] Failed to fetch bridge info: ${err}`);
      return null;
    }
  }

  return {
    name: 'bridge',

    async onInit() {
      bridgeInfo = await fetchBridgeInfo();
      if (bridgeInfo) {
        console.log(`[relai:bridge] Initialized — ${bridgeInfo.supportedSourceChains.length} source chains, settle: ${bridgeInfo.settleEndpoint}`);
      } else {
        console.warn('[relai:bridge] Bridge info not available — cross-chain payments disabled');
      }
    },

    enrich402Response(response: any, ctx: PluginContext) {
      if (!bridgeInfo || bridgeInfo.supportedSourceChains.length === 0) {
        return response;
      }

      // Don't add bridge extension if merchant's network is already a source chain
      // and there's only that one chain — no bridging needed
      const merchantCaip2 = response?.accepts?.[0]?.network;

      // Filter out the merchant's own chain from source chains
      // (buyer on same chain should pay directly, not bridge)
      const otherSourceChains = bridgeInfo.supportedSourceChains.filter(
        (c: string) => c !== merchantCaip2,
      );

      if (otherSourceChains.length === 0) {
        return response;
      }

      // Find the payTo for the first available source chain (Solana-first for UX)
      const solanaChain = otherSourceChains.find((c: string) => c.startsWith('solana:'));
      const primaryPayTo = solanaChain
        ? bridgeInfo.payTo[solanaChain]
        : bridgeInfo.payTo[otherSourceChains[0]];

      response.extensions = response.extensions || {};
      response.extensions.bridge = {
        info: {
          settleEndpoint: bridgeInfo.settleEndpoint,
          supportedSourceChains: otherSourceChains,
          supportedSourceAssets: bridgeInfo.supportedSourceAssets,
          payTo: primaryPayTo || null,
          payToMap: bridgeInfo.payTo,
          feePayerSvm: bridgeInfo.feePayerSvm,
          feeBps: bridgeInfo.feeBps,
          paymentFacilitator: bridgeInfo.paymentFacilitator,
        },
      };

      return response;
    },
  };
}

// ============================================================================
// Free Tier Plugin
// ============================================================================

export function freeTier(config: FreeTierPluginConfig): RelaiPlugin {
  const base = (config.baseUrl ?? RELAI_API_BASE).replace(/\/$/, '');
  const cacheTtl = config.cacheTtlMs ?? 5000;

  // Simple in-memory cache: "serviceKey:path:buyerId" -> { result, expiresAt }
  const cache = new Map<string, { result: FreeTierCheckResponse; expiresAt: number }>();

  function resolveHeaders(): Record<string, string> {
    return {
      'X-Service-Key': config.serviceKey,
      'Content-Type': 'application/json',
    };
  }

  /**
   * Resolve buyer identity from the request.
   * Priority: JWT sub > x-wallet-address > IP fallback
   */
  function resolveBuyerId(req: any): string {
    // 1. JWT Bearer token
    try {
      const auth = req.headers?.authorization || '';
      if (auth.startsWith('Bearer ')) {
        const token = auth.slice(7).trim();
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        if (payload?.sub) return `user:${payload.sub}`;
      }
    } catch { /* ignore */ }

    // 2. Explicit wallet header
    const wallet = req.headers?.['x-wallet-address'] || req.headers?.['x-buyer-address'];
    if (wallet) return `wallet:${wallet}`;

    // 3. IP fallback
    const ip =
      (req.headers?.['x-forwarded-for'] || '').split(',')[0].trim() ||
      req.socket?.remoteAddress ||
      req.ip ||
      'unknown';
    return `ip:${ip}`;
  }

  function cacheKey(path: string, buyerId: string): string {
    return `${config.serviceKey}:${path}:${buyerId}`;
  }

  async function checkFreeTier(path: string, buyerId: string): Promise<FreeTierCheckResponse> {
    const key = cacheKey(path, buyerId);
    const now = Date.now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > now) {
      return cached.result;
    }

    try {
      const res = await fetch(`${base}/v1/plugins/free-tier/check`, {
        method: 'POST',
        headers: resolveHeaders(),
        body: JSON.stringify({ path, buyerId }),
      });

      if (!res.ok) {
        // Non-blocking: if API unreachable, default to not-free
        return { free: false, reason: `api_error_${res.status}` };
      }

      const result = await res.json() as FreeTierCheckResponse;
      cache.set(key, { result, expiresAt: now + cacheTtl });
      return result;
    } catch (err) {
      // Network error - non-blocking, default to paid
      return { free: false, reason: 'network_error' };
    }
  }

  async function recordCall(path: string, buyerId: string): Promise<void> {
    try {
      await fetch(`${base}/v1/plugins/free-tier/record`, {
        method: 'POST',
        headers: resolveHeaders(),
        body: JSON.stringify({ path, buyerId }),
      });
      // Invalidate cache for this buyer+path after recording
      cache.delete(cacheKey(path, buyerId));
    } catch {
      // Fire-and-forget
    }
  }

  async function syncConfig(): Promise<void> {
    try {
      // Check if config already exists on backend — don't overwrite dashboard-managed configs
      const existing = await fetch(`${base}/v1/plugins/free-tier/config`, {
        method: 'GET',
        headers: resolveHeaders(),
      });
      if (existing.ok) {
        const data = await existing.json();
        if (data.configs && data.configs.length > 0) {
          return; // Config managed via dashboard or previous sync — skip
        }
      }

      const paths = config.paths ?? ['*'];
      await fetch(`${base}/v1/plugins/free-tier/config`, {
        method: 'PUT',
        headers: resolveHeaders(),
        body: JSON.stringify({
          perBuyerLimit: config.perBuyerLimit,
          resetPeriod: config.resetPeriod ?? 'never',
          globalCap: config.globalCap ?? null,
          paths,
        }),
      });
    } catch (err) {
      console.warn(`[relai:freeTier] Failed to sync config to RelAI: ${err}`);
    }
  }

  return {
    name: 'free-tier',

    async onInit() {
      await syncConfig();
    },

    async beforePaymentCheck(req, ctx) {
      const requestPath = ctx.path || '/';

      // Check if this path is covered by the plugin
      const paths = config.paths ?? ['*'];
      const pathMatches = paths.includes('*') || paths.some((p) => {
        const normalized = p.toLowerCase().replace(/\/+$/, '') || '/';
        const reqNormalized = requestPath.toLowerCase().replace(/\/+$/, '') || '/';
        return normalized === reqNormalized || normalized === '*';
      });

      if (!pathMatches) {
        return {};
      }

      const buyerId = resolveBuyerId(req);
      const result = await checkFreeTier(requestPath, buyerId);

      if (result.free) {
        // Record the call (fire-and-forget)
        recordCall(requestPath, buyerId).catch(() => {});

        return {
          skip: true,
          headers: {
            'X-Free-Calls-Remaining': String(result.remaining ?? 0),
            'X-Free-Calls-Total': String(result.total ?? config.perBuyerLimit),
            ...(result.globalRemaining != null
              ? { 'X-Free-Calls-Global-Remaining': String(result.globalRemaining) }
              : {}),
          },
          meta: {
            freeTier: true,
            buyerId,
            remaining: result.remaining,
            total: result.total ?? config.perBuyerLimit,
          },
        };
      }

      return {};
    },
  };
}
