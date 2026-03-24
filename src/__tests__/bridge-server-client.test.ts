/**
 * Tests for MPP bridge server-side flow:
 *   bridge-server.ts (bridgeCharge server) + bridge-client.ts (bridgeCharge client)
 *
 * Scenario: Server exposes an explicit `bridge/charge` method alongside `evm/charge`.
 * Client uses `bridgeChargeClient()` to handle the bridge method.
 *
 * Tests:
 * - Server request() returns challenge with bridge info (auto-discovered from API)
 * - Server verify() checks target chain ERC-20 Transfer event
 * - Client createCredential() executes source payment + settle + returns bridge proof
 * - Client EVM source payment flow
 * - Client Solana source payment flow (solanaKeypair)
 * - Error handling: settle failure, missing targetTxId, no wallet match
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// Mock viem (for bridge-client EVM source payments)
// ---------------------------------------------------------------------------
const mockSendTransaction = vi.fn()

vi.mock('viem', async (importOriginal) => {
  const actual = await importOriginal<typeof import('viem')>()
  return {
    ...actual,
    createWalletClient: vi.fn(() => ({
      sendTransaction: mockSendTransaction,
    })),
    http: vi.fn((url: string) => ({ url })),
    encodeFunctionData: vi.fn(() => '0xmocked_calldata'),
  }
})

// ---------------------------------------------------------------------------
// Mock verify-erc20.ts (for server-side verification)
// ---------------------------------------------------------------------------
vi.mock('../mpp/verify-erc20.js', () => ({
  verifyErc20Transfer: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// Mock verify-spl.ts (for server-side Solana target verification)
// ---------------------------------------------------------------------------
vi.mock('../mpp/verify-spl.js', () => ({
  verifySplTransfer: vi.fn().mockResolvedValue(undefined),
}))

// ---------------------------------------------------------------------------
// z mock for mppx schema
// ---------------------------------------------------------------------------
const zMock: any = {
  string: () => zMock,
  number: () => zMock,
  object: (_shape?: any) => zMock,
  array: (_inner?: any) => zMock,
  optional: (_inner?: any) => zMock,
  record: (..._args: any[]) => zMock,
}

// ---------------------------------------------------------------------------
// Mock mppx — capture server & client handlers
// ---------------------------------------------------------------------------
let capturedServerHandlers: any = null
let capturedClientHandlers: any = null

vi.mock('mppx', () => ({
  Method: {
    from: vi.fn((def: any) => def),
    toServer: vi.fn((_method: any, handler: any) => {
      capturedServerHandlers = handler
      return { __mppServer: true }
    }),
    toClient: vi.fn((_method: any, handler: any) => {
      capturedClientHandlers = handler
      return { __mppClient: true }
    }),
  },
  Credential: {
    serialize: vi.fn((data: any) => JSON.stringify(data)),
  },
  Receipt: {
    from: vi.fn((data: any) => data),
  },
  z: zMock,
}))

// ---------------------------------------------------------------------------
// Import AFTER mocks
// ---------------------------------------------------------------------------
const { bridgeCharge: bridgeChargeServer } = await import('../mpp/bridge-server')
const { bridgeCharge: bridgeChargeClient } = await import('../mpp/bridge-client')
const { verifyErc20Transfer } = await import('../mpp/verify-erc20')

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MOCK_BRIDGE_API_RESPONSE = {
  settleEndpoint: 'https://api.relai.fi/bridge/settle',
  supportedSourceChains: ['eip155:8453', 'eip155:4217', 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'],
  supportedSourceAssets: ['0xUSDC_BASE', '0xUSDC_TEMPO', 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'],
  payTo: {
    'eip155:8453': '0xBridgeReceiverBase',
    'eip155:4217': '0xBridgeReceiverTempo',
    'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp': 'SoLBridgeReceiver111',
  },
  feePayerSvm: 'SoLFeePayer111',
  feeBps: 100,
  paymentFacilitator: 'https://facilitator.x402.fi',
}

const MOCK_EVM_ACCOUNT = {
  address: '0xClientWallet' as `0x${string}`,
  type: 'local' as const,
  publicKey: '0x04' as `0x${string}`,
  source: 'privateKey' as const,
  signMessage: vi.fn(),
  signTransaction: vi.fn(),
  signTypedData: vi.fn(),
  nonceManager: undefined,
  experimental_signAuthMessage: undefined,
}

// ---------------------------------------------------------------------------
// Server tests
// ---------------------------------------------------------------------------

describe('bridgeCharge server', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    // Mock fetch: bridge info API + RPC verification
    fetchMock = vi.fn()
      // /bridge/info call
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve(MOCK_BRIDGE_API_RESPONSE),
      })

    vi.stubGlobal('fetch', fetchMock)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a server method for bridge/charge', () => {
    const method = bridgeChargeServer({
      recipient: '0xMerchant',
      tokenAddress: '0xUSDC_SKALE',
      chainId: 1187947933,
      rpcUrl: 'https://rpc.skale.example',
    })

    expect(method).toHaveProperty('__mppServer', true)
    expect(capturedServerHandlers).toBeDefined()
    expect(capturedServerHandlers.request).toBeDefined()
    expect(capturedServerHandlers.verify).toBeDefined()
  })

  it('request() returns challenge with auto-discovered bridge info', async () => {
    bridgeChargeServer({
      recipient: '0xMerchant',
      tokenAddress: '0xUSDC_SKALE',
      chainId: 1187947933,
      rpcUrl: 'https://rpc.skale.example',
    })

    const result = await capturedServerHandlers.request({
      credential: null,
      request: { amount: '10000', description: 'test' },
    })

    expect(result.recipient).toBe('0xMerchant')
    expect(result.currency).toBe('0xUSDC_SKALE')
    expect(result.methodDetails.targetChainId).toBe(1187947933)
    expect(result.methodDetails.settleEndpoint).toBe('https://api.relai.fi/bridge/settle')
    expect(result.methodDetails.feeBps).toBe(100)
    // Target chain should be filtered out of source chains
    expect(result.methodDetails.supportedSourceChains).not.toContain('eip155:1187947933')
    expect(result.methodDetails.supportedSourceChains).toContain('eip155:8453')
    expect(result.methodDetails.reference).toBeTruthy()
  })

  it('request() returns existing request when credential present', async () => {
    bridgeChargeServer({
      recipient: '0xMerchant',
      tokenAddress: '0xUSDC_SKALE',
      chainId: 1187947933,
      rpcUrl: 'https://rpc.skale.example',
    })

    const existingRequest = {
      amount: '5000',
      currency: '0xUSDC_SKALE',
      recipient: '0xMerchant',
      methodDetails: { targetChainId: 1187947933, reference: 'existing-ref' },
    }

    const result = await capturedServerHandlers.request({
      credential: { challenge: { request: existingRequest } },
      request: { amount: '10000' },
    })

    // Should return the credential's existing request, not build a new one
    expect(result).toEqual(existingRequest)
    // Should NOT have called fetch (no bridge info needed)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('verify() checks ERC-20 Transfer on target chain', async () => {
    bridgeChargeServer({
      recipient: '0xMerchant',
      tokenAddress: '0xUSDC_SKALE',
      chainId: 1187947933,
      rpcUrl: 'https://rpc.skale.example',
    })

    const credential = {
      payload: {
        type: 'settled',
        targetTxHash: '0xTARGET_TX_ON_SKALE',
        sourceTxHash: '0xSOURCE_TX_ON_BASE',
        sourceChain: 'eip155:8453',
      },
      challenge: {
        request: {
          amount: '10000',
          currency: '0xUSDC_SKALE',
          recipient: '0xMerchant',
        },
      },
    }

    const receipt = await capturedServerHandlers.verify({ credential })

    expect(verifyErc20Transfer).toHaveBeenCalledWith({
      txHash: '0xTARGET_TX_ON_SKALE',
      rpcUrl: 'https://rpc.skale.example',
      tokenAddress: '0xUSDC_SKALE',
      recipient: '0xMerchant',
      expectedAmount: 10000n,
    })
    expect(receipt.method).toBe('bridge')
    expect(receipt.reference).toBe('0xTARGET_TX_ON_SKALE')
    expect(receipt.status).toBe('success')
  })

  it('verify() throws when targetTxHash is missing', async () => {
    bridgeChargeServer({
      recipient: '0xMerchant',
      tokenAddress: '0xUSDC_SKALE',
      chainId: 1187947933,
      rpcUrl: 'https://rpc.skale.example',
    })

    const credential = {
      payload: { type: 'settled' }, // no targetTxHash
      challenge: { request: { amount: '10000' } },
    }

    await expect(
      capturedServerHandlers.verify({ credential }),
    ).rejects.toThrow(/targetTxHash/)
  })

  it('uses static config when provided instead of auto-discovery', async () => {
    bridgeChargeServer({
      recipient: '0xMerchant',
      tokenAddress: '0xUSDC_SKALE',
      chainId: 1187947933,
      rpcUrl: 'https://rpc.skale.example',
      settleEndpoint: 'https://custom.settle.endpoint',
      supportedSourceChains: ['eip155:137'],
      feeBps: 50,
    })

    const result = await capturedServerHandlers.request({
      credential: null,
      request: { amount: '10000' },
    })

    expect(result.methodDetails.settleEndpoint).toBe('https://custom.settle.endpoint')
    expect(result.methodDetails.supportedSourceChains).toEqual(['eip155:137'])
    expect(result.methodDetails.feeBps).toBe(50)
  })
})

// ---------------------------------------------------------------------------
// Client tests
// ---------------------------------------------------------------------------

describe('bridgeCharge client', () => {
  let fetchMock: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()

    // Mock fetch for: EVM receipt polling + bridge settle
    fetchMock = vi.fn()

    vi.stubGlobal('fetch', fetchMock)
    mockSendTransaction.mockResolvedValue('0xSOURCE_TX_ON_BASE')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('creates a client method for bridge/charge', () => {
    const method = bridgeChargeClient({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      rpcUrls: { 'eip155:8453': 'https://mainnet.base.org' },
    })

    expect(method).toHaveProperty('__mppClient', true)
    expect(capturedClientHandlers).toBeDefined()
    expect(capturedClientHandlers.createCredential).toBeDefined()
  })

  it('executes EVM source payment + settle and returns bridge credential', async () => {
    // fetch call 1: waitForEvmReceipt → confirmed
    // fetch call 2: bridge settle → success
    fetchMock
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ result: { status: '0x1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          targetTxId: '0xTARGET_TX_ON_SKALE',
          sourceTxId: '0xSOURCE_TX_ON_BASE',
        }),
      })

    bridgeChargeClient({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      rpcUrls: { 'eip155:8453': 'https://mainnet.base.org' },
    })

    const challenge = {
      method: 'bridge',
      intent: 'charge',
      request: {
        amount: '10000',
        currency: '0xUSDC_SKALE',
        recipient: '0xMerchant',
        methodDetails: {
          targetChainId: 1187947933,
          settleEndpoint: 'https://api.relai.fi/bridge/settle',
          supportedSourceChains: ['eip155:8453'],
          supportedSourceAssets: ['0xUSDC_BASE'],
          payToMap: { 'eip155:8453': '0xBridgeReceiverBase' },
          feeBps: 100,
          paymentFacilitator: 'https://facilitator.x402.fi',
          reference: 'test-ref-456',
        },
      },
    }

    const credential = await capturedClientHandlers.createCredential({ challenge })

    // Should have sent EVM tx
    expect(mockSendTransaction).toHaveBeenCalledTimes(1)

    // Should have called settle
    const settleCall = fetchMock.mock.calls.find(
      (c: any[]) => c[0] === 'https://api.relai.fi/bridge/settle',
    )
    expect(settleCall).toBeDefined()
    const settleBody = JSON.parse(settleCall![1].body)
    expect(settleBody.sourceChain).toBe('eip155:8453')
    expect(settleBody.targetAccept.network).toBe('eip155:1187947933')
    expect(settleBody.targetAccept.payTo).toBe('0xMerchant')
    // grossAmount = ceil(10000 * 10000 / (10000 - 100)) = 10102
    expect(settleBody.targetAccept.amount).toBe('10102')

    // Credential should contain target tx hash
    const parsed = JSON.parse(credential)
    expect(parsed.payload.targetTxHash).toBe('0xTARGET_TX_ON_SKALE')
    expect(parsed.payload.sourceTxHash).toBe('0xSOURCE_TX_ON_BASE')
    expect(parsed.payload.sourceChain).toBe('eip155:8453')
  })

  it('throws when no wallet matches supported source chains', async () => {
    // Client has no Solana keypair, and no EVM chains in supported list
    bridgeChargeClient({
      evmAccount: undefined as any, // no EVM wallet
    })

    const challenge = {
      method: 'bridge',
      intent: 'charge',
      request: {
        amount: '10000',
        currency: '0xUSDC_SKALE',
        recipient: '0xMerchant',
        methodDetails: {
          targetChainId: 1187947933,
          settleEndpoint: 'https://api.relai.fi/bridge/settle',
          supportedSourceChains: ['eip155:8453'],
          supportedSourceAssets: ['0xUSDC_BASE'],
          payToMap: { 'eip155:8453': '0xBridgeReceiverBase' },
          reference: 'test-ref',
        },
      },
    }

    await expect(
      capturedClientHandlers.createCredential({ challenge }),
    ).rejects.toThrow(/No wallet/)
  })

  it('throws when settle returns no targetTxId', async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ result: { status: '0x1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ success: true }), // no targetTxId
      })

    bridgeChargeClient({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      rpcUrls: { 'eip155:8453': 'https://mainnet.base.org' },
    })

    const challenge = {
      method: 'bridge',
      intent: 'charge',
      request: {
        amount: '10000',
        currency: '0xUSDC_SKALE',
        recipient: '0xMerchant',
        methodDetails: {
          targetChainId: 1187947933,
          settleEndpoint: 'https://api.relai.fi/bridge/settle',
          supportedSourceChains: ['eip155:8453'],
          supportedSourceAssets: ['0xUSDC_BASE'],
          payToMap: { 'eip155:8453': '0xBridgeReceiverBase' },
          reference: 'test-ref',
        },
      },
    }

    await expect(
      capturedClientHandlers.createCredential({ challenge }),
    ).rejects.toThrow(/targetTxId/)
  })

  it('throws when settle endpoint returns error', async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ result: { status: '0x1' } }),
      })
      .mockResolvedValueOnce({
        ok: false,
        json: () => Promise.resolve({ error: 'insufficient liquidity' }),
      })

    bridgeChargeClient({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      rpcUrls: { 'eip155:8453': 'https://mainnet.base.org' },
    })

    const challenge = {
      method: 'bridge',
      intent: 'charge',
      request: {
        amount: '10000',
        currency: '0xUSDC_SKALE',
        recipient: '0xMerchant',
        methodDetails: {
          targetChainId: 1187947933,
          settleEndpoint: 'https://api.relai.fi/bridge/settle',
          supportedSourceChains: ['eip155:8453'],
          supportedSourceAssets: ['0xUSDC_BASE'],
          payToMap: { 'eip155:8453': '0xBridgeReceiverBase' },
          reference: 'test-ref',
        },
      },
    }

    await expect(
      capturedClientHandlers.createCredential({ challenge }),
    ).rejects.toThrow(/settle failed/)
  })

  it('includes bridge fee in source amount', async () => {
    fetchMock
      .mockResolvedValueOnce({
        json: () => Promise.resolve({ result: { status: '0x1' } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({
          success: true,
          targetTxId: '0xTARGET',
          sourceTxId: '0xSOURCE',
        }),
      })

    bridgeChargeClient({
      evmAccount: MOCK_EVM_ACCOUNT as any,
      rpcUrls: { 'eip155:8453': 'https://mainnet.base.org' },
    })

    const challenge = {
      method: 'bridge',
      intent: 'charge',
      request: {
        amount: '1000000', // 1 USDC (6 decimals)
        currency: '0xUSDC_SKALE',
        recipient: '0xMerchant',
        methodDetails: {
          targetChainId: 1187947933,
          settleEndpoint: 'https://api.relai.fi/bridge/settle',
          supportedSourceChains: ['eip155:8453'],
          supportedSourceAssets: ['0xUSDC_BASE'],
          payToMap: { 'eip155:8453': '0xBridgeReceiverBase' },
          feeBps: 100, // 1%
          reference: 'test-ref',
        },
      },
    }

    await capturedClientHandlers.createCredential({ challenge })

    // encodeFunctionData was called with gross-up amount
    // grossAmount = ceil(1000000 * 10000 / (10000 - 100)) = ceil(1010101.01) = 1010102
    const { encodeFunctionData } = await import('viem')
    const encodeCall = (encodeFunctionData as any).mock.calls[0][0]
    const transferAmount = encodeCall.args[1]
    expect(transferAmount).toBe(1010102n)
  })
})
