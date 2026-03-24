/**
 * Tests for x402 auto-bridge — bridge: { enabled: true } in createX402Client.
 *
 * When no wallet matches the 402 accepts AND no extensions.bridge is present,
 * the client auto-discovers bridge info from the RelAI API and bridges.
 */

import { describe, expect, it, vi, afterEach } from 'vitest';
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
// Mock bridge module (static import in client.ts)
// ---------------------------------------------------------------------------
const SOLANA_CAIP2 = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp';

const MOCK_BRIDGE_INFO = {
  settleEndpoint: 'https://api.relai.fi/bridge/settle',
  supportedSourceChains: [SOLANA_CAIP2, 'eip155:4217'],
  supportedSourceAssets: [MOCK_MINT.toBase58(), '0xUSDC_TEMPO'],
  payTo: {
    [SOLANA_CAIP2]: MOCK_DEST_ATA.toBase58(),
    'eip155:4217': '0xBridgeReceiverTempo',
  },
  feePayerSvm: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn',
  feeBps: 100,
  paymentFacilitator: 'https://facilitator.x402.fi',
};

vi.mock('../bridge', () => ({
  getBridgeInfo: vi.fn().mockResolvedValue(MOCK_BRIDGE_INFO),
  selectSourceChain: vi.fn().mockReturnValue({
    type: 'solana' as const,
    chain: SOLANA_CAIP2,
  }),
  computeSourceAmount: vi.fn().mockReturnValue(1010000n),
  settleBridge: vi.fn().mockResolvedValue({
    success: true,
    targetTxId: '0xBASE_TARGET_TX',
    sourceTxId: 'SOLANA_SOURCE_SIG',
    xPayment: Buffer.from(JSON.stringify({
      x402Version: 2,
      settled: true,
      transaction: '0xBASE_TARGET_TX',
    })).toString('base64'),
  }),
  DEFAULT_EVM_RPC: {},
}));

// ---------------------------------------------------------------------------
// Import client AFTER mocks
// ---------------------------------------------------------------------------
const { createX402Client } = await import('../client');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_CAIP2 = 'eip155:8453';

function createSolanaWalletMock() {
  const signedTx = { serialize: () => new Uint8Array(64) } as unknown as VersionedTransaction;
  return {
    publicKey: new PublicKey('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy'),
    signTransaction: vi.fn().mockResolvedValue(signedTx),
  };
}

/** 402 response: merchant accepts Base only, NO bridge extension */
function buildBaseOnly402() {
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
    // NOTE: NO extensions.bridge — auto-bridge must kick in
  };
}

/** Simple fetch mock: 402 first, then 200 on retry with X-PAYMENT */
function buildFetchMock() {
  return vi.fn().mockImplementation((_url: string | URL | Request, init?: any) => {
    // Retry with X-PAYMENT → 200
    if (init?.headers?.['X-PAYMENT']) {
      return Promise.resolve({
        status: 200,
        json: () => Promise.resolve({ data: 'success', bridged: true }),
        headers: { get: () => null },
      });
    }

    // Initial request → 402
    return Promise.resolve({
      status: 402,
      clone: () => ({ json: () => Promise.resolve(buildBaseOnly402()) }),
      headers: { get: () => null },
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('x402 auto-bridge (bridge: { enabled: true })', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('auto-bridges when no wallet match, no extension, but bridge enabled', async () => {
    const solanaWallet = createSolanaWalletMock();
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({
      wallets: { solana: solanaWallet },
      bridge: { enabled: true },
    });

    const response = await client.fetch('https://api.example.com/data');
    expect(response.status).toBe(200);

    // Find the retry call with X-PAYMENT header
    const retryCall = fetchMock.mock.calls.find(
      (call: any[]) => call[1]?.headers?.['X-PAYMENT'],
    );
    expect(retryCall).toBeDefined();

    // Verify the xPayment from bridge settle is forwarded as-is
    const xPayment = retryCall![1].headers['X-PAYMENT'];
    const proof = JSON.parse(Buffer.from(xPayment, 'base64').toString());
    expect(proof.x402Version).toBe(2);
    expect(proof.transaction).toBe('0xBASE_TARGET_TX');
  });

  it('does NOT auto-bridge when bridge is not enabled', async () => {
    const solanaWallet = createSolanaWalletMock();
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    // No bridge config
    const client = createX402Client({ wallets: { solana: solanaWallet } });
    await expect(client.fetch('https://api.example.com/data')).rejects.toThrow(/No wallet available/);
  });

  it('falls through to error when auto-bridge settle fails', async () => {
    const { settleBridge } = await import('../bridge');
    (settleBridge as any).mockRejectedValueOnce(new Error('settle_failed'));

    const solanaWallet = createSolanaWalletMock();
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({
      wallets: { solana: solanaWallet },
      bridge: { enabled: true },
    });

    // Auto-bridge fails, falls through to no-wallet error
    await expect(client.fetch('https://api.example.com/data')).rejects.toThrow(/No wallet available/);
  });

  it('falls through to error when no source chain matches', async () => {
    const { selectSourceChain } = await import('../bridge');
    (selectSourceChain as any).mockReturnValueOnce(null);

    const solanaWallet = createSolanaWalletMock();
    const fetchMock = buildFetchMock();
    vi.stubGlobal('fetch', fetchMock);

    const client = createX402Client({
      wallets: { solana: solanaWallet },
      bridge: { enabled: true },
    });

    await expect(client.fetch('https://api.example.com/data')).rejects.toThrow(/No wallet available/);
  });
});
