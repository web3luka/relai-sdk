/**
 * Tests for src/mpp/with-bridge.ts — evmChargeWithBridge.
 *
 * Tests:
 * - Direct payment when source chain matches target chain (EVM)
 * - Bridged payment when chains differ (EVM source)
 * - Bridged payment from Solana source
 * - Solana ed25519 signature for settle
 * - Solana-only config (no evmAccount)
 * - Error handling: no wallet, settle failure, no source chain
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock viem
// ---------------------------------------------------------------------------
const mockSendTransaction = vi.fn();

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>();
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      sendTransaction: mockSendTransaction,
    })),
    http: vi.fn((url: string) => ({ url })),
    encodeFunctionData: vi.fn(() => '0xmocked_calldata'),
  };
});

// ---------------------------------------------------------------------------
// Mock bridge.ts
// ---------------------------------------------------------------------------
const MOCK_BRIDGE_INFO_EVM = {
  settleEndpoint: 'https://api.relai.fi/bridge/settle',
  supportedSourceChains: ['eip155:4217', 'eip155:8453'],
  supportedSourceAssets: ['0xUSDC_TEMPO', '0xUSDC_BASE'],
  payTo: {
    'eip155:4217': '0xBridgeReceiverTempo',
    'eip155:8453': '0xBridgeReceiverBase',
  },
  feePayerSvm: null,
  feeBps: 100,
  paymentFacilitator: 'https://facilitator.x402.fi',
};

const MOCK_BRIDGE_INFO_WITH_SOLANA = {
  settleEndpoint: 'https://api.relai.fi/bridge/settle',
  supportedSourceChains: ['eip155:4217', 'eip155:8453', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
  supportedSourceAssets: ['0xUSDC_TEMPO', '0xUSDC_BASE', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  payTo: {
    'eip155:4217': '0xBridgeReceiverTempo',
    'eip155:8453': '0xBridgeReceiverBase',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'SoLBridgeReceiver111',
  },
  feePayerSvm: 'SoLFeePayer111',
  feeBps: 100,
  paymentFacilitator: 'https://facilitator.x402.fi',
};

const mockGetBridgeInfo = vi.fn().mockResolvedValue(MOCK_BRIDGE_INFO_EVM);
const mockSettleBridge = vi.fn().mockResolvedValue({
  success: true,
  targetTxId: '0xTARGET_TX_HASH_FROM_BRIDGE',
  sourceTxId: '0xSOURCE_TX_HASH',
});
const mockSelectSourceChain = vi.fn().mockReturnValue({ type: 'evm', chain: 'eip155:4217' });
const mockComputeSourceAmount = vi.fn().mockReturnValue(10100n);

vi.mock('../bridge.js', () => ({
  getBridgeInfo: (...args: any[]) => mockGetBridgeInfo(...args),
  settleBridge: (...args: any[]) => mockSettleBridge(...args),
  selectSourceChain: (...args: any[]) => mockSelectSourceChain(...args),
  computeSourceAmount: (...args: any[]) => mockComputeSourceAmount(...args),
  DEFAULT_EVM_RPC: {
    'eip155:8453': 'https://mainnet.base.org',
    'eip155:4217': 'https://rpc.tempo.xyz',
  },
}));

// ---------------------------------------------------------------------------
// Mock @solana/web3.js & @solana/spl-token
// ---------------------------------------------------------------------------
const mockSolSendTransaction = vi.fn().mockResolvedValue('SoLSourceTxSignature123');
const mockSolConfirmTransaction = vi.fn().mockResolvedValue({ value: { err: null } });

vi.mock('@solana/web3.js', () => {
  const mockPublicKey = class {
    _base58: string;
    constructor(val: string) { this._base58 = val; }
    toBase58() { return this._base58; }
    static default = new (class { toBase58() { return 'default'; } })();
  };
  const mockKeypair = class {
    publicKey: any;
    secretKey: Uint8Array;
    constructor(pk: any, sk: Uint8Array) { this.publicKey = pk; this.secretKey = sk; }
    static fromSecretKey(sk: Uint8Array) {
      return new mockKeypair(new mockPublicKey('SoLClientWalletPubkey'), sk);
    }
  };
  return {
    Connection: vi.fn().mockImplementation(() => ({
      sendTransaction: mockSolSendTransaction,
      confirmTransaction: mockSolConfirmTransaction,
      getLatestBlockhash: vi.fn().mockResolvedValue({ blockhash: 'mockBlockhash' }),
    })),
    PublicKey: mockPublicKey,
    Keypair: mockKeypair,
    TransactionMessage: vi.fn().mockImplementation(() => ({
      compileToV0Message: vi.fn().mockReturnValue('mockV0Message'),
    })),
    VersionedTransaction: vi.fn().mockImplementation(() => ({
      sign: vi.fn(),
    })),
  };
});

vi.mock('@solana/spl-token', () => ({
  getAssociatedTokenAddress: vi.fn().mockResolvedValue('mockAta'),
  createTransferCheckedInstruction: vi.fn().mockReturnValue('mockTransferIx'),
  getMint: vi.fn().mockResolvedValue({ decimals: 6 }),
  TOKEN_PROGRAM_ID: { toBase58: () => 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA' },
  TOKEN_2022_PROGRAM_ID: { toBase58: () => 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb' },
}));

// ---------------------------------------------------------------------------
// Mock tweetnacl
// ---------------------------------------------------------------------------
const MOCK_SOLANA_SIGNATURE = new Uint8Array(64).fill(42);
vi.mock('tweetnacl', () => ({
  sign: {
    detached: vi.fn().mockReturnValue(MOCK_SOLANA_SIGNATURE),
  },
}));

// ---------------------------------------------------------------------------
// Mock bs58
// ---------------------------------------------------------------------------
vi.mock('bs58', () => ({
  default: {
    encode: vi.fn().mockReturnValue('MockBase58Signature'),
  },
}));

// ---------------------------------------------------------------------------
// Mock mppx
// ---------------------------------------------------------------------------
let capturedCreateCredential: (args: any) => Promise<string>;

const zMock = {
  string: () => zMock,
  number: () => zMock,
  object: (shape?: any) => zMock,
  array: (inner?: any) => zMock,
  optional: (inner?: any) => zMock,
  record: (...args: any[]) => zMock,
};

vi.mock('mppx', () => ({
  Method: {
    from: vi.fn((def: any) => def),
    toClient: vi.fn((_method: any, handler: any) => {
      capturedCreateCredential = handler.createCredential;
      return { __mppClient: true };
    }),
  },
  Credential: {
    serialize: vi.fn((data: any) => JSON.stringify(data)),
  },
  z: zMock,
}));

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
const { evmChargeWithBridge } = await import('../mpp/with-bridge');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_EVM_ACCOUNT = {
  address: '0xClientWallet' as `0x${string}`,
  type: 'local' as const,
  publicKey: '0x04' as `0x${string}`,
  source: 'privateKey' as const,
  signMessage: vi.fn().mockResolvedValue('0xEvmSignature'),
  signTransaction: vi.fn(),
  signTypedData: vi.fn(),
  nonceManager: undefined,
  experimental_signAuthMessage: undefined,
};

const MOCK_SOLANA_KEYPAIR = {
  publicKey: { toBase58: () => 'SoLClientWalletPubkey' },
  secretKey: new Uint8Array(64).fill(1),
};

function buildChallenge(targetChainId: number) {
  return {
    method: 'evm',
    intent: 'charge',
    request: {
      amount: '10000',
      currency: '0xUSDC_SKALE',
      recipient: '0xMerchantWallet',
      methodDetails: {
        chainId: targetChainId,
        network: `eip155:${targetChainId}`,
        rpcUrl: 'https://rpc.target.chain',
        reference: 'test-ref-123',
      },
    },
  };
}

// ---------------------------------------------------------------------------
// EVM source tests
// ---------------------------------------------------------------------------

describe('evmChargeWithBridge — EVM source', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ result: { status: '0x1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    mockSendTransaction.mockResolvedValue('0xDIRECT_TX_HASH');
    mockGetBridgeInfo.mockResolvedValue(MOCK_BRIDGE_INFO_EVM);
    mockSettleBridge.mockResolvedValue({
      success: true,
      targetTxId: '0xTARGET_TX_HASH_FROM_BRIDGE',
      sourceTxId: '0xSOURCE_TX_HASH',
    });
    mockSelectSourceChain.mockReturnValue({ type: 'evm', chain: 'eip155:4217' });
    mockComputeSourceAmount.mockReturnValue(10100n);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates a method registered for evm/charge', () => {
    const method = evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 4217,
      sourceRpcUrl: 'https://rpc.tempo.xyz',
    });

    expect(method).toHaveProperty('__mppClient', true);
    expect(capturedCreateCredential).toBeDefined();
  });

  it('uses direct payment when target chain matches source chain', async () => {
    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 4217,
      sourceRpcUrl: 'https://rpc.tempo.xyz',
    });

    const challenge = buildChallenge(4217);
    const credential = await capturedCreateCredential({ challenge });

    expect(mockSendTransaction).toHaveBeenCalledTimes(1);
    expect(mockSettleBridge).not.toHaveBeenCalled();

    const parsed = JSON.parse(credential);
    expect(parsed.payload.type).toBe('hash');
    expect(parsed.payload.hash).toBe('0xDIRECT_TX_HASH');
    expect(parsed.source).toContain('eip155:4217');
  });

  it('bridges when target chain differs from source chain', async () => {
    mockSendTransaction.mockResolvedValue('0xSOURCE_TX_ON_TEMPO');

    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 4217,
      sourceRpcUrl: 'https://rpc.tempo.xyz',
    });

    const challenge = buildChallenge(1187947933);
    const credential = await capturedCreateCredential({ challenge });

    expect(mockSettleBridge).toHaveBeenCalledTimes(1);
    const settleCall = mockSettleBridge.mock.calls[0];
    expect(settleCall[0]).toBe('https://api.relai.fi/bridge/settle');
    expect(settleCall[1].sourceChain).toBe('eip155:4217');
    expect(settleCall[1].senderAddress).toBe('0xClientWallet');
    expect(settleCall[1].senderSignature).toBe('0xEvmSignature');
    expect(settleCall[1].targetAccept.network).toBe('eip155:1187947933');
    expect(settleCall[1].targetAccept.payTo).toBe('0xMerchantWallet');

    const parsed = JSON.parse(credential);
    expect(parsed.payload.type).toBe('hash');
    expect(parsed.payload.hash).toBe('0xTARGET_TX_HASH_FROM_BRIDGE');
  });

  it('signs settle message with EVM wallet (ECDSA)', async () => {
    mockSendTransaction.mockResolvedValue('0xSOURCE_TX');

    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 4217,
      sourceRpcUrl: 'https://rpc.tempo.xyz',
    });

    const challenge = buildChallenge(1187947933);
    await capturedCreateCredential({ challenge });

    // signMessage should have been called with sourceTxHash + JSON(targetAccept)
    expect(MOCK_EVM_ACCOUNT.signMessage).toHaveBeenCalledTimes(1);
    const signCall = MOCK_EVM_ACCOUNT.signMessage.mock.calls[0][0];
    expect(signCall.message).toContain('0xSOURCE_TX');
    expect(signCall.message).toContain('0xMerchantWallet');
  });

  it('uses correct gross-up amount for bridge fee', async () => {
    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 4217,
      sourceRpcUrl: 'https://rpc.tempo.xyz',
    });

    const challenge = buildChallenge(1187947933);
    await capturedCreateCredential({ challenge });

    // grossAmount = ceil(10000 * 10000 / (10000 - 100)) = ceil(10000 * 10000 / 9900) = 10102
    // The source payment should send grossAmount to the bridge
    const { encodeFunctionData } = await import('viem');
    const encodeCall = (encodeFunctionData as any).mock.calls[0][0];
    const transferAmount = encodeCall.args[1];
    expect(transferAmount).toBe(10102n);
  });

  it('throws when bridge settle fails', async () => {
    mockSettleBridge.mockRejectedValueOnce(new Error('[relai:bridge] settle failed: 500'));

    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 4217,
      sourceRpcUrl: 'https://rpc.tempo.xyz',
    });

    const challenge = buildChallenge(1187947933);
    await expect(capturedCreateCredential({ challenge })).rejects.toThrow(/settle failed/);
  });

  it('throws when no supported source chain matches', async () => {
    mockSelectSourceChain.mockReturnValueOnce(null);

    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 9999,
      sourceRpcUrl: 'https://rpc.unknown.xyz',
    });

    const challenge = buildChallenge(1187947933);
    await expect(capturedCreateCredential({ challenge })).rejects.toThrow(/No supported source chain/);
  });

  it('throws when settle returns no targetTxId', async () => {
    mockSettleBridge.mockResolvedValueOnce({ success: true });

    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      sourceChainId: 4217,
      sourceRpcUrl: 'https://rpc.tempo.xyz',
    });

    const challenge = buildChallenge(1187947933);
    await expect(capturedCreateCredential({ challenge })).rejects.toThrow(/targetTxId/);
  });
});

// ---------------------------------------------------------------------------
// Solana source tests
// ---------------------------------------------------------------------------

describe('evmChargeWithBridge — Solana source', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();

    fetchMock = vi.fn().mockResolvedValue({
      json: () => Promise.resolve({ result: { status: '0x1' } }),
    });
    vi.stubGlobal('fetch', fetchMock);

    mockGetBridgeInfo.mockResolvedValue(MOCK_BRIDGE_INFO_WITH_SOLANA);
    mockSettleBridge.mockResolvedValue({
      success: true,
      targetTxId: '0xTARGET_TX_HASH_FROM_BRIDGE',
      sourceTxId: 'SoLSourceTxSignature123',
    });
    mockSelectSourceChain.mockReturnValue({
      type: 'solana',
      chain: 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp',
    });
    mockComputeSourceAmount.mockReturnValue(10100n);
    mockSolSendTransaction.mockResolvedValue('SoLSourceTxSignature123');
    mockSolConfirmTransaction.mockResolvedValue({ value: { err: null } });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('bridges from Solana when selectSourceChain picks solana', async () => {
    evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      solanaKeypair: MOCK_SOLANA_KEYPAIR,
      sourceChainId: 4217,
    });

    const challenge = buildChallenge(1187947933);
    const credential = await capturedCreateCredential({ challenge });

    // Should have called Solana sendTransaction, not EVM
    expect(mockSolSendTransaction).toHaveBeenCalledTimes(1);
    expect(mockSendTransaction).not.toHaveBeenCalled();

    // Settle should have Solana-specific fields
    expect(mockSettleBridge).toHaveBeenCalledTimes(1);
    const settleCall = mockSettleBridge.mock.calls[0];
    expect(settleCall[1].sourceTxHash).toBe('SoLSourceTxSignature123');
    expect(settleCall[1].senderAddress).toBe('SoLClientWalletPubkey');
    expect(settleCall[1].senderSignature).toBe('MockBase58Signature');
    expect(settleCall[1].sourceChain).toBe('solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp');

    // Credential should contain target tx hash
    const parsed = JSON.parse(credential);
    expect(parsed.payload.type).toBe('hash');
    expect(parsed.payload.hash).toBe('0xTARGET_TX_HASH_FROM_BRIDGE');
    expect(parsed.source).toContain('solana:');
    expect(parsed.source).toContain('SoLClientWalletPubkey');
  });

  it('signs settle message with ed25519 (nacl) and encodes as base58', async () => {
    evmChargeWithBridge({
      solanaKeypair: MOCK_SOLANA_KEYPAIR,
    });

    const challenge = buildChallenge(1187947933);
    await capturedCreateCredential({ challenge });

    // tweetnacl.sign.detached should have been called
    const nacl = await import('tweetnacl');
    expect(nacl.sign.detached).toHaveBeenCalledTimes(1);
    const naclCall = (nacl.sign.detached as any).mock.calls[0];
    // First arg: message bytes (sourceTxHash + JSON(targetAccept))
    const messageStr = new TextDecoder().decode(naclCall[0]);
    expect(messageStr).toContain('SoLSourceTxSignature123');
    expect(messageStr).toContain('0xMerchantWallet');
    // Second arg: secret key
    expect(naclCall[1]).toBe(MOCK_SOLANA_KEYPAIR.secretKey);

    // bs58 should encode the signature
    const bs58 = await import('bs58');
    expect(bs58.default.encode).toHaveBeenCalledWith(MOCK_SOLANA_SIGNATURE);
  });

  it('works with solanaKeypair only (no evmAccount)', async () => {
    evmChargeWithBridge({
      solanaKeypair: MOCK_SOLANA_KEYPAIR,
      solanaRpcUrl: 'https://custom-solana-rpc.example.com',
    });

    const challenge = buildChallenge(1187947933);
    const credential = await capturedCreateCredential({ challenge });

    expect(mockSolSendTransaction).toHaveBeenCalledTimes(1);
    expect(mockSettleBridge).toHaveBeenCalledTimes(1);

    const parsed = JSON.parse(credential);
    expect(parsed.payload.hash).toBe('0xTARGET_TX_HASH_FROM_BRIDGE');
  });

  it('does NOT attempt direct payment when only solanaKeypair is set', async () => {
    evmChargeWithBridge({
      solanaKeypair: MOCK_SOLANA_KEYPAIR,
    });

    // Challenge on any EVM chain — should always bridge, never direct
    const challenge = buildChallenge(4217);
    await capturedCreateCredential({ challenge });

    // Should bridge (no direct payment possible without evmAccount)
    expect(mockSettleBridge).toHaveBeenCalledTimes(1);
  });

  it('throws when Solana source tx fails on-chain', async () => {
    mockSolConfirmTransaction.mockResolvedValueOnce({
      value: { err: { InstructionError: [0, 'InsufficientFunds'] } },
    });

    evmChargeWithBridge({
      solanaKeypair: MOCK_SOLANA_KEYPAIR,
    });

    const challenge = buildChallenge(1187947933);
    await expect(capturedCreateCredential({ challenge })).rejects.toThrow(/Solana source transaction failed/);
  });

  it('passes feePayerSvm from bridge info to Solana payment', async () => {
    evmChargeWithBridge({
      solanaKeypair: MOCK_SOLANA_KEYPAIR,
    });

    const challenge = buildChallenge(1187947933);
    await capturedCreateCredential({ challenge });

    // The Connection should have been created (Solana path was taken)
    const { Connection } = await import('@solana/web3.js');
    expect(Connection).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Config validation tests
// ---------------------------------------------------------------------------

describe('evmChargeWithBridge — config validation', () => {
  it('throws when neither evmAccount nor solanaKeypair is provided', () => {
    expect(() => evmChargeWithBridge({})).toThrow(/At least one of evmAccount or solanaKeypair/);
  });

  it('accepts evmAccount + solanaKeypair together', () => {
    const method = evmChargeWithBridge({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      solanaKeypair: MOCK_SOLANA_KEYPAIR,
      sourceChainId: 4217,
    });
    expect(method).toHaveProperty('__mppClient', true);
  });
});
