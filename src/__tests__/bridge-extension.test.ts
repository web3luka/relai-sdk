/**
 * Bridge extension tests
 *
 * Verifies that createX402Client correctly handles the x402 bridge extension:
 * - Falls back to bridge when no direct wallet match exists for merchant's chain
 * - Calls POST /bridge/settle with correct payload
 * - Uses returned xPayment to retry the original request
 * - Throws when bridge extension is absent and no wallet matches
 * - Throws when bridge endpoint returns error
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Mocks — must be before createX402Client import
// ---------------------------------------------------------------------------

vi.mock('@solana/web3.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/web3.js')>();
  class MockConnection {
    getLatestBlockhash = vi.fn().mockResolvedValue({ blockhash: '11111111111111111111111111111111', lastValidBlockHeight: 999 });
    getAccountInfo = vi.fn().mockResolvedValue({ owner: new actual.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });
  }
  return { ...actual, Connection: MockConnection };
});

const MOCK_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
const MOCK_SOURCE_ATA = new PublicKey('So11111111111111111111111111111111111111112');
const MOCK_DEST_ATA = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

vi.mock('@solana/spl-token', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@solana/spl-token')>();
  return {
    ...actual,
    getMint: vi.fn().mockResolvedValue({ address: MOCK_MINT, decimals: 6, supply: 1000000n, isInitialized: true, freezeAuthority: null, mintAuthority: null }),
    getAssociatedTokenAddress: vi.fn().mockImplementation((_mint: PublicKey, owner: PublicKey) =>
      Promise.resolve(owner.toBase58() === MOCK_DEST_ATA.toBase58() ? MOCK_DEST_ATA : MOCK_SOURCE_ATA),
    ),
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
// Helpers
// ---------------------------------------------------------------------------

const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';
const BASE_CAIP2 = 'eip155:8453';
const BRIDGE_ENDPOINT = 'https://facilitator.x402.fi/bridge/settle';
const MOCK_FEE_PAYER = '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn';

function createSolanaWalletMock() {
  const signedTx = { serialize: () => new Uint8Array(64) } as unknown as VersionedTransaction;
  return {
    publicKey: new PublicKey('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'),
    signTransaction: vi.fn().mockResolvedValue(signedTx),
  };
}

/** 402 response where merchant only accepts Base — client has Solana wallet → needs bridge */
function buildBaseOnly402WithBridge() {
  return {
    accepts: [
      {
        scheme: 'exact',
        network: BASE_CAIP2,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0xMerchantOnBase',
        amount: '1000000',
      },
    ],
    resource: { url: 'https://api.example.com/data' },
    extensions: {
      bridge: {
        info: {
          provider: 'relai',
          endpoint: BRIDGE_ENDPOINT,
          supportedSourceChains: [SOLANA_CAIP2],
          supportedSourceAssets: [MOCK_MINT.toBase58()],
          payTo: MOCK_DEST_ATA.toBase58(),
          feePayer: MOCK_FEE_PAYER,
          feesBps: 30,
        },
        schema: {},
      },
    },
  };
}

/** 402 response where merchant only accepts Base — NO bridge extension */
function buildBaseOnly402NoBridge() {
  return {
    accepts: [
      {
        scheme: 'exact',
        network: BASE_CAIP2,
        asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
        payTo: '0xMerchantOnBase',
        amount: '1000000',
      },
    ],
    resource: { url: 'https://api.example.com/data' },
  };
}

/** 402 response where merchant accepts Solana — client has Solana wallet → direct, no bridge */
function buildSolanaAccept402() {
  return {
    accepts: [
      {
        scheme: 'exact',
        network: SOLANA_CAIP2,
        asset: MOCK_MINT.toBase58(),
        payTo: MOCK_DEST_ATA.toBase58(),
        amount: '100000',
        extra: { feePayer: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn', decimals: 6 },
      },
    ],
    resource: { url: 'https://api.example.com/data' },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Bridge extension — getBridgeExtension / selectBridgeSource', () => {
  it('uses bridge when no direct wallet match and bridge extension present', async () => {
    const solanaWallet = createSolanaWalletMock();
    const requirements = buildBaseOnly402WithBridge();

    const BRIDGE_X_PAYMENT = 'bridge-x-payment-token-abc123';

    // Mock fetch: first call returns 402 with bridge extension, second call (bridge/settle) returns xPayment, third call (retry) returns 200
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 402,
        clone: () => ({ json: () => Promise.resolve(requirements) }),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ xPayment: BRIDGE_X_PAYMENT, sourceTxId: 'solana-tx-abc', targetTxId: '0xbase-tx-def' }),
      })
      .mockResolvedValueOnce({
        status: 200,
        json: () => Promise.resolve({ data: 'success' }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({ wallets: { solana: solanaWallet } });
    const response = await client.fetch('https://api.example.com/data');

    expect(response.status).toBe(200);

    // Bridge settle was called
    const bridgeCall = fetchMock.mock.calls[1];
    expect(bridgeCall[0]).toBe(BRIDGE_ENDPOINT);
    const bridgeBody = JSON.parse(bridgeCall[1].body);
    expect(bridgeBody.sourceChain).toBe(SOLANA_CAIP2);
    expect(bridgeBody.targetAccept.network).toBe(BASE_CAIP2);

    // Final retry used xPayment from bridge
    const retryCall = fetchMock.mock.calls[2];
    expect(retryCall[1].headers['X-PAYMENT']).toBe(BRIDGE_X_PAYMENT);

    vi.unstubAllGlobals();
  });

  it('throws when no direct wallet match and NO bridge extension', async () => {
    const solanaWallet = createSolanaWalletMock();
    const requirements = buildBaseOnly402NoBridge();

    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 402,
      clone: () => ({ json: () => Promise.resolve(requirements) }),
      headers: { get: () => null },
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({ wallets: { solana: solanaWallet } });
    await expect(client.fetch('https://api.example.com/data')).rejects.toThrow(/No wallet available/);

    vi.unstubAllGlobals();
  });

  it('does NOT use bridge when direct wallet match exists', async () => {
    const solanaWallet = createSolanaWalletMock();
    const requirements = buildSolanaAccept402();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 402,
        clone: () => ({ json: () => Promise.resolve(requirements) }),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({ status: 200 });

    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({ wallets: { solana: solanaWallet } });
    await client.fetch('https://api.example.com/data');

    // Only 2 fetch calls: initial 402 + retry — bridge settle never called
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const calls = fetchMock.mock.calls.map((c) => c[0]);
    expect(calls).not.toContain(BRIDGE_ENDPOINT);

    vi.unstubAllGlobals();
  });

  it('throws when bridge endpoint returns error', async () => {
    const solanaWallet = createSolanaWalletMock();
    const requirements = buildBaseOnly402WithBridge();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 402,
        clone: () => ({ json: () => Promise.resolve(requirements) }),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'insufficient_liquidity' }),
      });

    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({ wallets: { solana: solanaWallet } });
    await expect(client.fetch('https://api.example.com/data')).rejects.toThrow(/bridge settle failed/);

    vi.unstubAllGlobals();
  });

  it('throws when bridge returns ok but missing xPayment', async () => {
    const solanaWallet = createSolanaWalletMock();
    const requirements = buildBaseOnly402WithBridge();

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        status: 402,
        clone: () => ({ json: () => Promise.resolve(requirements) }),
        headers: { get: () => null },
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }), // missing xPayment
      });

    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({ wallets: { solana: solanaWallet } });
    await expect(client.fetch('https://api.example.com/data')).rejects.toThrow(/xPayment/);

    vi.unstubAllGlobals();
  });

  it('ignores bridge extension when source chain not in supported list', async () => {
    const solanaWallet = createSolanaWalletMock();

    // Bridge only supports EVM source — client has Solana wallet → no match
    const requirements = {
      ...buildBaseOnly402WithBridge(),
      extensions: {
        bridge: {
          info: {
            provider: 'relai',
            endpoint: BRIDGE_ENDPOINT,
            supportedSourceChains: ['eip155:43114'], // Avalanche only
            supportedSourceAssets: ['0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E'],
            feesBps: 30,
          },
          schema: {},
        },
      },
    };

    const fetchMock = vi.fn().mockResolvedValueOnce({
      status: 402,
      clone: () => ({ json: () => Promise.resolve(requirements) }),
      headers: { get: () => null },
    });

    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({ wallets: { solana: solanaWallet } });
    await expect(client.fetch('https://api.example.com/data')).rejects.toThrow(/No wallet available/);

    vi.unstubAllGlobals();
  });
});
