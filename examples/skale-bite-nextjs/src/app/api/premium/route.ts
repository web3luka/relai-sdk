import { NextRequest, NextResponse } from 'next/server';
import Relai from '@relai-fi/x402/server';

// Initialize Relai SDK for SKALE BITE
const relai = new Relai({
  network: 'skale-bite',
  facilitatorUrl: process.env.FACILITATOR_URL || 'https://facilitator.x402.fi',
});

// Protected endpoint - requires x402 payment
export async function GET(req: NextRequest) {
  return new Promise<NextResponse>((resolve) => {
    // Convert NextRequest to Express-like request/response
    const mockReq: any = {
      headers: Object.fromEntries(req.headers.entries()),
      protocol: 'http',
      get: (header: string) => req.headers.get(header),
      originalUrl: '/api/premium',
    };

    const mockRes: any = {
      statusCode: 200,
      _headers: {} as Record<string, string>,
      _body: null as any,
      
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      
      json(data: any) {
        this._body = data;
        resolve(
          NextResponse.json(data, {
            status: this.statusCode,
            headers: this._headers,
          })
        );
        return this;
      },
      
      setHeader(name: string, value: string) {
        this._headers[name] = value;
        return this;
      },
    };

    // Apply Relai protection middleware
    const middleware = relai.protect({
      payTo: process.env.MERCHANT_WALLET || '0x0000000000000000000000000000000000000001',
      price: 0.01, // $0.01 USD
      description: 'Premium API access on SKALE BITE',
      onPaymentRequired: (req, info) => {
        console.log('[Premium API] Payment required:', info);
      },
      onPaymentSettled: (req, result) => {
        console.log('[Premium API] Payment settled:', result);
      },
      onError: (req, error) => {
        console.error('[Premium API] Error:', error);
        console.error('[Premium API] Error details:', JSON.stringify(error, null, 2));
      },
    });

    // Execute middleware
    middleware(mockReq, mockRes, () => {
      // Payment successful - return premium data
      mockRes.json({
        success: true,
        message: 'Payment successful! Here is your premium data.',
        data: {
          timestamp: new Date().toISOString(),
          network: 'skale-bite',
          payer: mockReq.x402Payer,
          transaction: mockReq.x402Transaction,
          premiumContent: {
            secretData: 'This is premium content only available after payment',
            value: Math.random() * 1000,
          },
        },
      });
    });
  });
}
