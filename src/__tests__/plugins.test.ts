import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Relai from '../server';
import { freeTier } from '../plugins';
import type { RelaiPlugin, PluginContext } from '../plugins';

// ============================================================================
// Mock fetch globally
// ============================================================================

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

// ============================================================================
// Test helpers
// ============================================================================

function mockReq(overrides: Record<string, any> = {}) {
  const headers = overrides.headers || {};
  return {
    headers,
    path: '/api/data',
    originalUrl: '/api/data',
    method: 'GET',
    protocol: 'https',
    get: (name: string) => {
      if (name === 'host') return 'localhost:3000';
      return headers[name.toLowerCase()] || '';
    },
    socket: { remoteAddress: '127.0.0.1' },
    ip: '127.0.0.1',
    ...overrides,
  };
}

function mockRes() {
  const headers: Record<string, string> = {};
  return {
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
    setHeader: vi.fn((k: string, v: string) => { headers[k] = v; }),
    _headers: headers,
  };
}

function mockNext() {
  return vi.fn();
}

// Helper: creates a Relai instance with plugins and returns protect middleware
function createProtectedMiddleware(plugins: RelaiPlugin[]) {
  const relai = new Relai({
    network: 'base',
    plugins,
  });

  return relai.protect({
    payTo: '0x1234567890abcdef1234567890abcdef12345678',
    price: 0.01,
    description: 'Test endpoint',
  });
}

// ============================================================================
// freeTier() plugin unit tests
// ============================================================================

describe('freeTier() plugin', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('has correct name', () => {
    const plugin = freeTier({
      serviceKey: 'sk_live_test123',
      perBuyerLimit: 10,
    });
    expect(plugin.name).toBe('free-tier');
  });

  it('has beforePaymentCheck hook', () => {
    const plugin = freeTier({
      serviceKey: 'sk_live_test123',
      perBuyerLimit: 10,
    });
    expect(typeof plugin.beforePaymentCheck).toBe('function');
  });

  it('has onInit hook', () => {
    const plugin = freeTier({
      serviceKey: 'sk_live_test123',
      perBuyerLimit: 10,
    });
    expect(typeof plugin.onInit).toBe('function');
  });

  describe('onInit()', () => {
    it('syncs config to RelAI backend', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
        resetPeriod: 'daily',
        globalCap: 1000,
        paths: ['/api/data', '/api/other'],
      });

      await plugin.onInit!();

      expect(mockFetch).toHaveBeenCalledWith(
        'https://api.relai.fi/v1/plugins/free-tier/config',
        expect.objectContaining({
          method: 'PUT',
          headers: expect.objectContaining({
            'X-Service-Key': 'sk_live_test123',
          }),
          body: JSON.stringify({
            perBuyerLimit: 10,
            resetPeriod: 'daily',
            globalCap: 1000,
            paths: ['/api/data', '/api/other'],
          }),
        }),
      );
    });

    it('defaults paths to ["*"] when not specified', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 5,
      });

      await plugin.onInit!();

      const callBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(callBody.paths).toEqual(['*']);
    });

    it('does not throw on network error', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 5,
      });

      // Should not throw
      await expect(plugin.onInit!()).resolves.toBeUndefined();
    });
  });

  describe('beforePaymentCheck()', () => {
    const ctx: PluginContext = {
      network: 'base',
      price: 0.01,
      path: '/api/data',
      method: 'GET',
    };

    it('returns skip:true when API says free', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ free: true, remaining: 9, total: 10 }),
      });
      // Mock the record call (fire-and-forget)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      });

      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.skip).toBe(true);
      expect(result.headers).toBeDefined();
      expect(result.headers!['X-Free-Calls-Remaining']).toBe('9');
      expect(result.headers!['X-Free-Calls-Total']).toBe('10');
      expect(result.meta?.freeTier).toBe(true);
    });

    it('returns empty (no skip) when API says not free', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ free: false, reason: 'per_buyer_exhausted' }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      });

      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.skip).toBeUndefined();
    });

    it('returns empty on API error (non-blocking)', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      });

      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.skip).toBeUndefined();
    });

    it('returns empty on network error (non-blocking)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Connection refused'));

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      });

      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.skip).toBeUndefined();
    });

    it('skips paths not in config', async () => {
      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
        paths: ['/api/other'],
      });

      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, {
        ...ctx,
        path: '/api/data',
      });

      // Should not even call the API
      expect(mockFetch).not.toHaveBeenCalled();
      expect(result.skip).toBeUndefined();
    });

    it('resolves buyerId from JWT sub', async () => {
      const payload = Buffer.from(JSON.stringify({ sub: 'user123' })).toString('base64');
      const fakeJwt = `header.${payload}.signature`;

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ free: true, remaining: 5, total: 10 }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      });

      const req = mockReq({
        headers: { authorization: `Bearer ${fakeJwt}` },
      });

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.skip).toBe(true);

      // Verify buyerId sent to API
      const checkBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(checkBody.buyerId).toBe('user:user123');
    });

    it('resolves buyerId from wallet header', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ free: true, remaining: 5, total: 10 }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      });

      const req = mockReq({
        headers: { 'x-wallet-address': '0xABC123' },
      });

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.skip).toBe(true);

      const checkBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(checkBody.buyerId).toBe('wallet:0xABC123');
    });

    it('falls back to IP for buyerId', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ free: true, remaining: 5, total: 10 }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      });

      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.skip).toBe(true);

      const checkBody = JSON.parse(mockFetch.mock.calls[0][1].body);
      expect(checkBody.buyerId).toBe('ip:127.0.0.1');
    });

    it('uses custom baseUrl', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ free: false, reason: 'no_config' }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
        baseUrl: 'https://custom-api.example.com',
      });

      const req = mockReq();
      await plugin.beforePaymentCheck!(req, ctx);

      expect(mockFetch.mock.calls[0][0]).toBe(
        'https://custom-api.example.com/v1/plugins/free-tier/check',
      );
    });

    it('includes globalRemaining in headers when present', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          free: true,
          remaining: 5,
          total: 10,
          globalRemaining: 42,
        }),
      });
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
        globalCap: 1000,
      });

      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.headers!['X-Free-Calls-Global-Remaining']).toBe('42');
    });
  });
});

// ============================================================================
// Relai.protect() plugin integration tests
// ============================================================================

describe('Relai.protect() with plugins', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  it('calls next() without payment when plugin returns skip:true', async () => {
    // Mock the config sync (onInit - fires first from constructor)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });
    // Mock the free-tier check
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ free: true, remaining: 9, total: 10 }),
    });
    // Mock the record call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const middleware = createProtectedMiddleware([
      freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      }),
    ]);

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).x402Free).toBe(true);
    expect((req as any).x402Paid).toBe(false);
    expect((req as any).x402Plugin).toBe('free-tier');
    expect(res.setHeader).toHaveBeenCalledWith('X-Free-Calls-Remaining', '9');
    expect(res.setHeader).toHaveBeenCalledWith('X-Free-Calls-Total', '10');
    // Should NOT return 402
    expect(res.status).not.toHaveBeenCalledWith(402);
  });

  it('returns 402 when plugin says not free and no payment header', async () => {
    // Mock the config sync (onInit - runs first in protect via lazy init)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });
    // Mock the free-tier check returning not free
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ free: false, reason: 'per_buyer_exhausted' }),
    });

    const middleware = createProtectedMiddleware([
      freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      }),
    ]);

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    // Should return 402 since plugin didn't skip and no payment header
    expect(res.status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('attaches pluginMeta to req on free tier bypass', async () => {
    // Mock the config sync (onInit - fires first from constructor)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });
    // Mock the free-tier check
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ free: true, remaining: 4, total: 10 }),
    });
    // Mock the record call
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ success: true }),
    });

    const middleware = createProtectedMiddleware([
      freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 10,
      }),
    ]);

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect((req as any).pluginMeta).toBeDefined();
    expect((req as any).pluginMeta.freeTier).toBe(true);
    expect((req as any).pluginMeta.remaining).toBe(4);
    expect((req as any).pluginMeta.total).toBe(10);
  });

  it('works with custom plugin returning skip:true', async () => {
    const customPlugin: RelaiPlugin = {
      name: 'always-free',
      async beforePaymentCheck(_req, _ctx) {
        return {
          skip: true,
          headers: { 'X-Custom': 'always-free' },
          meta: { custom: true },
        };
      },
    };

    const relai = new Relai({ network: 'base', plugins: [customPlugin] });
    const middleware = relai.protect({
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      price: 0.01,
    });

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).x402Free).toBe(true);
    expect((req as any).x402Plugin).toBe('always-free');
    expect(res.setHeader).toHaveBeenCalledWith('X-Custom', 'always-free');
  });

  it('continues to 402 if plugin throws (non-blocking)', async () => {
    const brokenPlugin: RelaiPlugin = {
      name: 'broken',
      async beforePaymentCheck() {
        throw new Error('Plugin exploded');
      },
    };

    const relai = new Relai({ network: 'base', plugins: [brokenPlugin] });
    const middleware = relai.protect({
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      price: 0.01,
    });

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    // Should not throw, should gracefully fall through to 402
    await middleware(req, res, next);

    expect(res.status).toHaveBeenCalledWith(402);
    expect(next).not.toHaveBeenCalled();
  });

  it('evaluates plugins in order, first skip wins', async () => {
    const plugin1: RelaiPlugin = {
      name: 'no-skip',
      async beforePaymentCheck() {
        return {}; // no skip
      },
    };

    const plugin2: RelaiPlugin = {
      name: 'skipper',
      async beforePaymentCheck() {
        return { skip: true, headers: { 'X-Winner': 'plugin2' } };
      },
    };

    const relai = new Relai({ network: 'base', plugins: [plugin1, plugin2] });
    const middleware = relai.protect({
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      price: 0.01,
    });

    const req = mockReq();
    const res = mockRes();
    const next = mockNext();

    await middleware(req, res, next);

    expect(next).toHaveBeenCalled();
    expect((req as any).x402Plugin).toBe('skipper');
    expect(res.setHeader).toHaveBeenCalledWith('X-Winner', 'plugin2');
  });

  it('skips plugin check if payment header is present', async () => {
    const plugin: RelaiPlugin = {
      name: 'should-not-run',
      beforePaymentCheck: vi.fn(async () => ({ skip: true })),
    };

    const relai = new Relai({ network: 'base', plugins: [plugin] });
    const middleware = relai.protect({
      payTo: '0x1234567890abcdef1234567890abcdef12345678',
      price: 0.01,
    });

    // Create a fake payment header
    const fakePayment = Buffer.from(JSON.stringify({
      x402Version: 2,
      scheme: 'exact',
    })).toString('base64');

    const req = mockReq({
      headers: { 'x-payment': fakePayment },
    });
    const res = mockRes();
    const next = mockNext();

    // This will fail at settle (no real facilitator), but plugin should NOT run
    await middleware(req, res, next);

    expect(plugin.beforePaymentCheck).not.toHaveBeenCalled();
  });
});
