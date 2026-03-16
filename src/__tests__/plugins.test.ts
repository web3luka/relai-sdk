import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Relai from '../server';
import { freeTier, shield, preflight, circuitBreaker, refund } from '../plugins';
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
      // Mock GET /config check (returns no existing configs)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ configs: [] }),
      });
      // Mock PUT /config sync
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ success: true }),
      });

      const plugin = freeTier({
        serviceKey: 'sk_live_test123',
        perBuyerLimit: 5,
      });

      await plugin.onInit!();

      // PUT is the second call (index 1)
      const callBody = JSON.parse(mockFetch.mock.calls[1][1].body);
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
    // Mock GET /config check (syncConfig)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configs: [] }),
    });
    // Mock PUT /config sync (onInit)
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
    // Mock GET /config check (syncConfig)
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ configs: [] }),
    });
    // Mock PUT /config sync (onInit)
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

// ============================================================================
// shield() plugin unit tests
// ============================================================================

describe('shield() plugin', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const ctx: PluginContext = {
    network: 'base',
    price: 0.01,
    path: '/api/data',
    method: 'GET',
  };

  it('has correct name', () => {
    const plugin = shield();
    expect(plugin.name).toBe('shield');
  });

  it('has beforePaymentCheck hook', () => {
    const plugin = shield();
    expect(typeof plugin.beforePaymentCheck).toBe('function');
  });

  it('has onInit hook', () => {
    const plugin = shield();
    expect(typeof plugin.onInit).toBe('function');
  });

  describe('no config (no-op mode)', () => {
    it('returns healthy when no healthCheck or healthUrl configured', async () => {
      const plugin = shield();
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBeUndefined();
      expect(result.headers?.['X-Shield-Status']).toBe('healthy');
    });
  });

  describe('healthCheck function', () => {
    it('returns healthy when healthCheck returns true', async () => {
      const plugin = shield({
        healthCheck: () => true,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBeUndefined();
      expect(result.headers?.['X-Shield-Status']).toBe('healthy');
    });

    it('returns reject when healthCheck returns false', async () => {
      const plugin = shield({
        healthCheck: () => false,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(503);
      expect(result.headers?.['X-Shield-Status']).toBe('unhealthy');
      expect(result.headers?.['Retry-After']).toBeDefined();
    });

    it('returns reject when healthCheck throws', async () => {
      const plugin = shield({
        healthCheck: () => { throw new Error('boom'); },
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(503);
    });

    it('supports async healthCheck', async () => {
      const plugin = shield({
        healthCheck: async () => true,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBeUndefined();
      expect(result.headers?.['X-Shield-Status']).toBe('healthy');
    });

    it('uses custom unhealthyMessage and unhealthyStatus', async () => {
      const plugin = shield({
        healthCheck: () => false,
        unhealthyMessage: 'Backend is down',
        unhealthyStatus: 502,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(502);
      expect(result.rejectMessage).toBe('Backend is down');
    });
  });

  describe('healthUrl', () => {
    it('returns healthy when URL responds 200', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const plugin = shield({
        healthUrl: 'https://my-api.com/health',
        cacheTtlMs: 0,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBeUndefined();
      expect(result.headers?.['X-Shield-Status']).toBe('healthy');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://my-api.com/health',
        expect.objectContaining({ method: 'GET' }),
      );
    });

    it('returns reject when URL responds 500', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const plugin = shield({
        healthUrl: 'https://my-api.com/health',
        cacheTtlMs: 0,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(503);
    });

    it('returns reject when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const plugin = shield({
        healthUrl: 'https://my-api.com/health',
        cacheTtlMs: 0,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
    });
  });

  describe('caching', () => {
    it('caches health result within TTL', async () => {
      let callCount = 0;
      const plugin = shield({
        healthCheck: () => { callCount++; return true; },
        cacheTtlMs: 60000,
      });
      const req = mockReq();

      await plugin.beforePaymentCheck!(req, ctx);
      await plugin.beforePaymentCheck!(req, ctx);
      await plugin.beforePaymentCheck!(req, ctx);

      expect(callCount).toBe(1);
    });
  });

  describe('integration with Relai.protect()', () => {
    it('rejects request with 503 when unhealthy', async () => {
      // Mock facilitator /supported call (plugins init happens before payment check)
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const middleware = createProtectedMiddleware([
        shield({
          healthCheck: () => false,
          cacheTtlMs: 0,
        }),
      ]);

      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Service temporarily unavailable'),
          plugin: 'shield',
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });
});

// ============================================================================
// preflight() plugin unit tests
// ============================================================================

describe('preflight() plugin', () => {
  beforeEach(() => {
    mockFetch.mockReset();
  });

  const ctx: PluginContext = {
    network: 'base',
    price: 0.01,
    path: '/api/data',
    method: 'GET',
  };

  it('has correct name', () => {
    const plugin = preflight({ baseUrl: 'https://my-api.com' });
    expect(plugin.name).toBe('preflight');
  });

  it('has beforePaymentCheck and onInit hooks', () => {
    const plugin = preflight({ baseUrl: 'https://my-api.com' });
    expect(typeof plugin.beforePaymentCheck).toBe('function');
    expect(typeof plugin.onInit).toBe('function');
  });

  describe('endpoint reachable', () => {
    it('returns ok when endpoint responds 200', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const plugin = preflight({ baseUrl: 'https://my-api.com', cacheTtlMs: 0 });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBeUndefined();
      expect(result.headers?.['X-Preflight-Status']).toBe('ok');
      expect(mockFetch).toHaveBeenCalledWith(
        'https://my-api.com/api/data',
        expect.objectContaining({
          method: 'HEAD',
          headers: { 'X-Preflight': 'true' },
        }),
      );
    });
  });

  describe('endpoint unreachable', () => {
    it('returns reject when endpoint responds 500', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false, status: 500 });

      const plugin = preflight({ baseUrl: 'https://my-api.com', cacheTtlMs: 0 });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(503);
      expect(result.headers?.['X-Preflight-Status']).toBe('unreachable');
    });

    it('returns reject when fetch throws (network error)', async () => {
      mockFetch.mockRejectedValueOnce(new Error('ECONNREFUSED'));

      const plugin = preflight({ baseUrl: 'https://my-api.com', cacheTtlMs: 0 });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
      expect(result.headers?.['Retry-After']).toBeDefined();
    });

    it('uses custom unhealthyMessage and unhealthyStatus', async () => {
      mockFetch.mockResolvedValueOnce({ ok: false });

      const plugin = preflight({
        baseUrl: 'https://my-api.com',
        cacheTtlMs: 0,
        unhealthyMessage: 'API is down',
        unhealthyStatus: 502,
      });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(502);
      expect(result.rejectMessage).toBe('API is down');
    });
  });

  describe('per-path probing', () => {
    it('probes the correct path from ctx', async () => {
      mockFetch.mockResolvedValueOnce({ ok: true });

      const plugin = preflight({ baseUrl: 'https://my-api.com', cacheTtlMs: 0 });
      const req = mockReq();
      await plugin.beforePaymentCheck!(req, { ...ctx, path: '/v2/premium' });

      expect(mockFetch).toHaveBeenCalledWith(
        'https://my-api.com/v2/premium',
        expect.anything(),
      );
    });
  });

  describe('caching', () => {
    it('caches probe result per path within TTL', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const plugin = preflight({ baseUrl: 'https://my-api.com', cacheTtlMs: 60000 });
      const req = mockReq();

      await plugin.beforePaymentCheck!(req, ctx);
      await plugin.beforePaymentCheck!(req, ctx);
      await plugin.beforePaymentCheck!(req, ctx);

      // Only one fetch call (cached)
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('probes separately for different paths', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const plugin = preflight({ baseUrl: 'https://my-api.com', cacheTtlMs: 60000 });
      const req = mockReq();

      await plugin.beforePaymentCheck!(req, { ...ctx, path: '/a' });
      await plugin.beforePaymentCheck!(req, { ...ctx, path: '/b' });

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('integration with Relai.protect()', () => {
    it('rejects request with 503 when endpoint unreachable', async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 500 });

      const middleware = createProtectedMiddleware([
        preflight({
          baseUrl: 'https://my-api.com',
          cacheTtlMs: 0,
        }),
      ]);

      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('Endpoint not responding'),
          plugin: 'preflight',
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });

    it('responds 200 to X-Preflight header (server-side handling)', async () => {
      const middleware = createProtectedMiddleware([]);

      const req = mockReq({ headers: { 'x-preflight': 'true' } });
      const res = mockRes();
      const next = mockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({ status: 'ok', preflight: true });
    });
  });
});


// ============================================================================
// circuitBreaker() plugin unit tests
// ============================================================================

describe('circuitBreaker() plugin', () => {
  const ctx: PluginContext = {
    network: 'base',
    price: 0.01,
    path: '/api/data',
    method: 'GET',
  };

  it('has correct name', () => {
    const plugin = circuitBreaker();
    expect(plugin.name).toBe('circuit-breaker');
  });

  it('has beforePaymentCheck and afterSettled hooks', () => {
    const plugin = circuitBreaker();
    expect(typeof plugin.beforePaymentCheck).toBe('function');
    expect(typeof plugin.afterSettled).toBe('function');
  });

  describe('closed state (default)', () => {
    it('allows requests through when circuit is closed', async () => {
      const plugin = circuitBreaker();
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.reject).toBeUndefined();
      expect(result.headers?.['X-Circuit-State']).toBe('closed');
    });
  });

  describe('opening the circuit', () => {
    it('opens after failureThreshold consecutive failures', async () => {
      const plugin = circuitBreaker({ failureThreshold: 3, resetTimeMs: 60000 });
      const req = mockReq();

      // Record 3 failures
      for (let i = 0; i < 3; i++) {
        await plugin.afterSettled!(req, { success: false } as any, ctx);
      }

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(503);
      expect(result.headers?.['X-Circuit-State']).toBe('open');
      expect(result.headers?.['Retry-After']).toBeDefined();
    });

    it('does not open before threshold', async () => {
      const plugin = circuitBreaker({ failureThreshold: 5 });
      const req = mockReq();

      for (let i = 0; i < 4; i++) {
        await plugin.afterSettled!(req, { success: false } as any, ctx);
      }

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.reject).toBeUndefined();
    });

    it('resets failure count on success', async () => {
      const plugin = circuitBreaker({ failureThreshold: 3 });
      const req = mockReq();

      await plugin.afterSettled!(req, { success: false } as any, ctx);
      await plugin.afterSettled!(req, { success: false } as any, ctx);
      // Success resets
      await plugin.afterSettled!(req, { success: true, transaction: 'tx1', payer: '0x1' } as any, ctx);
      await plugin.afterSettled!(req, { success: false } as any, ctx);

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.reject).toBeUndefined();
    });
  });

  describe('half-open state', () => {
    it('transitions to half-open after resetTime', async () => {
      const plugin = circuitBreaker({ failureThreshold: 2, resetTimeMs: 0, halfOpenSuccesses: 2 });
      const req = mockReq();

      // Open the circuit
      await plugin.afterSettled!(req, { success: false } as any, ctx);
      await plugin.afterSettled!(req, { success: false } as any, ctx);

      // resetTimeMs: 0 → immediately half-open
      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.reject).toBeUndefined();
      expect(result.headers?.['X-Circuit-State']).toBe('half-open');
    });

    it('closes after enough successes in half-open', async () => {
      const plugin = circuitBreaker({ failureThreshold: 2, resetTimeMs: 0, halfOpenSuccesses: 2 });
      const req = mockReq();

      await plugin.afterSettled!(req, { success: false } as any, ctx);
      await plugin.afterSettled!(req, { success: false } as any, ctx);

      // Transition to half-open
      await plugin.beforePaymentCheck!(req, ctx);

      // 2 successes in half-open → close
      await plugin.afterSettled!(req, { success: true, transaction: 'tx1', payer: '0x1' } as any, ctx);
      await plugin.afterSettled!(req, { success: true, transaction: 'tx2', payer: '0x1' } as any, ctx);

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.headers?.['X-Circuit-State']).toBe('closed');
    });
  });

  describe('per-path scope', () => {
    it('tracks circuits independently per path', async () => {
      const plugin = circuitBreaker({ failureThreshold: 2, scope: 'per-path' });
      const req = mockReq();

      // Fail /api/a
      await plugin.afterSettled!(req, { success: false } as any, { ...ctx, path: '/api/a' });
      await plugin.afterSettled!(req, { success: false } as any, { ...ctx, path: '/api/a' });

      // /api/a should be open
      const resultA = await plugin.beforePaymentCheck!(req, { ...ctx, path: '/api/a' });
      expect(resultA.reject).toBe(true);

      // /api/b should still be closed
      const resultB = await plugin.beforePaymentCheck!(req, { ...ctx, path: '/api/b' });
      expect(resultB.reject).toBeUndefined();
    });
  });

  describe('global scope', () => {
    it('tracks all paths as one circuit', async () => {
      const plugin = circuitBreaker({ failureThreshold: 2, scope: 'global' });
      const req = mockReq();

      await plugin.afterSettled!(req, { success: false } as any, { ...ctx, path: '/api/a' });
      await plugin.afterSettled!(req, { success: false } as any, { ...ctx, path: '/api/b' });

      // Both paths affected
      const resultA = await plugin.beforePaymentCheck!(req, { ...ctx, path: '/api/a' });
      expect(resultA.reject).toBe(true);

      const resultC = await plugin.beforePaymentCheck!(req, { ...ctx, path: '/api/c' });
      expect(resultC.reject).toBe(true);
    });
  });

  describe('custom config', () => {
    it('uses custom openMessage and openStatus', async () => {
      const plugin = circuitBreaker({
        failureThreshold: 1,
        openStatus: 502,
        openMessage: 'Circuit is open!',
        resetTimeMs: 60000,
      });
      const req = mockReq();

      await plugin.afterSettled!(req, { success: false } as any, ctx);

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.reject).toBe(true);
      expect(result.rejectStatus).toBe(502);
      expect(result.rejectMessage).toBe('Circuit is open!');
    });
  });

  describe('integration with Relai.protect()', () => {
    it('rejects request when circuit is open', async () => {
      mockFetch.mockResolvedValue({ ok: true });

      const cb = circuitBreaker({ failureThreshold: 1, resetTimeMs: 60000 });

      // Open the circuit by simulating a failure
      await cb.afterSettled!(mockReq(), { success: false } as any, ctx);

      const middleware = createProtectedMiddleware([cb]);
      const req = mockReq();
      const res = mockRes();
      const next = mockNext();

      await middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          error: expect.stringContaining('circuit open'),
          plugin: 'circuit-breaker',
        }),
      );
      expect(next).not.toHaveBeenCalled();
    });
  });
});


// ============================================================================
// refund() plugin unit tests
// ============================================================================

describe('refund() plugin', () => {
  const ctx: PluginContext = {
    network: 'base',
    price: 0.01,
    path: '/api/data',
    method: 'GET',
  };

  it('has correct name', () => {
    const plugin = refund();
    expect(plugin.name).toBe('refund');
  });

  it('has beforePaymentCheck and afterSettled hooks', () => {
    const plugin = refund();
    expect(typeof plugin.beforePaymentCheck).toBe('function');
    expect(typeof plugin.afterSettled).toBe('function');
  });

  describe('credit mode', () => {
    it('does not skip payment when no credits exist', async () => {
      const plugin = refund({ mode: 'credit' });
      const req = mockReq();
      const result = await plugin.beforePaymentCheck!(req, ctx);

      expect(result.skip).toBeUndefined();
    });

    it('grants credit on settlement failure and applies it next request', async () => {
      const plugin = refund({ mode: 'credit' });
      const req = mockReq({ ip: '1.2.3.4' });

      // Settlement failure → credit granted
      await plugin.afterSettled!(req, { success: false, payer: '0x1', transaction: 'tx1' } as any, ctx);

      // Next request from same IP → credit applied
      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.skip).toBe(true);
      expect(result.headers?.['X-Refund-Credit']).toBe('applied');
    });

    it('decrements credits correctly', async () => {
      const plugin = refund({ mode: 'credit' });
      const req = mockReq({ ip: '1.2.3.4' });

      // 2 failures → 2 credits
      await plugin.afterSettled!(req, { success: false, payer: '0x1', transaction: 'tx1' } as any, ctx);
      await plugin.afterSettled!(req, { success: false, payer: '0x1', transaction: 'tx2' } as any, ctx);

      // First use
      const r1 = await plugin.beforePaymentCheck!(req, ctx);
      expect(r1.skip).toBe(true);
      expect(r1.headers?.['X-Refund-Credits-Remaining']).toBe('1');

      // Second use
      const r2 = await plugin.beforePaymentCheck!(req, ctx);
      expect(r2.skip).toBe(true);
      expect(r2.headers?.['X-Refund-Credits-Remaining']).toBe('0');

      // No more credits
      const r3 = await plugin.beforePaymentCheck!(req, ctx);
      expect(r3.skip).toBeUndefined();
    });
  });

  describe('log mode', () => {
    it('does not grant credits in log mode', async () => {
      const plugin = refund({ mode: 'log' });
      const req = mockReq({ ip: '1.2.3.4' });

      await plugin.afterSettled!(req, { success: false, payer: '0x1', transaction: 'tx1' } as any, ctx);

      const result = await plugin.beforePaymentCheck!(req, ctx);
      expect(result.skip).toBeUndefined();
    });
  });

  describe('onRefund callback', () => {
    it('calls onRefund on settlement failure', async () => {
      const onRefund = vi.fn();
      const plugin = refund({ onRefund });
      const req = mockReq();

      await plugin.afterSettled!(req, { success: false, payer: '0xBuyer', transaction: 'tx123' } as any, ctx);

      expect(onRefund).toHaveBeenCalledWith(
        expect.objectContaining({
          payer: '0xBuyer',
          transactionId: 'tx123',
          reason: 'settlement_failure',
          amount: 0.01,
          path: '/api/data',
        }),
      );
    });

    it('does not call onRefund on success', async () => {
      const onRefund = vi.fn();
      const plugin = refund({ onRefund });
      const req = mockReq();

      await plugin.afterSettled!(req, { success: true, payer: '0xBuyer', transaction: 'tx123' } as any, ctx);

      expect(onRefund).not.toHaveBeenCalled();
    });

    it('handles onRefund errors gracefully', async () => {
      const onRefund = vi.fn().mockRejectedValue(new Error('callback failed'));
      const plugin = refund({ onRefund });
      const req = mockReq();

      // Should not throw
      await plugin.afterSettled!(req, { success: false, payer: '0x1', transaction: 'tx1' } as any, ctx);
      expect(onRefund).toHaveBeenCalled();
    });
  });

  describe('refundOnSettlementFailure config', () => {
    it('skips refund on settlement failure when disabled', async () => {
      const onRefund = vi.fn();
      const plugin = refund({ onRefund, refundOnSettlementFailure: false });
      const req = mockReq();

      await plugin.afterSettled!(req, { success: false, payer: '0x1', transaction: 'tx1' } as any, ctx);

      expect(onRefund).not.toHaveBeenCalled();
    });
  });
});
