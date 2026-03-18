// src/plugins.ts
// RelAI Plugin System - extensible middleware hooks for Relai.protect()

import crypto from 'crypto';
import { ethers } from 'ethers';
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
  /** If true, reject the request entirely (e.g. service unhealthy) */
  reject?: boolean;
  /** HTTP status code when rejecting (default: 503) */
  rejectStatus?: number;
  /** Error message when rejecting */
  rejectMessage?: string;
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
  /** Service key (sk_live_...) for syncing with RelAI backend. If omitted, runs in local in-memory mode. */
  serviceKey?: string;
  /** Max free calls per buyer per period */
  perBuyerLimit: number;
  /** Reset period for per-buyer counters */
  resetPeriod?: 'none' | 'daily' | 'monthly';
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
  /** Service key (sk_live_...) for tracking bridge usage per API owner */
  serviceKey?: string;
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

  // Hash service key for tracking (never expose raw key to clients)
  // Must match backend: crypto.createHash("sha256").update(key).digest("hex").slice(0, 16)
  let serviceKeyHash: string | null = null;
  if (config?.serviceKey) {
    serviceKeyHash = crypto.createHash('sha256').update(config.serviceKey).digest('hex').slice(0, 16);
  }

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
          ...(serviceKeyHash ? { serviceKeyHash } : {}),
        },
      };

      return response;
    },
  };
}

// ============================================================================
// Free Tier Plugin
// ============================================================================

/**
 * Extended plugin interface with data export for free tier.
 */
export interface FreeTierPlugin extends RelaiPlugin {
  /** Export all in-memory usage data (local mode only). Returns null when using cloud mode. */
  getUsageData(): FreeTierUsageExport | null;
  /** Whether plugin is running in local (in-memory) or cloud (RelAI backend) mode. */
  readonly mode: 'local' | 'cloud';
}

export interface FreeTierUsageExport {
  mode: 'local';
  config: {
    perBuyerLimit: number;
    resetPeriod: string;
    globalCap: number | null;
    paths: string[];
  };
  /** Per-buyer usage entries */
  usage: Array<{
    buyerId: string;
    path: string;
    count: number;
    periodStart: string;
    lastCall: string;
  }>;
  globalCount: number;
  exportedAt: string;
}

export function freeTier(config: FreeTierPluginConfig): FreeTierPlugin {
  const base = (config.baseUrl ?? RELAI_API_BASE).replace(/\/$/, '');
  const cacheTtl = config.cacheTtlMs ?? 5000;
  const isLocal = !config.serviceKey;
  const resetPeriod = config.resetPeriod ?? 'none';
  const limit = config.perBuyerLimit;
  const globalCap = config.globalCap ?? null;
  const pluginPaths = config.paths ?? ['*'];

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

  function pathMatches(requestPath: string): boolean {
    return pluginPaths.includes('*') || pluginPaths.some((p) => {
      const normalized = p.toLowerCase().replace(/\/+$/, '') || '/';
      const reqNormalized = requestPath.toLowerCase().replace(/\/+$/, '') || '/';
      return normalized === reqNormalized || normalized === '*';
    });
  }

  // ---------------------------------------------------------------------------
  // LOCAL IN-MEMORY MODE
  // ---------------------------------------------------------------------------

  interface LocalUsageEntry {
    count: number;
    periodStart: string;
    lastCall: string;
  }

  // Map key: "path:buyerId"
  const localUsage = new Map<string, LocalUsageEntry>();
  let localGlobalCount = 0;

  function currentPeriodStart(): string {
    const now = new Date();
    if (resetPeriod === 'daily') {
      return new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    }
    if (resetPeriod === 'monthly') {
      return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
    }
    return 'none'; // permanent
  }

  function isCurrentPeriod(entry: LocalUsageEntry): boolean {
    if (resetPeriod === 'none') return true;
    return entry.periodStart === currentPeriodStart();
  }

  function localKey(path: string, buyerId: string): string {
    return `${path}:${buyerId}`;
  }

  function localCheck(path: string, buyerId: string): FreeTierCheckResponse {
    const key = localKey(path, buyerId);
    const entry = localUsage.get(key);

    // If entry is from a previous period, it's stale — treat as 0
    const count = (entry && isCurrentPeriod(entry)) ? entry.count : 0;
    const remaining = Math.max(0, limit - count);

    // Global cap check
    if (globalCap != null && localGlobalCount >= globalCap) {
      return { free: false, remaining: 0, total: limit, reason: 'global_cap_reached', globalRemaining: 0 };
    }

    if (count >= limit) {
      return { free: false, remaining: 0, total: limit, reason: 'limit_reached' };
    }

    return {
      free: true,
      remaining: remaining - 1, // after this call
      total: limit,
      ...(globalCap != null ? { globalRemaining: globalCap - localGlobalCount - 1 } : {}),
    };
  }

  function localRecord(path: string, buyerId: string): void {
    const key = localKey(path, buyerId);
    const period = currentPeriodStart();
    const entry = localUsage.get(key);
    const now = new Date().toISOString();

    if (entry && isCurrentPeriod(entry)) {
      entry.count++;
      entry.lastCall = now;
    } else {
      localUsage.set(key, { count: 1, periodStart: period, lastCall: now });
    }
    localGlobalCount++;
  }

  function exportLocalData(): FreeTierUsageExport {
    const usage: FreeTierUsageExport['usage'] = [];
    for (const [key, entry] of localUsage.entries()) {
      // key format is "path:buyerId" but buyerId itself can contain ':'
      // We stored it as `${path}:${buyerId}` where path starts with '/'
      // So we find the first ':' after the path portion
      const firstSlash = key.indexOf('/');
      const colonAfterPath = key.indexOf(':', firstSlash > -1 ? firstSlash : 0);
      const path = colonAfterPath > -1 ? key.slice(0, colonAfterPath) : key;
      const buyerId = colonAfterPath > -1 ? key.slice(colonAfterPath + 1) : 'unknown';
      usage.push({
        buyerId,
        path,
        count: entry.count,
        periodStart: entry.periodStart,
        lastCall: entry.lastCall,
      });
    }
    return {
      mode: 'local',
      config: { perBuyerLimit: limit, resetPeriod, globalCap, paths: pluginPaths },
      usage,
      globalCount: localGlobalCount,
      exportedAt: new Date().toISOString(),
    };
  }

  // ---------------------------------------------------------------------------
  // CLOUD MODE (original — requires serviceKey)
  // ---------------------------------------------------------------------------

  // Simple in-memory cache: "serviceKey:path:buyerId" -> { result, expiresAt }
  const cache = new Map<string, { result: FreeTierCheckResponse; expiresAt: number }>();

  function resolveHeaders(): Record<string, string> {
    return {
      'X-Service-Key': config.serviceKey!,
      'Content-Type': 'application/json',
    };
  }

  function cloudCacheKey(path: string, buyerId: string): string {
    return `${config.serviceKey}:${path}:${buyerId}`;
  }

  async function checkFreeTier(path: string, buyerId: string): Promise<FreeTierCheckResponse> {
    const key = cloudCacheKey(path, buyerId);
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
      cache.delete(cloudCacheKey(path, buyerId));
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

      await fetch(`${base}/v1/plugins/free-tier/config`, {
        method: 'PUT',
        headers: resolveHeaders(),
        body: JSON.stringify({
          perBuyerLimit: config.perBuyerLimit,
          resetPeriod: config.resetPeriod ?? 'none',
          globalCap: config.globalCap ?? null,
          paths: pluginPaths,
        }),
      });
    } catch (err) {
      console.warn(`[relai:freeTier] Failed to sync config to RelAI: ${err}`);
    }
  }

  // ---------------------------------------------------------------------------
  // Plugin instance
  // ---------------------------------------------------------------------------

  return {
    name: 'free-tier',
    mode: isLocal ? 'local' : 'cloud',

    getUsageData(): FreeTierUsageExport | null {
      if (!isLocal) return null;
      return exportLocalData();
    },

    async onInit() {
      if (isLocal) {
        console.log(`[relai:freeTier] Running in local mode (in-memory). perBuyerLimit=${limit}, resetPeriod=${resetPeriod}`);
        return;
      }
      await syncConfig();
    },

    async beforePaymentCheck(req, ctx) {
      const requestPath = ctx.path || '/';
      if (!pathMatches(requestPath)) return {};

      const buyerId = resolveBuyerId(req);

      // ── Local mode ──
      if (isLocal) {
        const result = localCheck(requestPath, buyerId);
        if (result.free) {
          localRecord(requestPath, buyerId);
          return {
            skip: true,
            headers: {
              'X-Free-Calls-Remaining': String(result.remaining ?? 0),
              'X-Free-Calls-Total': String(result.total ?? limit),
              ...(result.globalRemaining != null
                ? { 'X-Free-Calls-Global-Remaining': String(result.globalRemaining) }
                : {}),
              'X-Free-Tier-Mode': 'local',
            },
            meta: { freeTier: true, buyerId, remaining: result.remaining, total: result.total ?? limit, mode: 'local' },
          };
        }
        return {};
      }

      // ── Cloud mode ──
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

// ============================================================================
// Shield Plugin
// ============================================================================

export interface ShieldPluginConfig {
  /**
   * Custom health check function. Return true if the service is healthy.
   * Takes priority over `healthUrl` if both are provided.
   */
  healthCheck?: () => Promise<boolean> | boolean;
  /**
   * URL to probe. A 2xx response means healthy.
   * Ignored if `healthCheck` is provided.
   */
  healthUrl?: string;
  /** Timeout in ms for the health probe (default: 5000) */
  timeoutMs?: number;
  /** Cache the health result for this many ms (default: 10000) */
  cacheTtlMs?: number;
  /** Message returned to the caller when unhealthy (default: 'Service temporarily unavailable. Please try again later.') */
  unhealthyMessage?: string;
  /** HTTP status code when unhealthy (default: 503) */
  unhealthyStatus?: number;
}

/**
 * Shield plugin — protects buyers from paying for unhealthy endpoints.
 *
 * Before the server returns a 402, Shield runs a health check (custom
 * function or URL probe). If the service is down, the request is rejected
 * with 503 instead of asking for payment.
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { shield } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'base',
 *   plugins: [
 *     shield({
 *       healthUrl: 'https://my-api.com/health',
 *       timeoutMs: 3000,
 *     }),
 *   ],
 * });
 *
 * // If /health is down, buyers get 503 instead of 402
 * app.get('/api/data', relai.protect({
 *   payTo: '0xYourWallet',
 *   price: 0.01,
 * }), (req, res) => {
 *   res.json({ data: 'premium content' });
 * });
 * ```
 */
export function shield(config?: ShieldPluginConfig): RelaiPlugin {
  const timeoutMs = config?.timeoutMs ?? 5000;
  const cacheTtl = config?.cacheTtlMs ?? 10000;
  const unhealthyMessage = config?.unhealthyMessage ?? 'Service temporarily unavailable. Please try again later.';
  const unhealthyStatus = config?.unhealthyStatus ?? 503;

  let cached: { healthy: boolean; expiresAt: number } | null = null;

  async function checkHealth(): Promise<boolean> {
    const now = Date.now();
    if (cached && cached.expiresAt > now) {
      return cached.healthy;
    }

    let healthy = true;

    try {
      if (config?.healthCheck) {
        healthy = await Promise.resolve(config.healthCheck());
      } else if (config?.healthUrl) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(config.healthUrl, {
            method: 'GET',
            signal: controller.signal,
          });
          healthy = res.ok;
        } finally {
          clearTimeout(timer);
        }
      }
      // No healthCheck and no healthUrl → always healthy (no-op mode)
    } catch {
      healthy = false;
    }

    cached = { healthy, expiresAt: now + cacheTtl };
    return healthy;
  }

  return {
    name: 'shield',

    async onInit() {
      const healthy = await checkHealth();
      console.log(`[relai:shield] Initial health check: ${healthy ? 'healthy ✓' : 'UNHEALTHY ✗'}`);
    },

    async beforePaymentCheck(_req, _ctx): Promise<PluginResult> {
      const healthy = await checkHealth();

      if (!healthy) {
        return {
          reject: true,
          rejectStatus: unhealthyStatus,
          rejectMessage: unhealthyMessage,
          headers: {
            'X-Shield-Status': 'unhealthy',
            'Retry-After': String(Math.ceil(cacheTtl / 1000)),
          },
        };
      }

      return {
        headers: { 'X-Shield-Status': 'healthy' },
      };
    },
  };
}

// ============================================================================
// Preflight Plugin
// ============================================================================

export interface PreflightPluginConfig {
  /**
   * Base URL of the API server (e.g. 'https://my-api.com').
   * The plugin appends the request path to form the probe URL.
   * **Required** — the plugin needs to know where to send the probe.
   */
  baseUrl: string;
  /** Timeout in ms for the preflight probe (default: 3000) */
  timeoutMs?: number;
  /** Cache the probe result for this many ms (default: 5000) */
  cacheTtlMs?: number;
  /** Custom unhealthy message (default: 'Endpoint not responding. Please try again later.') */
  unhealthyMessage?: string;
  /** HTTP status code when endpoint unreachable (default: 503) */
  unhealthyStatus?: number;
}

/**
 * Preflight plugin — verifies the specific endpoint responds before payment.
 *
 * Unlike Shield (global health check), Preflight probes the **actual endpoint**
 * the buyer is requesting. It sends a HEAD request with `X-Preflight: true` —
 * the Relai middleware responds 200 instantly without triggering payment.
 * If the endpoint doesn't respond, the buyer gets 503 instead of 402.
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { preflight } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'base',
 *   plugins: [
 *     preflight({ baseUrl: 'https://my-api.com' }),
 *   ],
 * });
 *
 * app.get('/api/data', relai.protect({
 *   payTo: '0xYourWallet',
 *   price: 0.01,
 * }), (req, res) => {
 *   res.json({ data: 'premium content' });
 * });
 * ```
 */
export function preflight(config: PreflightPluginConfig): RelaiPlugin {
  const baseUrl = config.baseUrl.replace(/\/+$/, '');
  const timeoutMs = config.timeoutMs ?? 3000;
  const cacheTtl = config.cacheTtlMs ?? 5000;
  const unhealthyMessage = config.unhealthyMessage ?? 'Endpoint not responding. Please try again later.';
  const unhealthyStatus = config.unhealthyStatus ?? 503;

  const cache = new Map<string, { ok: boolean; expiresAt: number }>();

  async function probeEndpoint(path: string): Promise<boolean> {
    const now = Date.now();
    const cached = cache.get(path);
    if (cached && cached.expiresAt > now) {
      return cached.ok;
    }

    let ok = false;
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const url = `${baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
        const res = await fetch(url, {
          method: 'HEAD',
          headers: { 'X-Preflight': 'true' },
          signal: controller.signal,
        });
        ok = res.ok;
      } finally {
        clearTimeout(timer);
      }
    } catch {
      ok = false;
    }

    cache.set(path, { ok, expiresAt: now + cacheTtl });
    return ok;
  }

  return {
    name: 'preflight',

    async onInit() {
      // Probe the base URL on startup
      const ok = await probeEndpoint('/');
      console.log(`[relai:preflight] Initial probe ${baseUrl}: ${ok ? 'reachable ✓' : 'UNREACHABLE ✗'}`);
    },

    async beforePaymentCheck(_req, ctx): Promise<PluginResult> {
      const path = ctx.path || '/';
      const ok = await probeEndpoint(path);

      if (!ok) {
        return {
          reject: true,
          rejectStatus: unhealthyStatus,
          rejectMessage: unhealthyMessage,
          headers: {
            'X-Preflight-Status': 'unreachable',
            'Retry-After': String(Math.ceil(cacheTtl / 1000)),
          },
        };
      }

      return {
        headers: { 'X-Preflight-Status': 'ok' },
      };
    },
  };
}


// ============================================================================
// Circuit Breaker Plugin
// ============================================================================

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerPluginConfig {
  /**
   * Number of consecutive failures before the circuit opens.
   * Default: 5
   */
  failureThreshold?: number;
  /**
   * Time in ms the circuit stays open before moving to half-open.
   * Default: 30000 (30 seconds)
   */
  resetTimeMs?: number;
  /**
   * Number of successful requests in half-open state before closing the circuit.
   * Default: 2
   */
  halfOpenSuccesses?: number;
  /** HTTP status code when circuit is open (default: 503) */
  openStatus?: number;
  /** Error message when circuit is open */
  openMessage?: string;
  /**
   * HTTP status codes considered as failures.
   * Default: [500, 502, 503, 504]
   */
  failureCodes?: number[];
  /**
   * Track failures globally or per-path.
   * Default: 'per-path'
   */
  scope?: 'global' | 'per-path';
}

interface CircuitEntry {
  state: CircuitState;
  failures: number;
  successes: number;
  lastFailureAt: number;
}

/**
 * Circuit Breaker plugin — tracks failure history and opens the circuit
 * after repeated failures, preventing buyers from paying for broken endpoints.
 *
 * Unlike Shield/Preflight (real-time probes), Circuit Breaker is **zero-latency** —
 * it makes no additional HTTP requests. Instead, it tracks `afterSettled` outcomes
 * and rejects requests when the failure rate exceeds the threshold.
 *
 * States:
 * - **closed** — normal operation, requests flow through
 * - **open** — too many failures, requests are rejected with 503
 * - **half-open** — after resetTime, allows a few test requests through
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { circuitBreaker } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'base',
 *   plugins: [
 *     circuitBreaker({ failureThreshold: 5, resetTimeMs: 30000 }),
 *   ],
 * });
 * ```
 */
export function circuitBreaker(config?: CircuitBreakerPluginConfig): RelaiPlugin {
  const failureThreshold = config?.failureThreshold ?? 5;
  const resetTimeMs = config?.resetTimeMs ?? 30000;
  const halfOpenSuccesses = config?.halfOpenSuccesses ?? 2;
  const openStatus = config?.openStatus ?? 503;
  const openMessage = config?.openMessage ?? 'Service temporarily unavailable (circuit open). Please try again later.';
  const failureCodes = new Set(config?.failureCodes ?? [500, 502, 503, 504]);
  const scope = config?.scope ?? 'per-path';

  const circuits = new Map<string, CircuitEntry>();

  function getKey(path: string): string {
    return scope === 'global' ? '__global__' : path;
  }

  function getCircuit(key: string): CircuitEntry {
    let entry = circuits.get(key);
    if (!entry) {
      entry = { state: 'closed', failures: 0, successes: 0, lastFailureAt: 0 };
      circuits.set(key, entry);
    }
    return entry;
  }

  function recordFailure(key: string): void {
    const circuit = getCircuit(key);
    circuit.failures++;
    circuit.successes = 0;
    circuit.lastFailureAt = Date.now();

    if (circuit.failures >= failureThreshold) {
      circuit.state = 'open';
    }
  }

  function recordSuccess(key: string): void {
    const circuit = getCircuit(key);
    if (circuit.state === 'half-open') {
      circuit.successes++;
      if (circuit.successes >= halfOpenSuccesses) {
        // Enough successes in half-open → close the circuit
        circuit.state = 'closed';
        circuit.failures = 0;
        circuit.successes = 0;
      }
    } else {
      // Reset failures on success in closed state
      circuit.failures = 0;
      circuit.successes = 0;
    }
  }

  return {
    name: 'circuit-breaker',

    async beforePaymentCheck(_req, ctx): Promise<PluginResult> {
      const key = getKey(ctx.path || '/');
      const circuit = getCircuit(key);
      const now = Date.now();

      // Check if open circuit should transition to half-open
      if (circuit.state === 'open' && (now - circuit.lastFailureAt) >= resetTimeMs) {
        circuit.state = 'half-open';
        circuit.successes = 0;
      }

      if (circuit.state === 'open') {
        const retryAfter = Math.max(1, Math.ceil((resetTimeMs - (now - circuit.lastFailureAt)) / 1000));
        return {
          reject: true,
          rejectStatus: openStatus,
          rejectMessage: openMessage,
          headers: {
            'X-Circuit-State': 'open',
            'X-Circuit-Failures': String(circuit.failures),
            'Retry-After': String(retryAfter),
          },
        };
      }

      return {
        headers: {
          'X-Circuit-State': circuit.state,
          ...(circuit.state === 'half-open' ? { 'X-Circuit-Successes': String(circuit.successes) } : {}),
        },
      };
    },

    async afterSettled(_req, result, ctx): Promise<void> {
      const key = getKey(ctx.path || '/');

      // Check if the settlement itself failed or returned error codes
      if (!result.success) {
        recordFailure(key);
        return;
      }

      // Check response status if available
      const status = (result as any).statusCode || (result as any).status;
      if (status && failureCodes.has(status)) {
        recordFailure(key);
      } else {
        recordSuccess(key);
      }
    },
  };
}


// ============================================================================
// Refund Plugin
// ============================================================================

export interface RefundPluginConfig {
  /**
   * HTTP status codes that trigger a refund/credit after payment.
   * Default: [500, 502, 503, 504]
   */
  triggerCodes?: number[];
  /**
   * What to do when a refund is triggered.
   * - 'credit': record a credit that the free-tier plugin can consume later
   * - 'log': just log the event (useful with a custom onRefund callback)
   * Default: 'credit'
   */
  mode?: 'credit' | 'log';
  /**
   * Called whenever a refund event is triggered.
   * Use for external refund processing, logging, or notifications.
   */
  onRefund?: (event: RefundEvent) => void | Promise<void>;
  /**
   * Also trigger refund when settlement itself fails (result.success === false).
   * Default: true
   */
  refundOnSettlementFailure?: boolean;
}

export interface RefundEvent {
  /** Buyer wallet address */
  payer: string;
  /** Transaction ID of the original payment */
  transactionId: string;
  /** Network used */
  network: string;
  /** Amount paid in USD */
  amount: number;
  /** Request path */
  path: string;
  /** Reason for the refund */
  reason: 'endpoint_error' | 'settlement_failure' | 'timeout';
  /** HTTP status code that triggered the refund (if applicable) */
  statusCode?: number;
  /** Timestamp */
  timestamp: number;
}

/**
 * Refund plugin — automatically handles refund/credit when a paid request fails.
 *
 * After payment settles, if the endpoint returns an error (e.g. 500),
 * the plugin records a credit or calls your custom `onRefund` handler.
 * Credits can be consumed by the free-tier plugin on the next request.
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { refund } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'base',
 *   plugins: [
 *     refund({
 *       triggerCodes: [500, 502, 503],
 *       onRefund: (event) => {
 *         console.log(`Refund for ${event.payer}: $${event.amount} on ${event.path}`);
 *         // Notify buyer, record in DB, etc.
 *       },
 *     }),
 *   ],
 * });
 * ```
 */
export function refund(config?: RefundPluginConfig): RelaiPlugin {
  const triggerCodes = new Set(config?.triggerCodes ?? [500, 502, 503, 504]);
  const mode = config?.mode ?? 'credit';
  const onRefund = config?.onRefund;
  const refundOnSettlementFailure = config?.refundOnSettlementFailure ?? true;

  // In-memory credit ledger: payer → number of credits
  const credits = new Map<string, number>();

  return {
    name: 'refund',

    async beforePaymentCheck(req, ctx): Promise<PluginResult> {
      // If buyer has credits from previous refunds, skip payment
      if (mode === 'credit') {
        const buyerId =
          req.headers?.['x-buyer-id'] ||
          req.headers?.['authorization']?.replace(/^Bearer\s+/i, '') ||
          req.ip ||
          req.socket?.remoteAddress ||
          'unknown';

        const buyerCredits = credits.get(buyerId) || 0;
        if (buyerCredits > 0) {
          credits.set(buyerId, buyerCredits - 1);
          return {
            skip: true,
            headers: {
              'X-Refund-Credit': 'applied',
              'X-Refund-Credits-Remaining': String(buyerCredits - 1),
            },
            meta: {
              refundCredit: true,
              creditsRemaining: buyerCredits - 1,
            },
          };
        }
      }

      return {};
    },

    async afterSettled(req, result, ctx): Promise<void> {
      const payer = result.payer || 'unknown';
      const transactionId = result.transaction || '';

      // Settlement failure
      if (!result.success && refundOnSettlementFailure) {
        const event: RefundEvent = {
          payer,
          transactionId,
          network: ctx.network,
          amount: ctx.price,
          path: ctx.path,
          reason: 'settlement_failure',
          timestamp: Date.now(),
        };

        if (mode === 'credit') {
          const buyerId =
            req.headers?.['x-buyer-id'] ||
            req.ip ||
            req.socket?.remoteAddress ||
            'unknown';
          credits.set(buyerId, (credits.get(buyerId) || 0) + 1);
        }

        try {
          await onRefund?.(event);
        } catch (err) {
          console.warn('[relai:refund] onRefund callback error:', err);
        }
        return;
      }

      // Check for endpoint error codes in settlement result
      const status = (result as any).statusCode || (result as any).status;
      if (status && triggerCodes.has(status)) {
        const event: RefundEvent = {
          payer,
          transactionId,
          network: ctx.network,
          amount: ctx.price,
          path: ctx.path,
          reason: 'endpoint_error',
          statusCode: status,
          timestamp: Date.now(),
        };

        if (mode === 'credit') {
          const buyerId =
            req.headers?.['x-buyer-id'] ||
            req.ip ||
            req.socket?.remoteAddress ||
            'unknown';
          credits.set(buyerId, (credits.get(buyerId) || 0) + 1);
        }

        try {
          await onRefund?.(event);
        } catch (err) {
          console.warn('[relai:refund] onRefund callback error:', err);
        }
      }
    },
  };
}

// Re-export for backwards-compatible import path '@relai-fi/x402/plugins'
export { submitRelayFeedback, type RelayFeedbackConfig } from './relay-feedback';

// ============================================================================
// Score Plugin
// ============================================================================

export interface ScorePluginConfig {
  /**
   * ERC-8004 agentId (NFT tokenId) for this API.
   * Find yours in the RelAI dashboard under "On-chain Identity".
   */
  agentId: string | number;
  /**
   * SKALE Base Sepolia RPC URL.
   * Default: https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha
   */
  rpcUrl?: string;
  /**
   * ERC-8004 IdentityRegistry contract address.
   * Default: process.env.ERC8004_IDENTITY_REGISTRY
   */
  identityRegistryAddress?: string;
  /**
   * ERC-8004 ReputationRegistry contract address.
   * Default: process.env.ERC8004_REPUTATION_REGISTRY
   */
  reputationRegistryAddress?: string;
  /**
   * Cache TTL in ms (default: 5 minutes).
   */
  cacheTtlMs?: number;
}

interface CachedScore {
  score: Record<string, unknown>;
  expiresAt: number;
}

const SCORE_IDENTITY_ABI = [
  'function ownerOf(uint256 tokenId) external view returns (address)',
];

const SCORE_FEEDBACK_TOPIC = ethers.id(
  'NewFeedback(uint256,address,uint64,int128,uint8,string,string,string,string,string,bytes32)'
);

const SCORE_FEEDBACK_IFACE = new ethers.Interface([
  'event NewFeedback(uint256 indexed agentId, address indexed giver, uint64 index, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, string responseURI, bytes32 feedbackHash)',
]);

const SCORE_BATCH = 1900;
const SCORE_HISTORY = 10000;

/**
 * Score plugin — fetches ERC-8004 on-chain reputation for your API
 * directly via RPC and injects it into the 402 response `extensions.score`.
 *
 * Agents can read the score **before paying**, enabling trust-based routing:
 * - `feedbackCount` — number of on-chain feedback entries
 * - `successRate` — 0–100 (% of successful calls)
 * - `avgResponseMs` — average response time in milliseconds
 * - `verified` — true if agentId is registered on-chain
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { score } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'base',
 *   plugins: [
 *     score({ agentId: '5' }),
 *   ],
 * });
 * ```
 */
export function score(config: ScorePluginConfig): RelaiPlugin {
  const agentId = String(config.agentId);
  const cacheTtlMs = config.cacheTtlMs ?? 5 * 60 * 1000;
  const rpcUrl = config.rpcUrl
    ?? (typeof process !== 'undefined' ? process.env?.ERC8004_RPC_URL : undefined)
    ?? 'https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha';

  let cached: CachedScore | null = null;

  function getContracts() {
    const identityAddress = config.identityRegistryAddress
      ?? (typeof process !== 'undefined' ? process.env?.ERC8004_IDENTITY_REGISTRY : undefined);
    const reputationAddress = config.reputationRegistryAddress
      ?? (typeof process !== 'undefined' ? process.env?.ERC8004_REPUTATION_REGISTRY : undefined);
    if (!identityAddress || !reputationAddress) return null;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const identity = new ethers.Contract(identityAddress, SCORE_IDENTITY_ABI, provider);
    return { provider, identity, reputationAddress };
  }

  async function fetchScore(): Promise<Record<string, unknown> | null> {
    if (cached && cached.expiresAt > Date.now()) {
      return cached.score;
    }

    const contracts = getContracts();
    if (!contracts) {
      console.warn(`[relai:score] ERC8004_IDENTITY_REGISTRY or ERC8004_REPUTATION_REGISTRY not set — score disabled`);
      return null;
    }

    const { provider, identity, reputationAddress } = contracts;
    const bigId = BigInt(agentId);

    try {
      let verified = false;
      try {
        const owner = await identity.ownerOf(bigId);
        verified = !!owner;
      } catch {
        // Not registered
      }

      if (!verified) {
        const scoreObj = { feedbackCount: 0, successRate: null, avgResponseMs: null, verified: false, agentId, source: 'erc8004-skale' };
        cached = { score: scoreObj, expiresAt: Date.now() + cacheTtlMs };
        return scoreObj;
      }

      const latest = await provider.getBlockNumber();
      const agentIdTopic = ethers.zeroPadValue(ethers.toBeHex(bigId), 32);
      const logs: any[] = [];

      for (let from = Math.max(0, latest - SCORE_HISTORY); from <= latest; from += SCORE_BATCH) {
        const to = Math.min(from + SCORE_BATCH - 1, latest);
        const chunk = await provider.getLogs({
          address: reputationAddress,
          topics: [SCORE_FEEDBACK_TOPIC, agentIdTopic],
          fromBlock: from,
          toBlock: to,
        });
        logs.push(...chunk);
      }

      const srValues: number[] = [];
      const rtValues: number[] = [];

      for (const log of logs) {
        try {
          const p = SCORE_FEEDBACK_IFACE.parseLog({ topics: log.topics as string[], data: log.data });
          if (!p) continue;
          const val = Number(p.args.value) / Math.pow(10, Number(p.args.valueDecimals));
          if (p.args.tag1 === 'successRate') srValues.push(val);
          else if (p.args.tag1 === 'responseTime') rtValues.push(val);
        } catch { /* skip */ }
      }

      const feedbackCount = srValues.length + rtValues.length;
      const successRate = srValues.length
        ? Math.round(srValues.reduce((a, b) => a + b, 0) / srValues.length)
        : null;
      const avgResponseMs = rtValues.length
        ? Math.round(rtValues.reduce((a, b) => a + b, 0) / rtValues.length)
        : null;

      const scoreObj = { feedbackCount, successRate, avgResponseMs, verified: true, agentId, source: 'erc8004-skale' };
      cached = { score: scoreObj, expiresAt: Date.now() + cacheTtlMs };
      return scoreObj;
    } catch (err) {
      console.warn(`[relai:score] fetchScore RPC error for agentId=${agentId}:`, err);
      return null;
    }
  }

  return {
    name: 'score',

    async onInit() {
      const s = await fetchScore();
      if (s) {
        console.log(`[relai:score] Initialized — agentId=${agentId}, feedback=${s.feedbackCount}, successRate=${s.successRate}%, avgResp=${s.avgResponseMs}ms`);
      } else {
        console.warn(`[relai:score] Could not load score for agentId=${agentId} — score will be omitted from 402 responses`);
      }
    },

    enrich402Response(response: any, _ctx: PluginContext) {
      const scoreData = cached?.score ?? null;
      if (!scoreData) return response;

      return {
        ...response,
        extensions: {
          ...(response.extensions ?? {}),
          score: scoreData,
        },
      };
    },
  };
}

// ============================================================================
// Feedback Plugin
// ============================================================================

export interface FeedbackPluginConfig {
  /**
   * ERC-8004 agentId (NFT tokenId) for this API.
   */
  agentId: string | number;
  /**
   * Private key of the wallet that signs feedback transactions.
   * The wallet must hold CREDIT tokens on SKALE Base to pay gas.
   * Default: process.env.BACKEND_WALLET_PRIVATE_KEY
   */
  walletPrivateKey?: string;
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
  /**
   * Tag2 label for all feedback entries (default: 'x402').
   */
  tag2?: string;
  /**
   * Whether to submit successRate feedback (default: true).
   * Value: 1 (success) or 0 (failure).
   */
  submitSuccessRate?: boolean;
  /**
   * Whether to submit responseTime feedback (default: true).
   * Value: milliseconds elapsed since request start.
   * Requires req.x402StartTime (set automatically if using Relai.protect()).
   */
  submitResponseTime?: boolean;
}

const FEEDBACK_REPUTATION_ABI = [
  'function giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals, string tag1, string tag2, string endpoint, string feedbackURI, bytes32 feedbackHash) external',
];

/**
 * Feedback plugin — submits ERC-8004 on-chain reputation after every successful x402 settlement.
 *
 * Records `successRate` and `responseTime` signals to the ReputationRegistry on SKALE Base.
 * This is the mechanism that **builds** the score that `score()` plugin later reads.
 *
 * Runs fire-and-forget — never blocks the response.
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { score, feedback } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'base',
 *   plugins: [
 *     score({ agentId: '5' }),
 *     feedback({ agentId: '5' }), // needs BACKEND_WALLET_PRIVATE_KEY in env
 *   ],
 * });
 * ```
 */
export function feedback(config: FeedbackPluginConfig): RelaiPlugin {
  const agentId = String(config.agentId);
  const tag2 = config.tag2 ?? 'x402';
  const submitSuccessRate = config.submitSuccessRate ?? true;
  const submitResponseTime = config.submitResponseTime ?? true;

  let _reputation: any = null;

  function getReputation() {
    if (_reputation) return _reputation;

    const privateKey = config.walletPrivateKey
      ?? (typeof process !== 'undefined' ? process.env?.BACKEND_WALLET_PRIVATE_KEY : undefined);
    const reputationAddress = config.reputationRegistryAddress
      ?? (typeof process !== 'undefined' ? process.env?.ERC8004_REPUTATION_REGISTRY : undefined);
    const rpcUrl = config.rpcUrl
      ?? (typeof process !== 'undefined' ? process.env?.ERC8004_RPC_URL : undefined)
      ?? 'https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha';

    if (!privateKey || !reputationAddress) return null;

    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const signer = new ethers.Wallet(privateKey, provider);
    _reputation = new ethers.Contract(reputationAddress, FEEDBACK_REPUTATION_ABI, signer);
    return _reputation;
  }

  function submitAsync(tag1: string, value: number, valueDecimals: number, endpoint: string) {
    const reputation = getReputation();
    if (!reputation) return;

    (async () => {
      try {
        const tx = await reputation.giveFeedback(
          BigInt(agentId),
          BigInt(Math.round(value)),
          valueDecimals,
          tag1,
          tag2,
          endpoint,
          '',
          ethers.ZeroHash,
        );
        console.log(`[relai:feedback] Submitted agentId=${agentId} tag=${tag1} value=${value} tx=${tx.hash}`);
      } catch (err: any) {
        console.warn(`[relai:feedback] giveFeedback failed (non-fatal): ${err?.message}`);
      }
    })();
  }

  return {
    name: 'feedback',

    async onInit() {
      const reputation = getReputation();
      if (reputation) {
        console.log(`[relai:feedback] Initialized — agentId=${agentId}, submitSuccessRate=${submitSuccessRate}, submitResponseTime=${submitResponseTime}`);
      } else {
        console.warn(`[relai:feedback] BACKEND_WALLET_PRIVATE_KEY or ERC8004_REPUTATION_REGISTRY not set — feedback disabled`);
      }
    },

    async afterSettled(req: any, result: SettleResult, ctx: PluginContext) {
      const endpoint = ctx.path ?? '';

      // successRate: 1 = success, 0 = failure
      if (submitSuccessRate) {
        submitAsync('successRate', result.success ? 1 : 0, 0, endpoint);
      }

      // responseTime in ms — use req.x402StartTime if available
      if (submitResponseTime) {
        const startTime = req?.x402StartTime ?? req?.x402StartedAt;
        const responseTimeMs = startTime ? Date.now() - Number(startTime) : 0;
        if (responseTimeMs > 0) {
          submitAsync('responseTime', responseTimeMs, 0, endpoint);
        }
      }
    },
  };
}

// ============================================================================
// Solana Feedback Plugin (8004-solana)
// ============================================================================

export interface SolanaFeedbackPluginConfig {
  /**
   * Solana MPL Core NFT public key (base58) of the registered agent.
   * This is the `solanaAgentAsset` stored after calling /api/solana8004/register.
   */
  assetPubkey: string;
  /**
   * Private key of the feedback wallet — base58 or JSON array format.
   * Should differ from the owner's registration wallet (avoids self-feedback restriction).
   * Default: process.env.SOLANA_8004_FEEDBACK_KEY ?? process.env.SOLANA_8004_PRIVATE_KEY
   */
  feedbackWalletPrivateKey?: string;
  /**
   * Solana cluster to use.
   * Default: process.env.SOLANA_8004_CLUSTER ?? 'mainnet-beta'
   */
  cluster?: 'mainnet-beta' | 'devnet';
  /**
   * Custom Solana RPC URL (Helius / QuickNode recommended).
   * Default: process.env.SOLANA_8004_RPC_URL
   */
  rpcUrl?: string;
  /**
   * Whether to submit successRate feedback (default: true).
   */
  submitSuccessRate?: boolean;
  /**
   * Whether to submit responseTime feedback (default: true).
   */
  submitResponseTime?: boolean;
}

/**
 * Solana Feedback plugin — submits 8004-solana on-chain reputation after x402 settlement.
 *
 * Uses the native Solana `8004-solana` program (MPL Core NFT registry),
 * separate from the SKALE EVM ReputationRegistry used by `feedback()`.
 *
 * Requires `8004-solana` package to be installed:
 * ```
 * npm install 8004-solana
 * ```
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 * import { solanaFeedback } from '@relai-fi/x402/plugins';
 *
 * const relai = new Relai({
 *   network: 'solana',
 *   plugins: [
 *     solanaFeedback({
 *       assetPubkey: process.env.SOLANA_AGENT_ASSET!, // e.g. 'GH93tGR8...'
 *     }),
 *   ],
 * });
 * ```
 */
export function solanaFeedback(config: SolanaFeedbackPluginConfig): RelaiPlugin {
  const assetPubkey = config.assetPubkey;
  const submitSuccessRate = config.submitSuccessRate ?? true;
  const submitResponseTime = config.submitResponseTime ?? true;

  function getPrivateKey(): string | null {
    return config.feedbackWalletPrivateKey
      ?? (typeof process !== 'undefined'
        ? process.env?.SOLANA_8004_FEEDBACK_KEY ?? process.env?.SOLANA_8004_PRIVATE_KEY
        : undefined)
      ?? null;
  }

  function getCluster(): string {
    return config.cluster
      ?? (typeof process !== 'undefined' ? process.env?.SOLANA_8004_CLUSTER : undefined)
      ?? 'mainnet-beta';
  }

  function getRpcUrl(): string | undefined {
    return config.rpcUrl
      ?? (typeof process !== 'undefined' ? process.env?.SOLANA_8004_RPC_URL : undefined);
  }

  async function buildSDK(): Promise<any> {
    let SolanaSDK: any;
    try {
      const mod = await import('8004-solana' as any);
      SolanaSDK = mod.SolanaSDK;
    } catch {
      console.warn('[relai:solanaFeedback] 8004-solana package not installed — run: npm install 8004-solana');
      return null;
    }

    const privateKeyRaw = getPrivateKey();
    if (!privateKeyRaw) return null;

    let secretKey: Uint8Array;
    try {
      const parsed = JSON.parse(privateKeyRaw);
      if (Array.isArray(parsed)) {
        secretKey = Uint8Array.from(parsed);
      } else {
        throw new Error('not array');
      }
    } catch {
      // base58
      try {
        const bs58Mod = await import('bs58' as any);
        const decode = bs58Mod.default?.decode ?? bs58Mod.decode;
        secretKey = decode(privateKeyRaw);
      } catch {
        console.warn('[relai:solanaFeedback] Could not parse feedbackWalletPrivateKey');
        return null;
      }
    }

    const { Keypair } = await import('@solana/web3.js');
    const signer = Keypair.fromSecretKey(secretKey);
    const cluster = getCluster();
    const rpcUrl = getRpcUrl();

    return new SolanaSDK({ cluster, signer, ...(rpcUrl ? { rpcUrl } : {}) });
  }

  function submitAsync(isSuccess: boolean, responseTimeMs: number, endpoint: string) {
    (async () => {
      try {
        const sdk = await buildSDK();
        if (!sdk) return;

        const { PublicKey } = await import('@solana/web3.js');
        const pubkey = new PublicKey(assetPubkey);

        if (submitSuccessRate) {
          try {
            const result = await sdk.giveFeedback(pubkey, {
              value: String(isSuccess ? 10000 : 0),
              tag1: 'successRate',
              tag2: 'x402',
              ...(endpoint ? { endpoint } : {}),
            });
            console.log(`[relai:solanaFeedback] successRate submitted asset=${assetPubkey.slice(0, 8)}... tx=${result.signature}`);
          } catch (err: any) {
            console.warn(`[relai:solanaFeedback] successRate failed (non-fatal): ${err?.message}`);
          }
        }

        if (submitResponseTime && responseTimeMs > 0) {
          try {
            const result = await sdk.giveFeedback(pubkey, {
              value: String(Math.round(responseTimeMs)),
              tag1: 'responseTime',
              tag2: 'x402',
              ...(endpoint ? { endpoint } : {}),
            });
            console.log(`[relai:solanaFeedback] responseTime submitted asset=${assetPubkey.slice(0, 8)}... ms=${responseTimeMs} tx=${result.signature}`);
          } catch (err: any) {
            console.warn(`[relai:solanaFeedback] responseTime failed (non-fatal): ${err?.message}`);
          }
        }
      } catch (err: any) {
        console.warn(`[relai:solanaFeedback] feedback error (non-fatal): ${err?.message}`);
      }
    })();
  }

  return {
    name: 'solanaFeedback',

    async onInit() {
      const privateKey = getPrivateKey();
      if (!privateKey) {
        console.warn('[relai:solanaFeedback] SOLANA_8004_FEEDBACK_KEY not set — Solana feedback disabled');
        return;
      }
      try {
        await import('8004-solana' as any);
        console.log(`[relai:solanaFeedback] Initialized — asset=${assetPubkey.slice(0, 8)}... cluster=${getCluster()}`);
      } catch {
        console.warn('[relai:solanaFeedback] 8004-solana package not installed — run: npm install 8004-solana');
      }
    },

    async afterSettled(req: any, result: SettleResult, ctx: PluginContext) {
      const endpoint = ctx.path ?? '';
      const startTime = req?.x402StartTime ?? req?.x402StartedAt;
      const responseTimeMs = startTime ? Date.now() - Number(startTime) : 0;

      submitAsync(result.success, responseTimeMs, endpoint);
    },
  };
}
