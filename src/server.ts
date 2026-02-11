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
  /** Wallet address to receive payments */
  payTo: string;
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
// Relai Server SDK
// ============================================================================

/**
 * Server-side SDK for protecting Express endpoints with x402 micropayments.
 * Settles payments through the RelAI facilitator (zero gas fees for users).
 *
 * Supports: Solana, Base, Avalanche, SKALE Base.
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

  constructor(config: RelaiServerConfig) {
    this.network = config.network;
    this.facilitatorUrl = config.facilitatorUrl || RELAI_FACILITATOR_URL;
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

        const network = options.network || self.network;
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
              payTo: options.payTo,
              maxTimeoutSeconds: options.maxTimeoutSeconds || 60,
              extra: {
                name: 'USD Coin',
                version: '2',
                decimals: 6,
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

        // Build payment requirements for facilitator
        const paymentRequirements = {
          scheme: 'exact',
          network,
          amount,
          asset,
          payTo: options.payTo,
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
