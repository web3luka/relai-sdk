import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { stripePayTo } from '../server';
import type { StripePayTo } from '../server';

// We need to test the full protect() flow, so import Relai class
import Relai from '../server';

// ============================================================================
// stripePayTo() unit tests
// ============================================================================

describe('stripePayTo()', () => {
  it('returns correct config shape', () => {
    const config = stripePayTo('sk_test_123');
    expect(config).toEqual({
      __brand: 'stripePayTo',
      secretKey: 'sk_test_123',
      stripeNetwork: 'base',
    });
  });

  it('defaults network to base', () => {
    const config = stripePayTo('sk_test_123');
    expect(config.stripeNetwork).toBe('base');
  });

  it('accepts custom network', () => {
    const config = stripePayTo('sk_test_123', { network: 'ethereum' });
    expect(config.stripeNetwork).toBe('ethereum');
  });

  it('throws on empty secret key', () => {
    expect(() => stripePayTo('')).toThrow('stripePayTo requires a Stripe secret key');
  });

  it('has readonly brand', () => {
    const config = stripePayTo('sk_test_123');
    expect(config.__brand).toBe('stripePayTo');
  });
});

// ============================================================================
// protect() middleware with stripePayTo - 402 path
// ============================================================================

describe('protect() with stripePayTo - 402 response', () => {
  let fetchSpy: any;

  const mockStripePI = {
    id: 'pi_test_123',
    status: 'requires_action',
    next_action: {
      crypto_collect_deposit_details: {
        deposit_addresses: {
          base: {
            address: '0xStripeDepositAddress123',
          },
        },
      },
    },
  };

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('creates Stripe PI and returns deposit address as payTo in 402', async () => {
    // Mock Stripe API response
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify(mockStripePI), { status: 200 }),
    );

    const relai = new Relai({ network: 'base' });
    const middleware = relai.protect({
      price: 0.01,
      payTo: stripePayTo('sk_test_abc'),
    });

    const req = {
      headers: {},
      protocol: 'https',
      get: (h: string) => h === 'host' ? 'api.example.com' : '',
      originalUrl: '/api/data',
    };

    const resJson: any = {};
    const res = {
      status: (code: number) => {
        resJson.status = code;
        return res;
      },
      json: (body: any) => {
        resJson.body = body;
        return res;
      },
    };

    const next = vi.fn();
    await middleware(req, res, next);

    // Should return 402
    expect(resJson.status).toBe(402);
    expect(resJson.body.x402Version).toBe(2);
    expect(resJson.body.error).toBe('Payment required');

    // payTo should be the Stripe deposit address
    expect(resJson.body.accepts[0].payTo).toBe('0xStripeDepositAddress123');

    // Network should be base (auto-set)
    expect(resJson.body.accepts[0].network).toBe('eip155:8453');

    // Should have called Stripe API
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.stripe.com/v1/payment_intents');
    expect(opts.method).toBe('POST');
    expect((opts.headers as Record<string, string>)['Authorization']).toBe('Bearer sk_test_abc');

    // Verify amount: $0.01 = 1 cent
    const body = opts.body as string;
    expect(body).toContain('amount=1');
    expect(body).toContain('currency=usd');
    expect(body).toContain('payment_method_types%5B%5D=crypto');

    // next() should NOT be called (402 = no payment)
    expect(next).not.toHaveBeenCalled();
  });

  it('returns 500 when Stripe API fails', async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
    );

    const relai = new Relai({ network: 'base' });
    const middleware = relai.protect({
      price: 0.05,
      payTo: stripePayTo('sk_test_bad'),
    });

    const req = {
      headers: {},
      protocol: 'https',
      get: () => 'api.example.com',
      originalUrl: '/api/data',
    };

    const resJson: any = {};
    const res = {
      status: (code: number) => { resJson.status = code; return res; },
      json: (body: any) => { resJson.body = body; return res; },
    };

    await middleware(req, res, vi.fn());

    // Should return 500 (internal error from Stripe failure)
    expect(resJson.status).toBe(500);
  });

  it('sends correct cent amount for various prices', async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify(mockStripePI), { status: 200 }),
    );

    const relai = new Relai({ network: 'base' });

    // Test $1.50 = 150 cents
    const middleware = relai.protect({
      price: 1.50,
      payTo: stripePayTo('sk_test_abc'),
    });

    const req = {
      headers: {},
      protocol: 'https',
      get: () => 'api.example.com',
      originalUrl: '/test',
    };
    const res = {
      status: () => res,
      json: () => res,
    };

    await middleware(req, res, vi.fn());

    const [, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    const body = opts.body as string;
    expect(body).toContain('amount=150');
  });
});

// ============================================================================
// protect() middleware with stripePayTo - settle path
// ============================================================================

describe('protect() with stripePayTo - settle path', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extracts payTo from payment proof for settle', async () => {
    // Mock facilitator /settle response
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({
        success: true,
        transaction: '0xtxhash123',
        payer: '0xPayerAddress',
      }), { status: 200 }),
    );

    const relai = new Relai({ network: 'base' });
    const middleware = relai.protect({
      price: 0.01,
      payTo: stripePayTo('sk_test_abc'),
    });

    // Payment proof with 'to' address (the Stripe deposit address)
    const paymentProof = {
      x402Version: 2,
      payload: {
        authorization: {
          to: '0xStripeDepositAddress123',
          from: '0xPayerAddress',
          value: '10000',
        },
        signature: '0xfakesig',
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(paymentProof)).toString('base64');

    const req = {
      headers: { 'x-payment': paymentHeader },
      protocol: 'https',
      get: () => 'api.example.com',
      originalUrl: '/api/data',
    };

    let nextCalled = false;
    const resJson: any = {};
    const res = {
      status: (code: number) => { resJson.status = code; return res; },
      json: (body: any) => { resJson.body = body; return res; },
      setHeader: vi.fn(),
    };
    const next = vi.fn(() => { nextCalled = true; });

    await middleware(req, res, next);

    // Should have called facilitator /settle (not Stripe PI creation)
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchSpy.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/settle');

    // Verify the settle payload uses the Stripe deposit address from payment proof
    const settleBody = JSON.parse(opts.body as string);
    expect(settleBody.paymentRequirements.payTo).toBe('0xStripeDepositAddress123');
  });

  it('returns 400 when payment proof has no destination address', async () => {
    const relai = new Relai({ network: 'base' });
    const middleware = relai.protect({
      price: 0.01,
      payTo: stripePayTo('sk_test_abc'),
    });

    // Payment proof WITHOUT 'to' address
    const paymentProof = {
      x402Version: 2,
      payload: {
        authorization: {},
        signature: '0xfakesig',
      },
    };

    const paymentHeader = Buffer.from(JSON.stringify(paymentProof)).toString('base64');

    const req = {
      headers: { 'x-payment': paymentHeader },
      protocol: 'https',
      get: () => 'api.example.com',
      originalUrl: '/api/data',
    };

    const resJson: any = {};
    const res = {
      status: (code: number) => { resJson.status = code; return res; },
      json: (body: any) => { resJson.body = body; return res; },
      setHeader: vi.fn(),
    };

    await middleware(req, res, vi.fn());

    expect(resJson.status).toBe(400);
    expect(resJson.body.error).toContain('destination address');
  });
});

// ============================================================================
// protect() with regular string payTo (regression)
// ============================================================================

describe('protect() with string payTo (no Stripe)', () => {
  let fetchSpy: any;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, 'fetch') as any;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses static address directly without calling Stripe', async () => {
    const relai = new Relai({ network: 'base' });
    const middleware = relai.protect({
      price: 0.01,
      payTo: '0xMyStaticWallet',
    });

    const req = {
      headers: {},
      protocol: 'https',
      get: () => 'api.example.com',
      originalUrl: '/api/data',
    };

    const resJson: any = {};
    const res = {
      status: (code: number) => { resJson.status = code; return res; },
      json: (body: any) => { resJson.body = body; return res; },
    };

    await middleware(req, res, vi.fn());

    expect(resJson.status).toBe(402);
    expect(resJson.body.accepts[0].payTo).toBe('0xMyStaticWallet');

    // Should NOT call Stripe API
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
