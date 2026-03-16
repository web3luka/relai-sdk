// src/server.ts
import {
  NETWORK_CAIP2,
  USDC_ADDRESSES,
  RELAI_FACILITATOR_URL,
  resolveToken,
  type NetworkToken,
  type RelaiNetwork,
} from './types';
import type { RelaiPlugin, PluginContext, PluginResult } from './plugins';

// ============================================================================
// Types
// ============================================================================

export interface RelaiServerConfig {
  /** Network to accept payments on */
  network: RelaiNetwork;
  /** RelAI facilitator URL (default: https://facilitator.x402.fi) */
  facilitatorUrl?: string;
  /** Plugins to extend protect() behavior (e.g. freeTier, rateLimit) */
  plugins?: RelaiPlugin[];
}

export type DynamicPrice = number | ((req: any) => number | Promise<number>);

export type RelaiIntegritasFlow = 'single' | 'dual';

export interface RelaiIntegritasOptions {
  /** Enable Integritas by default for this endpoint */
  enabled?: boolean;
  /** Default flow when Integritas is enabled */
  flow?: RelaiIntegritasFlow;
}

export interface ProtectOptions {
  /** Price in USD (e.g., 0.01 for 1 cent) */
  price: DynamicPrice;
  /** Optional token asset address for networks supporting multiple tokens */
  asset?: string;
  /** Wallet address to receive payments, or stripePayTo() for Stripe settlement */
  payTo: string | StripePayTo;
  /** Description shown to payer */
  description?: string;
  /** MIME type of the response (default: application/json) */
  mimeType?: string;
  /** Maximum timeout in seconds (default: 60) */
  maxTimeoutSeconds?: number;
  /** Integritas options (or simple boolean enable flag) */
  integritas?: boolean | RelaiIntegritasOptions;
  /** Override network for this endpoint */
  network?: RelaiNetwork;
  /** Override feePayer address (Solana only) — bypasses facilitator /supported fetch */
  feePayer?: string;
  /** Custom validation after payment is settled */
  customRules?: (req: any) => boolean | Promise<boolean>;
  /** Callback when 402 is returned (no payment provided) */
  onPaymentRequired?: (req: any, info: { price: number; network: RelaiNetwork }) => void;
  /** Callback when payment is settled successfully */
  onPaymentSettled?: (req: any, result: SettleResult) => void;
  /** Callback on error */
  onError?: (req: any, error: unknown) => void;
}

export interface SettleResult {
  success: boolean;
  transaction?: string;
  payer?: string;
  network?: string;
  splitTransfers?: Record<string, unknown>;
  integritasFeePaid?: boolean;
  provenance?: Record<string, unknown>;
  integritas?: Record<string, unknown>;
  error?: string;
  errorReason?: string;
}

export interface PaymentInfo {
  verified: boolean;
  transactionId?: string;
  payer?: string;
  network: RelaiNetwork;
  amount: number;
}

// ============================================================================
// Stripe Pay-To Helper
// ============================================================================

/** Config returned by stripePayTo() - used by protect() to create Stripe deposit addresses */
export interface StripePayTo {
  readonly __brand: 'stripePayTo';
  readonly secretKey: string;
  /** Stripe crypto deposits network (default: 'base') */
  readonly stripeNetwork: string;
}

/**
 * Create a Stripe pay-to configuration for x402 payments.
 * Payments settle as USD in your Stripe Dashboard - no crypto knowledge required.
 *
 * Stripe creates a fresh PaymentIntent + deposit address per request.
 * Network is auto-set to Base (Stripe settles USDC on Base).
 *
 * @example
 * ```typescript
 * import Relai, { stripePayTo } from '@relai-fi/x402/server';
 *
 * const relai = new Relai({ network: 'base' });
 *
 * app.get('/api/data', relai.protect({
 *   price: 0.01,
 *   payTo: stripePayTo(process.env.STRIPE_SECRET_KEY!),
 * }), (req, res) => {
 *   res.json({ data: 'paid content' });
 * });
 * ```
 */
export function stripePayTo(
  stripeSecretKey: string,
  options?: { network?: string },
): StripePayTo {
  if (!stripeSecretKey) {
    throw new Error('stripePayTo requires a Stripe secret key');
  }
  return {
    __brand: 'stripePayTo' as const,
    secretKey: stripeSecretKey,
    stripeNetwork: options?.network || 'base',
  };
}

const USD_PRICE_CACHE_TTL_MS = 60 * 1000;
const usdPriceCache = new Map<string, { usd: number; expiresAt: number }>();

const GECKOTERMINAL_NETWORK_BY_RELAI: Partial<Record<RelaiNetwork, string>> = {
  polygon: 'polygon_pos',
};

const COINGECKO_ID_BY_SYMBOL: Record<string, string> = {
  WETH:  'ethereum',
  WBTC:  'bitcoin',
  USDT:  'tether',
  EURC:  'euro-coin',
  DAI:   'dai',
  cbETH: 'coinbase-wrapped-staked-eth',
  cbBTC: 'coinbase-wrapped-btc',
};

function isStableUsdToken(token: NetworkToken): boolean {
  if (token.isStableUsd === true) return true;
  const symbol = String(token.symbol || '').toUpperCase();
  return symbol === 'USDC' || symbol === 'USDT';
}

async function fetchUsdPriceFromCoinGecko(coinId: string): Promise<number> {
  const now = Date.now();
  const cached = usdPriceCache.get(coinId);
  if (cached && cached.expiresAt > now) {
    return cached.usd;
  }

  const url = `https://api.coingecko.com/api/v3/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=usd`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`CoinGecko price request failed: HTTP ${res.status}`);
  }

  const payload = await res.json() as Record<string, { usd?: number }>;
  const usd = Number(payload?.[coinId]?.usd);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`CoinGecko returned invalid usd price for ${coinId}`);
  }

  usdPriceCache.set(coinId, {
    usd,
    expiresAt: now + USD_PRICE_CACHE_TTL_MS,
  });

  return usd;
}

async function fetchUsdPriceFromGeckoTerminal(network: RelaiNetwork, tokenAddress: string): Promise<number> {
  const geckoNetwork = GECKOTERMINAL_NETWORK_BY_RELAI[network];
  if (!geckoNetwork) {
    throw new Error(`GeckoTerminal network not configured for ${network}`);
  }

  const normalizedAddress = String(tokenAddress || '').trim().toLowerCase();
  if (!normalizedAddress) {
    throw new Error('GeckoTerminal requires a token address');
  }

  const cacheKey = `gt:${geckoNetwork}:${normalizedAddress}`;
  const now = Date.now();
  const cached = usdPriceCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return cached.usd;
  }

  const url = `https://api.geckoterminal.com/api/v2/networks/${encodeURIComponent(geckoNetwork)}/tokens/${encodeURIComponent(normalizedAddress)}`;
  const res = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!res.ok) {
    throw new Error(`GeckoTerminal price request failed: HTTP ${res.status}`);
  }

  const payload = await res.json() as { data?: { attributes?: { price_usd?: string | number } } };
  const usd = Number(payload?.data?.attributes?.price_usd);
  if (!Number.isFinite(usd) || usd <= 0) {
    throw new Error(`GeckoTerminal returned invalid usd price for ${normalizedAddress} on ${geckoNetwork}`);
  }

  usdPriceCache.set(cacheKey, {
    usd,
    expiresAt: now + USD_PRICE_CACHE_TTL_MS,
  });

  return usd;
}

async function resolveAmountAtomicFromUsd({
  priceUsd,
  token,
  network,
}: {
  priceUsd: number;
  token: NetworkToken;
  network: RelaiNetwork;
}): Promise<string> {
  const decimals = Number(token.decimals);
  if (!Number.isFinite(decimals) || decimals < 0) {
    throw new Error(`Invalid token decimals for ${token.symbol || token.address}`);
  }

  if (isStableUsdToken(token)) {
    const units = Math.floor(priceUsd * Math.pow(10, decimals));
    return String(Math.max(1, units));
  }

  const symbol = String(token.symbol || '').toUpperCase();
  const coinGeckoId = COINGECKO_ID_BY_SYMBOL[symbol];
  if (!coinGeckoId) {
    throw new Error(`No USD quote source configured for token ${symbol || token.address} on ${network}`);
  }

  const overrideEnv = process.env[`EVM_TOKEN_PRICE_${symbol}_USD`];
  let usdPerToken: number;
  if (overrideEnv && Number(overrideEnv) > 0) {
    usdPerToken = Number(overrideEnv);
  } else {
    try {
      usdPerToken = await fetchUsdPriceFromCoinGecko(coinGeckoId);
    } catch (coinGeckoError) {
      try {
        usdPerToken = await fetchUsdPriceFromGeckoTerminal(network, token.address);
      } catch (geckoTerminalError) {
        throw new Error(
          `USD quote failed for ${symbol || token.address} on ${network}. CoinGecko: ${coinGeckoError instanceof Error ? coinGeckoError.message : String(coinGeckoError)}; GeckoTerminal: ${geckoTerminalError instanceof Error ? geckoTerminalError.message : String(geckoTerminalError)}`,
        );
      }
    }
  }

  const tokenAmount = priceUsd / usdPerToken;
  const rawUnits = tokenAmount * Math.pow(10, decimals);

  if (!Number.isFinite(rawUnits) || rawUnits <= 0) {
    throw new Error(
      `Invalid conversion result for token ${symbol || token.address}: priceUsd=${priceUsd}, usdPerToken=${usdPerToken}`,
    );
  }

  return String(Math.max(1, Math.floor(rawUnits)));
}

/** @internal Type guard for StripePayTo */
function isStripePayTo(payTo: unknown): payTo is StripePayTo {
  return (
    typeof payTo === 'object' &&
    payTo !== null &&
    (payTo as any).__brand === 'stripePayTo'
  );
}

function parseBooleanHeader(value: unknown): boolean | null {
  if (value == null) return null;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1' || normalized === 'yes' || normalized === 'on') {
    return true;
  }
  if (normalized === 'false' || normalized === '0' || normalized === 'no' || normalized === 'off') {
    return false;
  }
  return null;
}

function normalizeIntegritasFlow(value: unknown): RelaiIntegritasFlow | undefined {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'single') return 'single';
  if (normalized === 'dual') return 'dual';
  return undefined;
}

function normalizeIntegritasOptions(
  value: boolean | RelaiIntegritasOptions | undefined,
): { enabled: boolean; flow?: RelaiIntegritasFlow } {
  if (value === true) return { enabled: true };
  if (value === false || value == null) return { enabled: false };

  const flow = normalizeIntegritasFlow(value.flow);
  const enabled =
    typeof value.enabled === 'boolean'
      ? value.enabled
      : true;

  return {
    enabled,
    ...(flow ? { flow } : {}),
  };
}

/**
 * @internal Create a Stripe PaymentIntent with crypto payment method
 * and extract the deposit address.
 */
async function createStripeDepositAddress(
  secretKey: string,
  amountUsdCents: number,
  network: string = 'base',
): Promise<string> {
  const params = new URLSearchParams();
  params.append('amount', String(amountUsdCents));
  params.append('currency', 'usd');
  params.append('payment_method_types[]', 'crypto');
  params.append('payment_method_data[type]', 'crypto');
  params.append('confirm', 'true');

  const res = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${secretKey}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    const msg = err?.error?.message || res.statusText;

    // Provide actionable guidance for common issues
    if (msg.includes('unknown parameter') || msg.includes('crypto')) {
      throw new Error(
        `Stripe crypto payins not enabled on this account. ` +
        `Enable at: https://support.stripe.com/questions/get-started-with-pay-with-crypto ` +
        `(Original: ${msg})`,
      );
    }
    throw new Error(`Stripe PaymentIntent creation failed: ${msg}`);
  }

  const pi = await res.json() as any;
  const depositDetails = pi.next_action?.crypto_collect_deposit_details;
  if (!depositDetails) {
    throw new Error(
      'Stripe PaymentIntent missing crypto deposit details. ' +
      'Ensure crypto payins are enabled: https://support.stripe.com/questions/get-started-with-pay-with-crypto',
    );
  }

  const address = depositDetails.deposit_addresses?.[network]?.address;
  if (!address) {
    throw new Error(`No Stripe deposit address for network: ${network}`);
  }

  return address;
}

// ============================================================================
// Relai Server SDK
// ============================================================================

/**
 * Server-side SDK for protecting Express endpoints with x402 micropayments.
 * Settles payments through the RelAI facilitator (zero gas fees for users).
 *
 * Supports: Solana, Base, Avalanche, SKALE Base, SKALE Base Sepolia, SKALE BITE, Polygon, and Ethereum.
 *
 * @example
 * ```typescript
 * import Relai from '@relai-fi/x402/server';
 *
 * const relai = new Relai({ network: 'base' });
 *
 * app.get('/api/data', relai.protect({
 *   payTo: '0xYourWallet',
 *   price: 0.01,  // $0.01 USDC
 * }), (req, res) => {
 *   res.json({ data: 'Protected content', payment: req.payment });
 * });
 * ```
 */
export class Relai {
  private network: RelaiNetwork;
  private facilitatorUrl: string;
  private feePayerCache: Map<string, string> = new Map(); // Cache feePayer per network
  private plugins: RelaiPlugin[];
  private pluginInitPromise: Promise<void> | null = null;

  constructor(config: RelaiServerConfig) {
    this.network = config.network;
    this.facilitatorUrl = config.facilitatorUrl || RELAI_FACILITATOR_URL;
    this.plugins = config.plugins ?? [];
  }

  private async runPluginInit(): Promise<void> {
    for (const plugin of this.plugins) {
      if (plugin.onInit) {
        try {
          await plugin.onInit();
        } catch (err) {
          console.warn(`[Relai] Plugin '${plugin.name}' init failed:`, err);
        }
      }
    }
  }

  /**
   * Get feePayer address for a network (cached)
   */
  private async getFeePayer(caip2: string): Promise<string | undefined> {
    // Check cache first
    if (this.feePayerCache.has(caip2)) {
      return this.feePayerCache.get(caip2);
    }

    // If using RelAI facilitator, use hardcoded address (no fetch needed)
    const isRelAI = this.facilitatorUrl.includes('facilitator.x402.fi') || 
                    this.facilitatorUrl.includes('relai');
    
    if (isRelAI) {
      const relaiFeePayer = '0x1892f72fdB3A966b2AD8595aA5f7741Ef72d6085';
      this.feePayerCache.set(caip2, relaiFeePayer);
      return relaiFeePayer;
    }

    // For other facilitators, fetch from /supported
    try {
      const supportedUrl = `${this.facilitatorUrl}/supported`;
      const supportedRes = await fetch(supportedUrl);
      if (supportedRes.ok) {
        const supportedData = await supportedRes.json();
        // Cache all feePayers from supported kinds
        supportedData.kinds?.forEach((kind: any) => {
          if (kind.network && kind.extra?.feePayer) {
            this.feePayerCache.set(kind.network, kind.extra.feePayer);
          }
        });
        return this.feePayerCache.get(caip2);
      }
    } catch (err) {
      // feePayer MUST come from facilitator - cannot use env for security
      console.error(`[Relai] Failed to fetch feePayer from facilitator: ${err}`);
    }
    return undefined;
  }

  /**
   * Express middleware to protect an endpoint with x402 micropayments.
   *
   * Flow:
   * 1. No payment header → returns 402 with payment requirements
   * 2. Payment header present → calls RelAI facilitator `/settle`
   * 3. Settlement success → sets `PAYMENT-RESPONSE` header, attaches `req.payment`, calls `next()`
   */
  protect(options: ProtectOptions) {
    const self = this;

    return async (req: any, res: any, next: any) => {
      try {
        // Resolve dynamic price
        const resolvedPrice = typeof options.price === 'function'
          ? await options.price(req)
          : options.price;

        if (typeof resolvedPrice !== 'number' || !isFinite(resolvedPrice) || resolvedPrice <= 0) {
          return res.status(400).json({ error: 'Invalid price configuration' });
        }

        // Resolve network (Stripe auto-sets to base)
        const stripeConfig = isStripePayTo(options.payTo) ? options.payTo : null;
        const network = stripeConfig
          ? (stripeConfig.stripeNetwork as RelaiNetwork) || 'base'
          : (options.network || self.network);
        const caip2 = NETWORK_CAIP2[network];
        const requestedAsset =
          typeof options.asset === 'string' && options.asset.trim() !== ''
            ? options.asset.trim()
            : undefined;
        const explicitToken = requestedAsset ? resolveToken(network, requestedAsset) : null;
        if (requestedAsset && !explicitToken) {
          return res.status(400).json({
            error: `Unsupported asset ${requestedAsset} for network ${network}`,
          });
        }

        const fallbackToken: NetworkToken = {
          address: USDC_ADDRESSES[network],
          symbol: 'USDC',
          name: network === 'skale-bite' ? 'USDC' : 'USD Coin',
          decimals: 6,
          domainVersion: network === 'skale-bite' ? '1' : '2',
          isStableUsd: true,
        };
        const token = explicitToken || resolveToken(network) || fallbackToken;
        const asset = token.address;
        const tokenName = token.name || 'USD Coin';
        const tokenVersion = token.domainVersion || (network === 'skale-bite' ? '1' : '2');
        const tokenDecimals = Number.isFinite(Number(token.decimals)) ? Number(token.decimals) : 6;

        let amount: string;
        try {
          amount = await resolveAmountAtomicFromUsd({
            priceUsd: resolvedPrice,
            token,
            network,
          });
        } catch (err) {
          console.error('[Relai] Failed to convert USD amount to token units:', err);
          return res.status(500).json({
            error: 'Failed to quote token amount for payment requirements',
          });
        }

        const configuredIntegritas = normalizeIntegritasOptions(options.integritas);
        const headerIntegritasEnabled = parseBooleanHeader(req.headers['x-integritas']);
        const headerIntegritasFlow = normalizeIntegritasFlow(req.headers['x-integritas-flow']);
        const integritasEnabled =
          headerIntegritasEnabled === null
            ? configuredIntegritas.enabled
            : headerIntegritasEnabled;
        const integritasFlow = headerIntegritasFlow || configuredIntegritas.flow;
        const integritasMode =
          integritasFlow === 'single'
            ? 'single_signature_fee_included'
            : (integritasFlow === 'dual' ? 'dual_signature_split' : undefined);

        // Check for payment header (base64-encoded JSON)
        const paymentHeader =
          req.headers['x-payment'] ||
          req.headers['payment-signature'] ||
          req.headers['x-payment-signature'];

        // -----------------------------------------------------------
        // Plugin hooks: beforePaymentCheck
        // If any plugin returns { skip: true }, bypass payment entirely.
        // Ensure plugins are initialized (config synced) before checking.
        // -----------------------------------------------------------
        if (!paymentHeader && self.plugins.length > 0) {
          if (!self.pluginInitPromise) {
            self.pluginInitPromise = self.runPluginInit();
          }
          await self.pluginInitPromise;
          const pluginCtx: PluginContext = {
            network,
            price: resolvedPrice,
            path: req.path || req.originalUrl || '/',
            method: (req.method || 'GET').toUpperCase(),
          };

          for (const plugin of self.plugins) {
            if (!plugin.beforePaymentCheck) continue;
            try {
              const pluginResult = await plugin.beforePaymentCheck(req, pluginCtx);
              if (pluginResult?.skip) {
                // Set plugin-provided headers
                if (pluginResult.headers) {
                  for (const [k, v] of Object.entries(pluginResult.headers)) {
                    res.setHeader(k, v);
                  }
                }
                // Attach plugin metadata to request
                req.pluginMeta = { ...(req.pluginMeta || {}), ...(pluginResult.meta || {}) };
                req.x402Paid = false;
                req.x402Free = true;
                req.x402Plugin = plugin.name;
                return next();
              }
            } catch (pluginErr) {
              console.warn(`[Relai] Plugin '${plugin.name}' beforePaymentCheck error (non-blocking):`, pluginErr);
            }
          }
        }

        // -----------------------------------------------------------
        // No payment → return 402 Payment Required
        // -----------------------------------------------------------
        if (!paymentHeader) {
          options.onPaymentRequired?.(req, { price: resolvedPrice, network });

          // Resolve payTo address (Stripe creates a fresh deposit address per request)
          let resolvedPayTo: string;
          if (stripeConfig) {
            const amountInCents = Math.max(1, Math.round(resolvedPrice * 100));
            resolvedPayTo = await createStripeDepositAddress(
              stripeConfig.secretKey,
              amountInCents,
              stripeConfig.stripeNetwork,
            );
          } else {
            resolvedPayTo = options.payTo as string;
          }

          // Get facilitator feePayer address — use explicit override if provided, otherwise fetch
          const feePayer = (options.feePayer as string | undefined) || await self.getFeePayer(caip2);

          return res.status(402).json({
            x402Version: 2,
            error: 'Payment required',
            resource: {
              url: `${req.protocol}://${req.get('host')}${req.originalUrl}`,
              description: options.description || 'API access',
              mimeType: options.mimeType || 'application/json',
            },
            accepts: [{
              scheme: 'exact',
              network: caip2,
              amount,
              asset,
              payTo: resolvedPayTo,
              maxTimeoutSeconds: options.maxTimeoutSeconds || 60,
              extra: {
                name: tokenName,
                version: tokenVersion,
                decimals: tokenDecimals,
                symbol: token.symbol,
                ...(feePayer && { feePayer }), // Add feePayer if available
                ...(integritasEnabled ? { integritasEnabled: true } : {}),
                ...(integritasFlow ? { integritasFlow } : {}),
                ...(integritasMode ? { integritasMode } : {}),
                ...(integritasFlow === 'single' ? { integritasSingleSignature: true } : {}),
              },
            }],
            ...((configuredIntegritas.enabled || integritasEnabled || !!integritasFlow)
              ? {
                  extensions: {
                    integritas: {
                      available: true,
                      selectedFlow: integritasFlow || null,
                      availableFlows: ['single', 'dual'],
                      enabled: integritasEnabled,
                    },
                  },
                }
              : {}),
          });
        }

        // -----------------------------------------------------------
        // Payment header present → parse and settle via facilitator
        // -----------------------------------------------------------
        let paymentProof: any;
        try {
          // Try base64 first (standard x402 format)
          const decoded = Buffer.from(paymentHeader, 'base64').toString('utf-8');
          paymentProof = JSON.parse(decoded);
        } catch {
          try {
            // Fallback: raw JSON string
            paymentProof = JSON.parse(paymentHeader);
          } catch {
            return res.status(400).json({
              x402Version: 2,
              error: 'Invalid payment header — expected base64-encoded JSON',
            });
          }
        }

        // Resolve payTo for settle (extract from signed proof when using Stripe)
        let settlePayTo: string;
        if (stripeConfig) {
          settlePayTo =
            paymentProof.payload?.authorization?.to ||
            paymentProof.accepted?.payTo ||
            '';
          if (!settlePayTo) {
            return res.status(400).json({
              x402Version: 2,
              error: 'Cannot extract destination address from payment proof',
            });
          }
        } else {
          settlePayTo = options.payTo as string;
        }

        // Build payment requirements for facilitator
        const paymentRequirements = {
          scheme: 'exact',
          network: caip2,
          amount,
          asset,
          payTo: settlePayTo,
          maxTimeoutSeconds: options.maxTimeoutSeconds || 60,
          extra: {
            name: tokenName,
            version: tokenVersion,
            decimals: tokenDecimals,
            symbol: token.symbol,
            ...(integritasEnabled ? { integritasEnabled: true } : {}),
            ...(integritasFlow ? { integritasFlow } : {}),
            ...(integritasMode ? { integritasMode } : {}),
            ...(integritasFlow === 'single' ? { integritasSingleSignature: true } : {}),
          },
        };

        // Call facilitator /settle
        const settleUrl = `${self.facilitatorUrl}/settle`;
        const settleRes = await fetch(settleUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            paymentPayload: paymentProof,
            paymentRequirements,
          }),
        });

        const result: SettleResult = await settleRes.json() as SettleResult;

        if (!result.success) {
          return res.status(402).json({
            x402Version: 2,
            error: result.errorReason || result.error || 'Payment settlement failed',
          });
        }

        // Attach payment info to request
        const paymentInfo: PaymentInfo = {
          verified: true,
          transactionId: result.transaction,
          payer: result.payer,
          network,
          amount: resolvedPrice,
        };
        req.payment = paymentInfo;
        req.x402Payer = result.payer;
        req.x402Paid = true;
        req.x402Transaction = result.transaction;
        req.x402Network = network;

        // Set x402 v2 PAYMENT-RESPONSE header (base64 JSON)
        const paymentResponse = {
          x402Version: 2,
          scheme: 'exact',
          network: caip2,
          transaction: result.transaction,
          payer: result.payer,
          amount,
          asset,
        };
        res.setHeader(
          'PAYMENT-RESPONSE',
          Buffer.from(JSON.stringify(paymentResponse)).toString('base64'),
        );

        options.onPaymentSettled?.(req, result);

        // Plugin hooks: afterSettled
        if (self.plugins.length > 0) {
          const settleCtx: PluginContext = {
            network,
            price: resolvedPrice,
            path: req.path || req.originalUrl || '/',
            method: (req.method || 'GET').toUpperCase(),
          };
          for (const plugin of self.plugins) {
            if (!plugin.afterSettled) continue;
            try {
              await plugin.afterSettled(req, result, settleCtx);
            } catch (pluginErr) {
              console.warn(`[Relai] Plugin '${plugin.name}' afterSettled error (non-blocking):`, pluginErr);
            }
          }
        }

        // Custom validation after payment
        if (options.customRules) {
          const valid = await options.customRules(req);
          if (!valid) {
            return res.status(403).json({ error: 'Custom validation failed' });
          }
        }

        next();
      } catch (error) {
        options.onError?.(req, error);
        console.error('[Relai] Protection error:', error);
        res.status(500).json({ error: 'Internal server error' });
      }
    };
  }
}

export default Relai;
