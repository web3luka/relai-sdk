// src/server.ts
import axios, { AxiosInstance } from 'axios';
import { RelaiConfig, ProtectOptions, PaymentResult } from './types';

export class Relai {
  private config: RelaiConfig;
  private client: AxiosInstance;

  constructor(config: RelaiConfig) {
    this.config = {
      network: "solana",
      apiBaseUrl: "https://relai.fi/api",
      facilitatorUrl: "https://facilitator.payai.network",
      ...config,
    };

    if (!this.config.apiKey || typeof this.config.apiKey !== 'string') {
      throw new Error('[Relai] Missing required apiKey in configuration');
    }

    this.client = axios.create({
      baseURL: this.config.apiBaseUrl,
      timeout: 10000,
      headers: {
        'Authorization': `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  /**
   * Middleware to protect an endpoint with micropayment verification
   */
  protect(options: ProtectOptions) {
    return async (req: any, res: any, next: any) => {
      try {
        // Resolve dynamic price (number or function)
        const resolvedPrice = typeof options.price === 'function'
          ? await options.price(req)
          : options.price;

        if (typeof resolvedPrice !== 'number' || !isFinite(resolvedPrice) || resolvedPrice <= 0) {
          return res.status(400).json({
            error: 'Invalid price configuration',
            code: 'INVALID_PRICE',
          });
        }

        // Check for payment signature in headers
        const paymentSignature = req.headers['x-payment-signature'] ||
                                req.headers['x-relai-payment'];

        if (!paymentSignature) {
          return res.status(402).json({
            error: 'Payment required',
            code: 'PAYMENT_REQUIRED',
            details: {
              price: resolvedPrice,
              description: options.description || 'API access',
              facilitatorUrl: this.config.facilitatorUrl
            }
          });
        }

        // Verify payment with RelayAI API
        const verification = await this.verifyPayment(
          paymentSignature,
          resolvedPrice,
          options.maxTimeout
        );

        if (!verification.verified) {
          return res.status(402).json({
            error: 'Payment verification failed',
            code: 'PAYMENT_INVALID',
            details: verification.error
          });
        }

        // Add payment info to request
        req.payment = verification;

        // Run custom validation if provided
        if (options.customRules) {
          const customValid = await options.customRules(req);
          if (!customValid) {
            return res.status(403).json({
              error: 'Custom validation failed',
              code: 'VALIDATION_FAILED'
            });
          }
        }

        next();
      } catch (error) {
        console.error('Relai protection error:', error);
        res.status(500).json({
          error: 'Internal server error',
          code: 'SERVER_ERROR'
        });
      }
    };
  }

  /**
   * Verify payment signature
   */
  private async verifyPayment(signature: string, expectedPrice: number, timeoutMs?: number): Promise<PaymentResult> {
    try {
      const response = await this.client.post(
        '/verify-payment',
        {
          signature,
          expectedPrice,
          network: this.config.network
        },
        {
          timeout: typeof timeoutMs === 'number' ? Math.max(1, timeoutMs) : undefined,
        }
      );

      return response.data;
    } catch (error: any) {
      return {
        verified: false,
        error: error.response?.data?.error || 'Verification failed'
      };
    }
  }

  /**
   * Get payment statistics
   */
  async getStats(apiId?: string) {
    const params = apiId ? { apiId } : {};
    const response = await this.client.get('/stats', { params });
    return response.data;
  }

  /**
   * Create a protected endpoint helper
   */
  createProtectedEndpoint(options: ProtectOptions) {
    return this.protect(options);
  }
}

export default Relai;

