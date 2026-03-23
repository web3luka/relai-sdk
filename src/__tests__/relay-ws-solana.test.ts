/**
 * WebSocket relay transport tests — Solana payment paths (x402 + MPP).
 *
 * Solana mocks must be registered BEFORE importing createX402Client,
 * so these live in a separate file from the EVM-only relay-ws tests.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';
import type { MppHandler, RelayWebSocketFactory, RelayWebSocketLike } from '../client';

// ---------------------------------------------------------------------------
// Solana mocks — before client import
// ---------------------------------------------------------------------------

const mockGetLatestBlockhash = vi.fn().mockResolvedValue({
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: 999,
});

const mockGetAccountInfo = vi.fn().mockResolvedValue({
  owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
});

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();

  class MockConnection {
    getLatestBlockhash = mockGetLatestBlockhash;
    getAccountInfo = mockGetAccountInfo;
  }

  return {
    ...actual,
    Connection: MockConnection,
  };
});

const MOCK_MINT_PUBKEY = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MOCK_SOURCE_ATA = new PublicKey('So11111111111111111111111111111111111111112');
const MOCK_DEST_ATA = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

const mockGetMint = vi.fn().mockResolvedValue({
  address: MOCK_MINT_PUBKEY,
  decimals: 6,
  supply: 1000000n,
  isInitialized: true,
  freezeAuthority: null,
  mintAuthority: null,
});

const mockGetAssociatedTokenAddress = vi.fn().mockImplementation(
  (_mint: PublicKey, owner: PublicKey) =>
    Promise.resolve(
      owner.toBase58() === MOCK_DEST_ATA.toBase58() ? MOCK_DEST_ATA : MOCK_SOURCE_ATA,
    ),
);

vi.mock('@solana/spl-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/spl-token')>();
  return {
    ...actual,
    getMint: mockGetMint,
    getAssociatedTokenAddress: mockGetAssociatedTokenAddress,
    createTransferCheckedInstruction: vi.fn().mockReturnValue({
      programId: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'),
      keys: [],
      data: Buffer.alloc(0),
    }),
  };
});

// ---------------------------------------------------------------------------
// Import client AFTER mocks
// ---------------------------------------------------------------------------
const { createX402Client } = await import('../client');

// ---------------------------------------------------------------------------
// WS helpers (same as relay-ws.test.ts)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Solana wallet mock
// ---------------------------------------------------------------------------

function createSolanaWalletMock() {
  const pubkey = new PublicKey('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy');
  const signedTx = { serialize: () => new Uint8Array(64) } as unknown as VersionedTransaction;

  return {
    publicKey: pubkey,
    signTransaction: vi.fn().mockResolvedValue(signedTx),
  };
}

function solana402WsError(envelope: { id?: string }) {
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
            network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
            amount: '100000',
            asset: MOCK_MINT_PUBKEY.toBase58(),
            payTo: MOCK_DEST_ATA.toBase58(),
            extra: {
              feePayer: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn',
              decimals: 6,
            },
          },
        ],
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WebSocket relay — Solana x402 payment', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Re-seed Solana mocks (clearAllMocks resets return values)
    mockGetLatestBlockhash.mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 999,
    });
    mockGetMint.mockResolvedValue({
      address: MOCK_MINT_PUBKEY,
      decimals: 6,
      supply: 1000000n,
      isInitialized: true,
      freezeAuthority: null,
      mintAuthority: null,
    });
    mockGetAssociatedTokenAddress.mockImplementation(
      (_mint: PublicKey, owner: PublicKey) =>
        Promise.resolve(
          owner.toBase58() === MOCK_DEST_ATA.toBase58() ? MOCK_DEST_ATA : MOCK_SOURCE_ATA,
        ),
    );
  });

  it('WS preflight 402 → Solana x402 payment → paid retry 200', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called in WS Solana flow');
    });
    const wallet = createSolanaWalletMock();
    const relayRequests: RelayEnvelope[] = [];

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          relayRequests.push(envelope);

          if (!envelope.payment) {
            return solana402WsError(envelope);
          }

          return {
            id: envelope.id,
            result: { ok: true, transport: 'ws-solana' },
            paymentResponse: { transaction: 'solana-tx-abc', network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' },
            metadata: { status: 200 },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch('https://api.relai.fi/relay/42/v1/data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: 'test' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'ws-solana' });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).toHaveBeenCalledWith(expect.any(VersionedTransaction));

    expect(relayRequests).toHaveLength(2);
    expect(relayRequests[0].payment).toBeUndefined();
    expect(relayRequests[1].payment).toBeDefined();

    // Verify payment payload structure
    const payment = relayRequests[1].payment as any;
    expect(payment.x402Version).toBe(2);
    expect(payment.accepted?.network).toContain('solana');
    expect(payment.payload?.transaction).toBeDefined();

    const paymentResponseHeader = response.headers.get('PAYMENT-RESPONSE');
    expect(paymentResponseHeader).toBeTruthy();
  });

  it('WS Solana payment respects maxAmountAtomic guard', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called');
    });
    const wallet = createSolanaWalletMock();

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
      maxAmountAtomic: '50000', // 402 asks for 100000
      relayWs: {
        enabled: true,
        fallbackToHttp: false,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          return solana402WsError(envelope);
        }),
      },
      verbose: false,
    });

    await expect(
      client.fetch('https://api.relai.fi/relay/42/v1/data', { method: 'GET' }),
    ).rejects.toThrow(/exceeds max/);

    expect(wallet.signTransaction).not.toHaveBeenCalled();
  });

  it('WS whitelabel relay URL works with Solana wallet', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called');
    });
    const wallet = createSolanaWalletMock();
    const relayRequests: RelayEnvelope[] = [];

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
      relayWs: {
        enabled: true,
        webSocketFactory: createMockRelayWebSocketFactory((envelope: RelayEnvelope) => {
          relayRequests.push(envelope);
          // Free endpoint — no 402
          return {
            id: envelope.id,
            result: { ok: true, transport: 'ws-whitelabel-solana' },
            metadata: { status: 200 },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch('https://myapp.x402.fi/api/data?page=1', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'ws-whitelabel-solana' });
    expect(relayRequests).toHaveLength(1);
    expect(relayRequests[0].params).toMatchObject({
      apiId: 'myapp',
      path: '/api/data?page=1',
      requestMethod: 'GET',
    });
  });
});

describe('WebSocket relay — Solana MPP payment', () => {
  afterEach(() => {
    vi.clearAllMocks();
    // Re-seed Solana mocks (clearAllMocks resets return values)
    mockGetLatestBlockhash.mockResolvedValue({
      blockhash: '11111111111111111111111111111111',
      lastValidBlockHeight: 999,
    });
    mockGetMint.mockResolvedValue({
      address: MOCK_MINT_PUBKEY,
      decimals: 6,
      supply: 1000000n,
      isInitialized: true,
      freezeAuthority: null,
      mintAuthority: null,
    });
    mockGetAssociatedTokenAddress.mockImplementation(
      (_mint: PublicKey, owner: PublicKey) =>
        Promise.resolve(
          owner.toBase58() === MOCK_DEST_ATA.toBase58() ? MOCK_DEST_ATA : MOCK_SOURCE_ATA,
        ),
    );
  });

  it('WS preflight 402 with mppChallenge → MPP credential → retry 200 (Solana context)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called');
    });
    const mppCreateCredential = vi.fn().mockResolvedValue('Payment realm="mpp" token="sol-cred"');
    const mppHandler: MppHandler = { createCredential: mppCreateCredential };
    const relayRequests: RelayEnvelope[] = [];

    const client = createX402Client({
      mpp: mppHandler,
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
                mppChallenge: 'Payment realm="mpp" challenge="c29sYW5h" method="solana-charge"',
                paymentRequired: {
                  x402Version: 2,
                  accepts: [
                    {
                      scheme: 'exact',
                      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                      amount: '50000',
                      asset: MOCK_MINT_PUBKEY.toBase58(),
                      payTo: MOCK_DEST_ATA.toBase58(),
                      extra: { feePayer: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn' },
                    },
                  ],
                },
              },
            };
          }

          return {
            id: envelope.id,
            result: { ok: true, transport: 'ws-mpp-solana' },
            metadata: { status: 200 },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch('https://api.relai.fi/relay/77/v1/data', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'ws-mpp-solana' });

    expect(mppCreateCredential).toHaveBeenCalledTimes(1);
    const syntheticRes = mppCreateCredential.mock.calls[0][0] as Response;
    expect(syntheticRes.headers.get('www-authenticate')).toContain('solana-charge');

    expect(relayRequests).toHaveLength(2);
    expect(relayRequests[1].params?.requestHeaders?.['Authorization']).toContain('Payment');
  });

  it('WS MPP fails → falls through to Solana x402 payment', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      throw new Error('fetch should not be called');
    });
    const wallet = createSolanaWalletMock();
    const mppCreateCredential = vi.fn().mockRejectedValue(new Error('MPP signer unavailable'));
    const mppHandler: MppHandler = { createCredential: mppCreateCredential };
    const relayRequests: RelayEnvelope[] = [];

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
      mpp: mppHandler,
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
                mppChallenge: 'Payment realm="mpp" challenge="fail" method="solana-charge"',
                paymentRequired: {
                  x402Version: 2,
                  accepts: [
                    {
                      scheme: 'exact',
                      network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
                      amount: '100000',
                      asset: MOCK_MINT_PUBKEY.toBase58(),
                      payTo: MOCK_DEST_ATA.toBase58(),
                      extra: {
                        feePayer: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn',
                        decimals: 6,
                      },
                    },
                  ],
                },
              },
            };
          }

          return {
            id: envelope.id,
            result: { ok: true, transport: 'ws-x402-solana-fallback' },
            paymentResponse: { transaction: 'sol-tx' },
            metadata: { status: 200 },
          };
        }),
      },
      verbose: false,
    });

    const response = await client.fetch('https://api.relai.fi/relay/88/v1/data', {
      method: 'GET',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, transport: 'ws-x402-solana-fallback' });

    // MPP attempted then failed, x402 Solana took over
    expect(mppCreateCredential).toHaveBeenCalledTimes(1);
    expect(wallet.signTransaction).toHaveBeenCalledTimes(1);
    expect(relayRequests).toHaveLength(2);
    expect(relayRequests[1].payment).toBeDefined();
  });
});
