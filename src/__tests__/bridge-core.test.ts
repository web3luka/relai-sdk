/**
 * Tests for src/bridge.ts — core bridge utilities.
 *
 * Tests:
 * - getBridgeInfo: fetches and caches bridge info from RelAI API
 * - settleBridge: calls settle endpoint with correct payload
 * - selectSourceChain: picks the right source chain based on wallets
 * - computeSourceAmount: adds bridge fee correctly
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import {
  getBridgeInfo,
  settleBridge,
  selectSourceChain,
  computeSourceAmount,
} from '../bridge';

// ---------------------------------------------------------------------------
// Mock bridge info response
// ---------------------------------------------------------------------------

const MOCK_BRIDGE_INFO = {
  settleEndpoint: 'https://api.relai.fi/bridge/settle',
  supportedSourceChains: ['eip155:4217', 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
  supportedSourceAssets: ['0xUSDC_TEMPO', '0xUSDC_BASE', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  payTo: {
    'eip155:4217': '0xBridgeReceiverTempo',
    'eip155:8453': '0xBridgeReceiverBase',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'SolanaBridgeReceiver',
  },
  feePayerSvm: '4x4ZhcqiT1FnirM8Ne97iVupkN4NcQgc2YYbE2jDZbZn',
  feeBps: 100,
  paymentFacilitator: 'https://facilitator.x402.fi',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('selectSourceChain', () => {
  it('picks preferred EVM chain when available', () => {
    const result = selectSourceChain(
      ['eip155:4217', 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      true,  // hasEvmWallet
      false, // hasSolanaWallet
      4217,  // preferredSourceChainId
    );
    expect(result).toEqual({ type: 'evm', chain: 'eip155:4217' });
  });

  it('falls back to any EVM chain when preferred not in list', () => {
    const result = selectSourceChain(
      ['eip155:8453'],
      true,
      false,
      4217, // preferred is Tempo but only Base available
    );
    expect(result).toEqual({ type: 'evm', chain: 'eip155:8453' });
  });

  it('prioritizes Solana when both wallets available', () => {
    const result = selectSourceChain(
      ['eip155:4217', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
      true,
      true,
    );
    expect(result).toEqual({ type: 'solana', chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp' });
  });

  it('picks EVM when only EVM wallet and EVM chains', () => {
    const result = selectSourceChain(
      ['eip155:4217', 'eip155:8453'],
      true,
      false,
    );
    expect(result).toEqual({ type: 'evm', chain: 'eip155:4217' });
  });

  it('returns null when no wallet matches any chain', () => {
    const result = selectSourceChain(
      ['eip155:4217'],
      false, // no EVM wallet
      false, // no Solana wallet
    );
    expect(result).toBeNull();
  });

  it('returns null when Solana wallet but only EVM chains', () => {
    const result = selectSourceChain(
      ['eip155:4217', 'eip155:8453'],
      false,
      true,
    );
    expect(result).toBeNull();
  });

  it('returns null on empty chain list', () => {
    const result = selectSourceChain([], true, true);
    expect(result).toBeNull();
  });
});

describe('computeSourceAmount', () => {
  it('adds 1% fee (100 bps)', () => {
    const result = computeSourceAmount(1000000n, 100);
    expect(result).toBe(1010000n); // 1000000 + 10000
  });

  it('adds 0.3% fee (30 bps)', () => {
    const result = computeSourceAmount(1000000n, 30);
    expect(result).toBe(1003000n);
  });

  it('handles zero fee', () => {
    const result = computeSourceAmount(1000000n, 0);
    expect(result).toBe(1000000n);
  });

  it('rounds down fractional fees', () => {
    // 333 * 50 / 10000 = 1.665 → floor to 1
    const result = computeSourceAmount(333n, 50);
    expect(result).toBe(334n);
  });
});

describe('getBridgeInfo', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches bridge info from API', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve(MOCK_BRIDGE_INFO),
    });

    // Force cache miss by using a unique base URL
    const info = await getBridgeInfo('https://api.relai.fi/test-' + Date.now());
    expect(info.settleEndpoint).toBe('https://api.relai.fi/bridge/settle');
    expect(info.supportedSourceChains).toContain('eip155:4217');
    expect(info.feeBps).toBe(100);
    expect(info.payTo['eip155:8453']).toBe('0xBridgeReceiverBase');
  });

  it('throws on fetch failure with no cache', async () => {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

    await expect(
      getBridgeInfo('https://api.relai.fi/fail-' + Date.now()),
    ).rejects.toThrow(/Failed to fetch/);
  });
});

describe('settleBridge', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts settle request and returns response', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({
        success: true,
        targetTxId: '0xTARGET_TX',
        sourceTxId: '0xSOURCE_TX',
      }),
    });

    const result = await settleBridge('https://api.relai.fi/bridge/settle', {
      sourcePayment: '0xSOURCE',
      sourceChain: 'eip155:4217',
      targetAccept: {
        scheme: 'exact',
        network: 'eip155:1187947933',
        asset: '0xUSDC',
        payTo: '0xMerchant',
        amount: '10000',
      },
      resource: 'test',
    });

    expect(result.targetTxId).toBe('0xTARGET_TX');
    expect(result.sourceTxId).toBe('0xSOURCE_TX');

    // Verify fetch was called correctly
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.relai.fi/bridge/settle');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.sourcePayment).toBe('0xSOURCE');
    expect(body.sourceChain).toBe('eip155:4217');
    expect(body.targetAccept.network).toBe('eip155:1187947933');
  });

  it('throws on settle failure', async () => {
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: 'insufficient_liquidity' }),
    });

    await expect(
      settleBridge('https://api.relai.fi/bridge/settle', {
        sourcePayment: '0x',
        sourceChain: 'eip155:4217',
        targetAccept: { scheme: 'exact', network: 'eip155:1', asset: '0x', payTo: '0x', amount: '0' },
        resource: 'test',
      }),
    ).rejects.toThrow(/insufficient_liquidity/);
  });
});
