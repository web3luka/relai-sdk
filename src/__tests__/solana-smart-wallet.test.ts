/**
 * Solana Smart Wallet payment tests
 *
 * Verifies that createX402Client correctly handles payment signing from:
 * - Regular EOA wallets (on-curve keypairs)
 * - Smart wallets / PDA-based signers (off-curve public keys: Squads, Crossmint, SWIG)
 *
 * Smart wallets implement the same SolanaWallet interface (publicKey + signTransaction),
 * so the SDK should work identically — the key difference is allowOffCurve=true in ATA lookup.
 */

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { PublicKey, VersionedTransaction } from '@solana/web3.js';

// ---------------------------------------------------------------------------
// Mocks — must be before createX402Client import
// ---------------------------------------------------------------------------

const mockGetLatestBlockhash = vi.fn().mockResolvedValue({
  blockhash: '11111111111111111111111111111111',
  lastValidBlockHeight: 999,
});

const mockGetAccountInfo = vi.fn().mockResolvedValue({ owner: new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') });

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

const MOCK_MINT_PUBKEY = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'); // USDC mainnet
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
  (_mint: PublicKey, owner: PublicKey, _allowOffCurve: boolean) => {
    // Return different ATA depending on owner (source vs destination)
    return Promise.resolve(
      owner.toBase58() === MOCK_DEST_ATA.toBase58()
        ? MOCK_DEST_ATA
        : MOCK_SOURCE_ATA,
    );
  },
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
// Helpers
// ---------------------------------------------------------------------------

/** Create a regular on-curve wallet mock */
function createEoaWalletMock() {
  const keypairPubkey = new PublicKey('DRpbCBMxVnDK7maPM5tGv6MvB3v1sRMC86PZ8okm21hy');
  const signedTx = { serialize: () => new Uint8Array(64) } as unknown as VersionedTransaction;

  return {
    publicKey: keypairPubkey,
    signTransaction: vi.fn().mockResolvedValue(signedTx),
  };
}

/**
 * Create a smart wallet mock with a PDA (off-curve) public key.
 * PDA keys are off-curve — they cannot be generated from a private key.
 * Example: Squads vault PDA, Crossmint wallet PDA, SWIG session key PDA.
 *
 * We use a known PDA address from the Squads program for testing.
 */
function createSmartWalletMock() {
  // This is a real Squads multisig vault PDA — guaranteed off-curve
  const pdaPubkey = new PublicKey('8sz9ZJHX4PoxVdyuVCHUbGjBJ1gbRPGM9v1ZUGPoJixV');
  const signedTx = { serialize: () => new Uint8Array(64) } as unknown as VersionedTransaction;

  return {
    publicKey: pdaPubkey,
    signTransaction: vi.fn().mockResolvedValue(signedTx),
  };
}

/** Build a minimal 402 response with Solana accept */
function build402Response(feePayer = '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn') {
  const requirements = {
    accepts: [
      {
        scheme: 'svm-exact',
        network: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
        asset: MOCK_MINT_PUBKEY.toBase58(),
        payTo: MOCK_DEST_ATA.toBase58(),
        amount: '100000',
        extra: { feePayer, decimals: 6 },
      },
    ],
    resource: { url: 'https://api.example.com/test' },
  };
  return requirements;
}

// ---------------------------------------------------------------------------
// Import client AFTER mocks are registered
// ---------------------------------------------------------------------------
const { createX402Client } = await import('../client');

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Solana Smart Wallet — buildSolanaPayment', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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

  it('EOA wallet — signTransaction called with VersionedTransaction', async () => {
    const wallet = createEoaWalletMock();
    const requirements = build402Response();

    let capturedPaymentHeader: string | null = null;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(requirements), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockImplementation((_url: string, init?: RequestInit) => {
        capturedPaymentHeader = (init?.headers as Record<string, string>)?.['X-PAYMENT'] ?? null;
        return Promise.resolve(new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));
      });

    vi.stubGlobal('fetch', mockFetch);

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    const response = await client.fetch('https://api.example.com/test');

    expect(response.status).toBe(200);
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(wallet.signTransaction).toHaveBeenCalledWith(expect.any(VersionedTransaction));
    expect(capturedPaymentHeader).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('Smart wallet (PDA/off-curve) — signTransaction called identically to EOA', async () => {
    const wallet = createSmartWalletMock();
    const requirements = build402Response();

    let capturedPaymentHeader: string | null = null;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(requirements), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockImplementation((_url: string, init?: RequestInit) => {
        capturedPaymentHeader = (init?.headers as Record<string, string>)?.['X-PAYMENT'] ?? null;
        return Promise.resolve(new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));
      });

    vi.stubGlobal('fetch', mockFetch);

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    const response = await client.fetch('https://api.example.com/test');

    expect(response.status).toBe(200);
    expect(wallet.signTransaction).toHaveBeenCalledOnce();
    expect(wallet.signTransaction).toHaveBeenCalledWith(expect.any(VersionedTransaction));
    expect(capturedPaymentHeader).not.toBeNull();

    vi.unstubAllGlobals();
  });

  it('getAssociatedTokenAddress called with allowOffCurve=true for smart wallet PDA', async () => {
    const wallet = createSmartWalletMock();
    const requirements = build402Response();

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(requirements), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: 'ok' }), { status: 200 }));

    vi.stubGlobal('fetch', mockFetch);

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    await client.fetch('https://api.example.com/test');

    // First call = source ATA (user's wallet). allowOffCurve must be true.
    const sourceAtaCall = mockGetAssociatedTokenAddress.mock.calls[0];
    expect(sourceAtaCall[2]).toBe(true); // allowOffCurve

    vi.unstubAllGlobals();
  });

  it('X-PAYMENT header contains valid base64-encoded JSON payload', async () => {
    const wallet = createEoaWalletMock();
    const requirements = build402Response();

    let capturedPaymentHeader: string | null = null;

    const mockFetch = vi.fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify(requirements), {
          status: 402,
          headers: { 'Content-Type': 'application/json' },
        }),
      )
      .mockImplementation((_url: string, init?: RequestInit) => {
        capturedPaymentHeader = (init?.headers as Record<string, string>)?.['X-PAYMENT'] ?? null;
        return Promise.resolve(new Response('{}', { status: 200 }));
      });

    vi.stubGlobal('fetch', mockFetch);

    const client = createX402Client({
      wallets: { solana: wallet },
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    await client.fetch('https://api.example.com/test');

    expect(capturedPaymentHeader).not.toBeNull();

    const decoded = JSON.parse(Buffer.from(capturedPaymentHeader!, 'base64').toString('utf-8'));
    expect(decoded.x402Version).toBe(2);
    expect(decoded.payload?.transaction).toBeDefined();
    expect(decoded.accepted?.network).toContain('solana');

    vi.unstubAllGlobals();
  });

  it('maxAmountAtomic guard blocks overpayment for smart wallet', async () => {
    const wallet = createSmartWalletMock();
    const requirements = build402Response();
    // 402 asks for 100000, we cap at 50000

    const mockFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(requirements), {
        status: 402,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    vi.stubGlobal('fetch', mockFetch);

    const client = createX402Client({
      wallets: { solana: wallet },
      maxAmountAtomic: '50000',
      solanaRpcUrl: 'https://api.mainnet-beta.solana.com',
    });

    await expect(client.fetch('https://api.example.com/test')).rejects.toThrow(
      /exceeds max/,
    );

    vi.unstubAllGlobals();
  });
});
