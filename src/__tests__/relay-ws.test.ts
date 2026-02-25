import { afterEach, describe, expect, it, vi } from 'vitest';
import { createX402Client, type RelayWebSocketFactory, type RelayWebSocketLike } from '../client';

type RelayEnvelope = {
  id?: string;
  method?: string;
  params?: {
    apiId?: string;
    path?: string;
    requestMethod?: string;
    requestHeaders?: Record<string, string>;
    requestBody?: unknown;
  };
  payment?: unknown;
};

type RelayHandler = (envelope: RelayEnvelope) => Record<string, unknown>;

function createMockRelayWebSocketFactory(handler: RelayHandler): RelayWebSocketFactory {
  return (_url: string): RelayWebSocketLike => {
    const listeners = new Map<string, Set<(...args: any[]) => void>>();

    const add = (event: string, listener: (...args: any[]) => void) => {
      const current = listeners.get(event) || new Set<(...args: any[]) => void>();
      current.add(listener);
      listeners.set(event, current);
    };

    const remove = (event: string, listener: (...args: any[]) => void) => {
      listeners.get(event)?.delete(listener);
    };

    const emit = (event: string, payload?: unknown) => {
      const current = listeners.get(event);
      if (!current) return;
      for (const listener of current) {
        listener(payload);
      }
    };

    const socket: RelayWebSocketLike = {
      readyState: 0,
      send(data: string) {
        const envelope = JSON.parse(data) as RelayEnvelope;
        const response = handler(envelope);
        setTimeout(() => {
          emit('message', { data: JSON.stringify(response) });
        }, 0);
      },
      close() {
        socket.readyState = 3;
        emit('close', {});
      },
      addEventListener(event, listener) {
        add(event, listener);
      },
      removeEventListener(event, listener) {
        remove(event, listener);
      },
    };

    setTimeout(() => {
      socket.readyState = 1;
      emit('open', {});
    }, 0);

    return socket;
  };
}

describe('createX402Client relay websocket transport', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('adds Integritas headers on HTTP requests and allows per-request override', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );

    const client = createX402Client({
      integritas: {
        enabled: true,
        flow: 'single',
      },
    });

    await client.fetch('https://api.relai.fi/protected', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ping: true }),
    });

    const firstCallInit = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    const firstCallHeaders = (firstCallInit?.headers || {}) as Record<string, string>;
    const firstNormalized = Object.fromEntries(
      Object.entries(firstCallHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );

    expect(firstNormalized['x-integritas']).toBe('true');
    expect(firstNormalized['x-integritas-flow']).toBe('single');

    await client.fetch('https://api.relai.fi/protected', {
      method: 'GET',
      x402: {
        integritas: false,
      },
    });

    const secondCallInit = fetchSpy.mock.calls[1]?.[1] as RequestInit | undefined;
    const secondCallHeaders = (secondCallInit?.headers || {}) as Record<string, string>;
    const secondNormalized = Object.fromEntries(
      Object.entries(secondCallHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );

    expect(secondNormalized['x-integritas']).toBeUndefined();
    expect(secondNormalized['x-integritas-flow']).toBeUndefined();
  });

  it('uses websocket preflight and paid retry for relay URL', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in websocket-only relay flow');
    });
    const signTypedData = vi.fn().mockResolvedValue(`0x${'11'.repeat(65)}`);
    const relayRequests: RelayEnvelope[] = [];

    const client = createX402Client({
      wallets: {
        evm: {
          address: '0x00000000000000000000000000000000000000aa',
          signTypedData,
        },
      },
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          relayRequests.push(envelope);

          if (!envelope.payment) {
            return {
              id: envelope.id,
              error: {
                code: 402,
                message: 'Payment required',
                paymentRequired: {
                  x402Version: 2,
                  accepts: [
                    {
                      scheme: 'exact',
                      network: 'eip155:8453',
                      amount: '10000',
                      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                      payTo: '0x0000000000000000000000000000000000000001',
                      extra: {
                        relayerContract: '0x457Db7ceBAdaF6A043AcE833de95C46E982cEdC8',
                        domainName: 'A402',
                        domainVersion: '1',
                      },
                    },
                  ],
                },
              },
            };
          }

          return {
            id: envelope.id,
            result: {
              ok: true,
              transport: 'ws',
            },
            paymentResponse: {
              transaction: '0xabc123',
              network: 'eip155:8453',
            },
            metadata: {
              status: 200,
            },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch('https://api.relai.fi/relay/1769629274857/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messages: [{ role: 'user', content: 'Hello' }],
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'ws' });

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(relayRequests).toHaveLength(2);
    expect(relayRequests[0].payment).toBeUndefined();
    expect(relayRequests[1].payment).toBeDefined();

    const paymentResponseHeader = response.headers.get('PAYMENT-RESPONSE');
    expect(paymentResponseHeader).toBeTruthy();
  });

  it('uses websocket relay transport for whitelabel relay URLs', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in websocket-only relay flow');
    });
    const relayRequests: RelayEnvelope[] = [];

    const client = createX402Client({
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          relayRequests.push(envelope);
          return {
            id: envelope.id,
            result: {
              ok: true,
              transport: 'ws-whitelabel',
            },
            metadata: {
              status: 200,
            },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch('https://tgmetrics.x402.fi/projects?page=1', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'ws-whitelabel' });
    expect(fetchSpy).not.toHaveBeenCalled();

    expect(relayRequests).toHaveLength(1);
    expect(relayRequests[0].method).toBe('relay.call');
    expect(relayRequests[0].params).toMatchObject({
      apiId: 'tgmetrics',
      path: '/projects?page=1',
      requestMethod: 'GET',
    });
  });

  it('manual 2-step WS flow performs preflight 402 then paid retry 200', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in manual 2-step websocket test');
    });
    const signTypedData = vi.fn().mockResolvedValue(`0x${'22'.repeat(65)}`);
    const relayRequests: RelayEnvelope[] = [];

    const relayUrl =
      'https://api.relai.fi/relay/1769629274857/v1/chat/completions?stream=true';
    const body = {
      messages: [{ role: 'user', content: 'Manual 2-step WS test' }],
      temperature: 0,
    };

    const client = createX402Client({
      wallets: {
        evm: {
          address: '0x00000000000000000000000000000000000000aa',
          signTypedData,
        },
      },
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          relayRequests.push(envelope);

          if (relayRequests.length === 1) {
            return {
              id: envelope.id,
              error: {
                code: 402,
                message: 'Payment required',
                paymentRequired: {
                  x402Version: 2,
                  accepts: [
                    {
                      scheme: 'exact',
                      network: 'eip155:8453',
                      amount: '10000',
                      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                      payTo: '0x0000000000000000000000000000000000000001',
                      extra: {
                        relayerContract: '0x457Db7ceBAdaF6A043AcE833de95C46E982cEdC8',
                        domainName: 'A402',
                        domainVersion: '1',
                      },
                    },
                  ],
                },
              },
            };
          }

          if (relayRequests.length === 2) {
            return {
              id: envelope.id,
              result: {
                ok: true,
                step: 'paid-retry',
              },
              metadata: {
                status: 200,
              },
            };
          }

          return {
            id: envelope.id,
            error: {
              code: 500,
              message: 'Unexpected extra websocket relay call',
            },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch(relayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Test-Case': 'manual-two-step',
      },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, step: 'paid-retry' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(signTypedData).toHaveBeenCalledWith(
      expect.objectContaining({
        primaryType: 'TransferWithAuthorization',
        domain: expect.objectContaining({
          name: 'A402',
          version: '1',
          chainId: 8453,
          verifyingContract: '0x457Db7ceBAdaF6A043AcE833de95C46E982cEdC8',
        }),
      }),
    );

    expect(relayRequests).toHaveLength(2);

    const preflightRequest = relayRequests[0];
    const paidRequest = relayRequests[1];

    expect(preflightRequest.method).toBe('relay.call');
    expect(preflightRequest.payment).toBeUndefined();
    expect(preflightRequest.params).toMatchObject({
      apiId: '1769629274857',
      path: '/v1/chat/completions?stream=true',
      requestMethod: 'POST',
      requestBody: body,
    });

    const preflightHeaders = preflightRequest.params?.requestHeaders || {};
    const normalizedHeaders = Object.fromEntries(
      Object.entries(preflightHeaders).map(([key, value]) => [key.toLowerCase(), value]),
    );
    expect(normalizedHeaders['content-type']).toBe('application/json');
    expect(normalizedHeaders['x-test-case']).toBe('manual-two-step');
    expect(normalizedHeaders['accept']).toBe('application/json');

    expect(paidRequest.method).toBe('relay.call');
    expect(paidRequest.payment).toBeDefined();
    expect(paidRequest.params).toMatchObject(preflightRequest.params || {});

    const paidPayload = paidRequest.payment as {
      x402Version?: number;
      resource?: { url?: string };
      accepted?: { network?: string; amount?: string };
      payload?: { authorization?: { validAfter?: string }; signature?: unknown };
    };

    expect(paidPayload.x402Version).toBe(2);
    expect(paidPayload.resource).toMatchObject({ url: relayUrl });
    expect(paidPayload.accepted).toMatchObject({
      network: 'eip155:8453',
      amount: '10000',
    });
    expect(paidPayload.payload?.authorization?.validAfter).toBe('0');
    expect(typeof paidPayload.payload?.signature).toBe('string');
  });

  it('falls back to HTTP flow when websocket preflight has multi-accept requirements', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, transport: 'http-fallback' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );

    const client = createX402Client({
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => ({
          id: envelope.id,
          error: {
            code: 402,
            message: 'Payment required',
            paymentRequired: {
              x402Version: 2,
              accepts: [
                {
                  scheme: 'exact',
                  network: 'eip155:8453',
                  amount: '10000',
                  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                  payTo: '0x0000000000000000000000000000000000000001',
                },
                {
                  scheme: 'exact',
                  network: 'eip155:8453',
                  amount: '500',
                  asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                  payTo: '0x0000000000000000000000000000000000000002',
                },
              ],
            },
          },
        })),
      },
      verbose: false,
    });

    const response = await client.fetch('https://api.relai.fi/relay/1769629274857/v1/chat/completions', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'http-fallback' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to HTTP when websocket paid retry fails after payment starts', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({ ok: true, transport: 'http-fallback' }), {
        status: 200,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    );
    const signTypedData = vi.fn().mockResolvedValue(`0x${'33'.repeat(65)}`);

    let wsCallCount = 0;
    const client = createX402Client({
      wallets: {
        evm: {
          address: '0x00000000000000000000000000000000000000aa',
          signTypedData,
        },
      },
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          wsCallCount += 1;

          if (wsCallCount === 1) {
            return {
              id: envelope.id,
              error: {
                code: 402,
                message: 'Payment required',
                paymentRequired: {
                  x402Version: 2,
                  accepts: [
                    {
                      scheme: 'exact',
                      network: 'eip155:8453',
                      amount: '10000',
                      asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                      payTo: '0x0000000000000000000000000000000000000001',
                      extra: {
                        relayerContract: '0x457Db7ceBAdaF6A043AcE833de95C46E982cEdC8',
                        domainName: 'A402',
                        domainVersion: '1',
                      },
                    },
                  ],
                },
              },
            };
          }

          return {
            id: envelope.id,
            error: {
              code: 400,
              message: 'Target endpoint validation failed',
            },
          };
        }),
      },
      verbose: false,
    });

    await expect(
      client.fetch('https://api.relai.fi/relay/1769629274857/v1/chat/completions', {
        method: 'GET',
      })
    ).rejects.toThrow('Target endpoint validation failed');

    expect(signTypedData).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('sends Integritas headers in WS preflight and applies per-request flow override', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in websocket-only relay flow');
    });
    const relayRequests: RelayEnvelope[] = [];

    const client = createX402Client({
      integritas: {
        enabled: true,
        flow: 'dual',
      },
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          relayRequests.push(envelope);
          return {
            id: envelope.id,
            result: {
              ok: true,
              transport: 'ws',
            },
            metadata: {
              status: 200,
            },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch('https://api.relai.fi/relay/1769629274857/v1/test', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ ping: true }),
      x402: {
        integritas: {
          enabled: true,
          flow: 'single',
        },
      },
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'ws' });
    expect(fetchSpy).not.toHaveBeenCalled();

    const preflightHeaders = relayRequests[0]?.params?.requestHeaders || {};
    const normalizedHeaders = Object.fromEntries(
      Object.entries(preflightHeaders).map(([key, value]) => [key.toLowerCase(), String(value)]),
    );

    expect(normalizedHeaders['x-integritas']).toBe('true');
    expect(normalizedHeaders['x-integritas-flow']).toBe('single');
  });

  it('falls back to any payable network by default when preferred network wallet is unavailable', async () => {
    const signTypedData = vi.fn().mockResolvedValue(`0x${'44'.repeat(65)}`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      const headers = (init?.headers || {}) as Record<string, string>;
      const normalizedHeaders = Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]),
      );

      if (!normalizedHeaders['x-payment']) {
        return new Response(
          JSON.stringify({
            x402Version: 2,
            accepts: [
              {
                scheme: 'exact',
                network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                amount: '10000',
                asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
                payTo: '22QvLr6qgGteY1JXfaYoXg1H8ejsx1br6unS73oQ5ebM',
                extra: {
                  feePayer: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn',
                },
              },
              {
                scheme: 'exact',
                network: 'eip155:8453',
                amount: '10000',
                asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
                payTo: '0x0000000000000000000000000000000000000001',
                extra: {
                  relayerContract: '0x457Db7ceBAdaF6A043AcE833de95C46E982cEdC8',
                  domainName: 'A402',
                  domainVersion: '1',
                },
              },
            ],
          }),
          {
            status: 402,
            headers: { 'Content-Type': 'application/json' },
          },
        );
      }

      return new Response(JSON.stringify({ ok: true, transport: 'http' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    const client = createX402Client({
      wallets: {
        evm: {
          address: '0x00000000000000000000000000000000000000aa',
          signTypedData,
        },
      },
      preferredNetwork: 'solana',
      verbose: false,
    });

    const response = await client.fetch('https://api.relai.fi/protected', { method: 'GET' });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'http' });
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(signTypedData).toHaveBeenCalledTimes(1);
  });

  it('enforces strict preferred network selection mode', async () => {
    const signTypedData = vi.fn().mockResolvedValue(`0x${'55'.repeat(65)}`);

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          x402Version: 2,
          accepts: [
            {
              scheme: 'exact',
              network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
              amount: '10000',
              asset: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
              payTo: '22QvLr6qgGteY1JXfaYoXg1H8ejsx1br6unS73oQ5ebM',
              extra: {
                feePayer: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn',
              },
            },
            {
              scheme: 'exact',
              network: 'eip155:8453',
              amount: '10000',
              asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
              payTo: '0x0000000000000000000000000000000000000001',
              extra: {
                relayerContract: '0x457Db7ceBAdaF6A043AcE833de95C46E982cEdC8',
                domainName: 'A402',
                domainVersion: '1',
              },
            },
          ],
        }),
        {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        },
      ),
    );

    const client = createX402Client({
      wallets: {
        evm: {
          address: '0x00000000000000000000000000000000000000aa',
          signTypedData,
        },
      },
      preferredNetwork: 'solana',
      networkSelectionMode: 'strict_preferred',
      verbose: false,
    });

    await expect(client.fetch('https://api.relai.fi/protected', { method: 'GET' })).rejects.toThrow(
      /Preferred network solana/i,
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(signTypedData).not.toHaveBeenCalled();
  });
});
