// src/server.ts
import {
  NETWORK_CAIP2,
  USDC_ADDRESSES,
  RELAI_FACILITATOR_URL,
  type RelaiNetwork,
} from './types';

// ============================================================================
// Types
// ============================================================================

export interface RelaiServerConfig {
  /** Network to accept payments on */
  network: RelaiNetwork;
  /** RelAI facilitator URL (default: https://facilitator.x402.fi) */
  facilitatorUrl?: string;
}

export type DynamicPrice = number | ((req: any) => number | Promise<number>);

export interface ProtectOptions {
  /** Price in USD (e.g., 0.01 for 1 cent) */
  price: DynamicPrice;
  /** Wallet address to receive payments, or stripePayTo() for Stripe settlement */
  payTo: string | StripePayTo;
  /** Description shown to payer */
  description?: string;
  /** MIME type of the response (default: application/json) */
  mimeType?: string;
  /** Maximum timeout in seconds (default: 60) */
  maxTimeoutSeconds?: number;
  /** Override network for this endpoint */
  network?: RelaiNetwork;
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

/** @internal Type guard for StripePayTo */
function isStripePayTo(payTo: unknown): payTo is StripePayTo {
  return (
    typeof payTo === 'object' &&
    payTo !== null &&
    (payTo as any).__brand === 'stripePayTo'
  );
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

  constructor(config: RelaiServerConfig) {
    this.network = config.network;
    this.facilitatorUrl = config.facilitatorUrl || RELAI_FACILITATOR_URL;
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
        const asset = USDC_ADDRESSES[network];
        const amount = String(Math.floor(resolvedPrice * 1_000_000)); // USD → USDC atomic units (6 decimals)

        // Check for payment header (base64-encoded JSON)
        const paymentHeader =
          req.headers['x-payment'] ||
          req.headers['payment-signature'] ||
          req.headers['x-payment-signature'];

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

          // Get facilitator feePayer address (cached)
          const feePayer = await self.getFeePayer(caip2);

          // Token metadata per network
          // IMPORTANT: These must match the actual EIP-712 domain on each network
          const tokenMetadata: Record<string, { name: string; version: string }> = {
            'eip155:103698795': { name: 'USDC', version: '1' }, // SKALE BITE
            'eip155:1187947933': { name: 'Bridged USDC (SKALE Bridge)', version: '2' }, // SKALE Base
            'eip155:324705682': { name: 'Bridged USDC (SKALE Bridge)', version: '2' }, // SKALE Base Sepolia
            'eip155:8453': { name: 'USD Coin', version: '2' }, // Base
            'eip155:43114': { name: 'USD Coin', version: '2' }, // Avalanche
            'eip155:137': { name: 'USD Coin', version: '2' }, // Polygon
            'eip155:1': { name: 'USD Coin', version: '2' }, // Ethereum
          };
          const metadata = tokenMetadata[caip2] || { name: 'USDC', version: '1' };

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
                name: metadata.name,
                version: metadata.version,
                decimals: 6,
                ...(feePayer && { feePayer }), // Add feePayer if available
              },
            }],
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
          network,
          amount,
          asset,
          payTo: settlePayTo,
          maxTimeoutSeconds: options.maxTimeoutSeconds || 60,
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
