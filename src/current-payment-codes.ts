import { ethers } from 'ethers'
import bs58 from 'bs58'
import {
  NETWORK_CONFIGS,
  type PaymentCodeConfig,
  type PaymentCodeNetwork,
  type PaymentCodeSigner,
} from './payment-codes.js'
import { getPayRequest, type PaymentRequestConfig } from './payment-requests.js'
import {
  cancelSolanaPaymentCode,
  generateSolanaPaymentCode,
  generateSolanaPaymentCodesBatch,
  type GenerateSolanaPaymentCodeBatchItem,
  type SolanaCodeCancelResult,
  type SolanaClaimLink,
  type SolanaPaymentCodeBatchResult,
  type SolanaPaymentCode,
} from './solana-payment-codes.js'

const DEFAULT_FACILITATOR = 'https://relai.fi/facilitator'
const TRANSFER_WITH_AUTHORIZATION_DOMAIN_VERSION = '2'
const AUTHORIZATION_WINDOW_SECONDS = 3600
const EVM_ESCROW_ABI = ['function cancel(bytes8 code) external']
const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const

export type CurrentPaymentCodeNetwork = PaymentCodeNetwork | 'solana' | 'solana-devnet'
export type OwnerWalletType = 'evm' | 'solana'

export interface EvmCurrentPaymentCodeSigner extends PaymentCodeSigner {
  signMessage(message: string): Promise<string>
  sendTransaction?(tx: { to: string; data: string }): Promise<{ hash: string; wait(): Promise<unknown> }>
}

export interface SolanaCurrentPaymentCodeWallet {
  publicKey: { toString(): string } | null
  signTransaction<T>(transaction: T): Promise<T>
  signMessage?(message: Uint8Array): Promise<Uint8Array>
}

export interface CreatePaymentCodeParamsBase {
  amount: number | bigint
  ttlSeconds?: number
  description?: string
  claimLink?: boolean
}

export interface CreateEvmPaymentCodeParams extends CreatePaymentCodeParamsBase {
  signer: PaymentCodeSigner
  network?: PaymentCodeNetwork
  payee?: string
  usdcContract?: string
}

export interface CreateSolanaPaymentCodeParams extends CreatePaymentCodeParamsBase {
  network: 'solana' | 'solana-devnet'
  wallet: SolanaCurrentPaymentCodeWallet
}

export type CreatePaymentCodeParams = CreateEvmPaymentCodeParams | CreateSolanaPaymentCodeParams

export interface CreatePaymentCodesBatchItem {
  amount: number | bigint
  ttlSeconds?: number
  description?: string
}

export interface CreateEvmPaymentCodesBatchParams {
  signer: PaymentCodeSigner
  network?: PaymentCodeNetwork
  payee?: string
  usdcContract?: string
  codes: CreatePaymentCodesBatchItem[]
}

export interface CreateSolanaPaymentCodesBatchParams {
  network: 'solana' | 'solana-devnet'
  wallet: SolanaCurrentPaymentCodeWallet
  codes: CreatePaymentCodesBatchItem[]
}

export type CreatePaymentCodesBatchParams = CreateEvmPaymentCodesBatchParams | CreateSolanaPaymentCodesBatchParams

export interface ListOwnerPaymentCodesParamsEvm {
  walletType: 'evm'
  wallet: EvmCurrentPaymentCodeSigner
}

export interface ListOwnerPaymentCodesParamsSolana {
  walletType: 'solana'
  wallet: SolanaCurrentPaymentCodeWallet & { signMessage(message: Uint8Array): Promise<Uint8Array> }
}

export type ListOwnerPaymentCodesParams = ListOwnerPaymentCodesParamsEvm | ListOwnerPaymentCodesParamsSolana

export interface RedeemStoredPaymentCodeParams {
  payee: string
  evmNetwork?: PaymentCodeNetwork
  solanaNetwork?: 'solana' | 'solana-devnet'
}

export interface CancelStoredPaymentCodeParams {
  wallet?: EvmCurrentPaymentCodeSigner
  solanaWallet?: SolanaCurrentPaymentCodeWallet
  network?: CurrentPaymentCodeNetwork
}

export type ClaimPaymentLinkMode = 'claim-usdc' | 'claim-code'

export interface ClaimPaymentLinkParamsBase {
  mode?: ClaimPaymentLinkMode
  payee?: string
  evmNetwork?: PaymentCodeNetwork
  solanaNetwork?: 'solana' | 'solana-devnet'
}

export interface ClaimPaymentLinkParamsEvm extends ClaimPaymentLinkParamsBase {
  wallet: EvmCurrentPaymentCodeSigner
  solanaWallet?: never
}

export interface ClaimPaymentLinkParamsSolana extends ClaimPaymentLinkParamsBase {
  wallet?: never
  solanaWallet: SolanaCurrentPaymentCodeWallet & { signMessage(message: Uint8Array): Promise<Uint8Array> }
}

export type ClaimPaymentLinkParams = ClaimPaymentLinkParamsEvm | ClaimPaymentLinkParamsSolana

export interface PayPayRequestWithStoredCodeOptions {
  allowOverpayment?: boolean
  returnChange?: 'code' | 'wallet'
  changeAddress?: string
}

export type CurrentPaymentCodeResponse = Record<string, unknown> | SolanaPaymentCode | SolanaClaimLink
export type OwnerPaymentCodesResponse = Record<string, unknown>
export type PaymentCodeDetailsResponse = Record<string, unknown>
export type RedeemStoredPaymentCodeResponse = Record<string, unknown>
export type CancelStoredPaymentCodeResponse = Record<string, unknown> | SolanaCodeCancelResult
export type ClaimPaymentLinkResponse = Record<string, unknown>
export type PayPayRequestWithStoredCodeResponse = Record<string, unknown>
export type PaymentCodesBatchResponse = Record<string, unknown> | SolanaPaymentCodeBatchResult

type StoredPaymentCodeKind = 'evm' | 'solana'

function isEvmAddress(value: string): boolean {
  return /^0x[0-9a-fA-F]{40}$/i.test(value)
}

function codeToBytes8(code: string): `0x${string}` {
  const normalized = code.trim().toUpperCase()
  const bytes = ethers.toUtf8Bytes(normalized)
  if (bytes.length !== 8) throw new Error('Payment code must be exactly 8 characters long')
  return ethers.hexlify(bytes) as `0x${string}`
}

function randomBytes32(): `0x${string}` {
  const bytes = new Uint8Array(32)
  if (typeof globalThis.crypto !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes)
  } else {
    const { randomBytes } = require('crypto') as typeof import('crypto')
    randomBytes(32).copy(Buffer.from(bytes.buffer))
  }
  return `0x${Array.from(bytes).map((byte) => byte.toString(16).padStart(2, '0')).join('')}` as `0x${string}`
}

function extractClaimToken(claimUrlOrToken: string): string {
  const normalized = claimUrlOrToken.trim()
  if (!normalized) throw new Error('Claim URL or claim token is required')

  const directValue = normalized.split('?')[0]?.split('#')[0]?.trim() ?? ''
  if (!directValue.includes('/')) return directValue

  try {
    const url = new URL(normalized)
    const segments = url.pathname.split('/').filter(Boolean)
    return segments[segments.length - 1] ?? ''
  } catch {
    const segments = directValue.split('/').filter(Boolean)
    return segments[segments.length - 1] ?? ''
  }
}

function buildClaimUrl(facilitatorUrl: string, claimToken: string | null): string | null {
  if (!claimToken) return null
  const origin = new URL(facilitatorUrl).origin
  return new URL(`/claim/${claimToken}`, origin).toString()
}

function buildCancelAuthorizationMessage(code: string, owner: string, issuedAt: number): string {
  return [
    'RelAI Codes',
    'Authorize payment code cancellation',
    `Code: ${code.trim().toUpperCase()}`,
    `Owner: ${owner.toLowerCase()}`,
    `Issued At: ${issuedAt}`,
  ].join('\n')
}

function buildClaimLinkCancelAuthorizationMessage(claimToken: string, owner: string, issuedAt: number): string {
  return [
    'RelAI Codes',
    'Authorize claim link cancellation',
    `Claim Token: ${claimToken}`,
    `Owner: ${owner.toLowerCase()}`,
    `Issued At: ${issuedAt}`,
  ].join('\n')
}

function buildEvmClaimLinkAuthorizationMessage(params: {
  claimToken: string
  claimer: string
  issuedAt: number
  mode: ClaimPaymentLinkMode
  targetAddress: string | null
  targetNetwork: string | null
}): string {
  return [
    'RelAI EVM Claim Link',
    `Claim Token: ${params.claimToken}`,
    `Claimer: ${params.claimer.toLowerCase()}`,
    `Mode: ${params.mode}`,
    `Target Address: ${params.targetAddress ?? '-'}`,
    `Target Network: ${params.targetNetwork ?? '-'}`,
    `Issued At: ${params.issuedAt}`,
  ].join('\n')
}

function buildSolanaClaimLinkAuthorizationMessage(params: {
  claimToken: string
  claimer: string
  issuedAt: number
  mode: ClaimPaymentLinkMode
  targetAddress: string | null
  targetNetwork: string | null
}): string {
  return [
    'RelAI Solana Claim Link',
    `Claim Token: ${params.claimToken}`,
    `Claimer: ${params.claimer}`,
    `Mode: ${params.mode}`,
    `Target Address: ${params.targetAddress ?? '-'}`,
    `Target Network: ${params.targetNetwork ?? '-'}`,
    `Issued At: ${params.issuedAt}`,
  ].join('\n')
}

async function readJson(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>
}

async function fetchWithPayload(url: string, init?: RequestInit): Promise<{ response: Response; payload: Record<string, unknown> }> {
  const response = await fetch(url, init)
  const payload = await readJson(response)
  return { response, payload }
}

function buildRequestError(response: Response, payload: Record<string, unknown>): Error {
  return new Error(String(payload.error || payload.detail || payload.message || `Request failed (${response.status})`))
}

function isNotFoundResponse(response: Response, payload: Record<string, unknown>): boolean {
  return response.status === 404 || payload.errorCode === 'not_found'
}

async function fetchStoredCodeWithFallback(
  facilitatorUrl: string,
  normalizedCode: string,
  options: {
    suffix?: string
    init?: RequestInit
  } = {},
): Promise<{ kind: StoredPaymentCodeKind; payload: Record<string, unknown> }> {
  const suffix = options.suffix ? `/${options.suffix.replace(/^\/+/, '')}` : ''
  const attempts: Array<{ kind: StoredPaymentCodeKind; url: string }> = [
    { kind: 'evm', url: `${facilitatorUrl}/payment-codes/${normalizedCode}${suffix}` },
    { kind: 'solana', url: `${facilitatorUrl}/solana-payment-codes/${normalizedCode}${suffix}` },
  ]

  let lastError: Error | null = null

  for (const attempt of attempts) {
    const { response, payload } = await fetchWithPayload(attempt.url, options.init)
    if (response.ok) {
      return { kind: attempt.kind, payload }
    }
    if (!isNotFoundResponse(response, payload)) {
      throw buildRequestError(response, payload)
    }
    lastError = buildRequestError(response, payload)
  }

  throw lastError ?? new Error('Payment code not found')
}

async function fetchOrThrow(url: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const { response, payload } = await fetchWithPayload(url, init)
  if (!response.ok) {
    throw buildRequestError(response, payload)
  }
  return payload
}

function sanitizeClaimLinkResponse(payload: Record<string, unknown>, facilitatorUrl: string, fallbackClaimToken?: string): Record<string, unknown> {
  const claimToken = typeof payload.claimToken === 'string' ? payload.claimToken : (fallbackClaimToken ?? null)
  const sanitized = { ...payload }
  delete sanitized.claimToken
  delete sanitized.id
  return {
    ...sanitized,
    claimUrl: buildClaimUrl(facilitatorUrl, claimToken),
  }
}

export async function createPaymentCode(
  config: PaymentCodeConfig,
  params: CreatePaymentCodeParams,
): Promise<CurrentPaymentCodeResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR
  const ttlSeconds = Math.max(60, Math.round(Number(params.ttlSeconds ?? 86400)))

  if ('wallet' in params) {
    const amount = BigInt(params.amount)
    if (amount <= 0n) throw new Error('amount must be positive')
    return generateSolanaPaymentCode(config, params.wallet, {
      amount,
      network: params.network,
      claimLink: params.claimLink === true,
      description: params.description,
      ttlSeconds,
    })
  }

  const network = params.network ?? 'base-sepolia'
  const net = NETWORK_CONFIGS[network]
  if (!net) throw new Error(`Unsupported network: ${network}`)

  const amount = BigInt(params.amount)
  if (amount <= 0n) throw new Error('amount must be positive')

  const relayerConfig = await fetchOrThrow(`${facilitatorUrl}/payment-codes/relayer-address`)
  const escrowAddresses = (relayerConfig.escrowAddresses ?? {}) as Record<string, string | null | undefined>
  const escrowAddress = escrowAddresses[network]
  if (!escrowAddress) throw new Error(`EVM escrow is not configured for ${network}`)

  const from = await params.signer.getAddress()
  const now = Math.floor(Date.now() / 1000)
  const validBefore = now + ttlSeconds
  const authorizationValidBefore = String(Math.min(validBefore, now + AUTHORIZATION_WINDOW_SECONDS))
  const authorizationNonce = randomBytes32()
  const usdcContract = params.usdcContract ?? net.usdc

  const domain = {
    name: net.domainName,
    version: TRANSFER_WITH_AUTHORIZATION_DOMAIN_VERSION,
    chainId: net.chainId,
    verifyingContract: usdcContract,
  }

  const authorization = {
    from,
    to: escrowAddress,
    value: amount.toString(),
    validAfter: '0',
    validBefore: authorizationValidBefore,
    nonce: authorizationNonce,
  }

  const signature = await params.signer.signTypedData(domain, EIP3009_TYPES, authorization)
  const payload = await fetchOrThrow(`${facilitatorUrl}/payment-codes`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      value: amount.toString(),
      validBefore,
      usdcContract,
      settlementNetwork: network,
      escrowMode: true,
      claimLink: params.claimLink === true,
      ...(params.description ? { description: params.description } : {}),
      ...(params.payee ? { payee: params.payee } : {}),
      signature,
      authorization,
    }),
  })

  return params.claimLink === true
    ? sanitizeClaimLinkResponse(payload, facilitatorUrl)
    : payload
}

export async function createPaymentCodesBatch(
  config: PaymentCodeConfig,
  params: CreatePaymentCodesBatchParams,
): Promise<PaymentCodesBatchResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR

  if (!Array.isArray(params.codes) || params.codes.length === 0) {
    throw new Error('codes must not be empty')
  }

  if ('wallet' in params) {
    const items: GenerateSolanaPaymentCodeBatchItem[] = params.codes.map((item) => ({
      amount: item.amount,
      ttlSeconds: item.ttlSeconds,
      description: item.description,
    }))
    return generateSolanaPaymentCodesBatch(config, params.wallet, {
      network: params.network,
      items,
    })
  }

  const network = params.network ?? 'base-sepolia'
  const net = NETWORK_CONFIGS[network]
  if (!net) throw new Error(`Unsupported network: ${network}`)

  const relayerConfig = await fetchOrThrow(`${facilitatorUrl}/payment-codes/relayer-address`)
  const escrowAddresses = (relayerConfig.escrowAddresses ?? {}) as Record<string, string | null | undefined>
  const escrowAddress = escrowAddresses[network]
  if (!escrowAddress) throw new Error(`EVM escrow is not configured for ${network}`)

  const from = await params.signer.getAddress()
  const now = Math.floor(Date.now() / 1000)
  const usdcContract = params.usdcContract ?? net.usdc
  const normalizedCodes = params.codes.map((item) => {
    const amount = BigInt(item.amount)
    if (amount <= 0n) throw new Error('Each batch code amount must be positive')
    const ttlSeconds = Math.max(60, Math.round(Number(item.ttlSeconds ?? 86400)))
    return {
      value: amount,
      validBefore: now + ttlSeconds,
      description: item.description?.trim() || undefined,
    }
  })
  const totalAmount = normalizedCodes.reduce((sum, item) => sum + item.value, 0n)
  const authorizationValidBefore = String(now + AUTHORIZATION_WINDOW_SECONDS)
  const authorizationNonce = randomBytes32()

  const domain = {
    name: net.domainName,
    version: TRANSFER_WITH_AUTHORIZATION_DOMAIN_VERSION,
    chainId: net.chainId,
    verifyingContract: usdcContract,
  }

  const authorization = {
    from,
    to: escrowAddress,
    value: totalAmount.toString(),
    validAfter: '0',
    validBefore: authorizationValidBefore,
    nonce: authorizationNonce,
  }

  const signature = await params.signer.signTypedData(domain, EIP3009_TYPES, authorization)
  return fetchOrThrow(`${facilitatorUrl}/payment-codes/batch-funded`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from,
      usdcContract,
      settlementNetwork: network,
      ...(params.payee ? { payee: params.payee } : {}),
      signature,
      authorization,
      codes: normalizedCodes.map((item) => ({
        value: item.value.toString(),
        validBefore: item.validBefore,
        ...(item.description ? { description: item.description } : {}),
      })),
    }),
  })
}

export async function listOwnerPaymentCodes(
  config: PaymentCodeConfig,
  params: ListOwnerPaymentCodesParams,
): Promise<OwnerPaymentCodesResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR

  if (params.walletType === 'solana') {
    if (!params.wallet.publicKey) throw new Error('Solana wallet not connected')
    const walletAddress = params.wallet.publicKey.toString()
    const challenge = await fetchOrThrow(`${facilitatorUrl}/payment-codes/owner/challenge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, walletType: 'solana' }),
    })
    const message = typeof challenge.message === 'string' ? challenge.message : ''
    if (!message) throw new Error('Failed to load owner challenge message')
    const signatureBytes = await params.wallet.signMessage(new TextEncoder().encode(message))
    const session = await fetchOrThrow(`${facilitatorUrl}/payment-codes/owner/session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ walletAddress, walletType: 'solana', signature: bs58.encode(signatureBytes) }),
    })
    const accessToken = typeof session.accessToken === 'string' ? session.accessToken : ''
    if (!accessToken) throw new Error('Failed to create owner session')
    return fetchOrThrow(`${facilitatorUrl}/payment-codes/owner/codes`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
  }

  const walletAddress = await params.wallet.getAddress()
  const challenge = await fetchOrThrow(`${facilitatorUrl}/payment-codes/owner/challenge`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress, walletType: 'evm' }),
  })
  const message = typeof challenge.message === 'string' ? challenge.message : ''
  if (!message) throw new Error('Failed to load owner challenge message')

  const session = await fetchOrThrow(`${facilitatorUrl}/payment-codes/owner/session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ walletAddress, walletType: 'evm', signature: await params.wallet.signMessage(message) }),
  })
  const accessToken = typeof session.accessToken === 'string' ? session.accessToken : ''
  if (!accessToken) throw new Error('Failed to create owner session')
  return fetchOrThrow(`${facilitatorUrl}/payment-codes/owner/codes`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  })
}

export async function getPaymentCode(
  config: PaymentCodeConfig,
  code: string,
): Promise<PaymentCodeDetailsResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR
  const normalizedCode = code.trim().toUpperCase()
  const { payload } = await fetchStoredCodeWithFallback(facilitatorUrl, normalizedCode)
  return payload
}

export const getPaymentCodeDetails = getPaymentCode

export async function redeemStoredPaymentCode(
  config: PaymentCodeConfig,
  code: string,
  params: RedeemStoredPaymentCodeParams,
): Promise<RedeemStoredPaymentCodeResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR
  const normalizedCode = code.trim().toUpperCase()
  const { payload } = await fetchStoredCodeWithFallback(facilitatorUrl, normalizedCode, {
    suffix: 'redeem',
    init: {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        payee: params.payee,
        ...(params.evmNetwork ? { evmNetwork: params.evmNetwork } : {}),
        ...(params.solanaNetwork ? { solanaNetwork: params.solanaNetwork } : {}),
      }),
    },
  })
  return payload
}

export async function cancelStoredPaymentCode(
  config: PaymentCodeConfig,
  code: string,
  params: CancelStoredPaymentCodeParams = {},
): Promise<CancelStoredPaymentCodeResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR
  const normalizedCode = code.trim().toUpperCase()

  const statusInfo = await fetchStoredCodeWithFallback(facilitatorUrl, normalizedCode)

  if (statusInfo.kind === 'solana') {
    if (!params.solanaWallet) {
      throw new Error('A Solana wallet is required to cancel this payment code')
    }
    return cancelSolanaPaymentCode(config, normalizedCode, params.solanaWallet, {
      network: (params.network === 'solana' || params.network === 'solana-devnet') ? params.network : undefined,
    })
  }

  if (!params.wallet) {
    throw new Error('An EVM wallet is required to cancel this payment code')
  }

  const status = statusInfo.payload
  const owner = await params.wallet.getAddress()
  const network = params.network ?? String(status.settlementNetwork || 'base-sepolia') as PaymentCodeNetwork

  if (status.claimLink === true && typeof status.claimToken === 'string' && status.escrowMode === true) {
    const issuedAt = Date.now()
    return fetchOrThrow(`${facilitatorUrl}/payment-codes/claim-links/evm/${status.claimToken}/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        owner,
        issuedAt,
        signature: await params.wallet.signMessage(buildClaimLinkCancelAuthorizationMessage(status.claimToken, owner, issuedAt)),
      }),
    })
  }

  if (status.escrowMode === true) {
    if (!params.wallet.sendTransaction) {
      throw new Error('This EVM wallet does not support sendTransaction, which is required for escrow cancellation')
    }
    const relayerConfig = await fetchOrThrow(`${facilitatorUrl}/payment-codes/relayer-address`)
    const escrowAddresses = (relayerConfig.escrowAddresses ?? {}) as Record<string, string | null | undefined>
    const escrowAddress = escrowAddresses[network]
    if (!escrowAddress) throw new Error(`EVM escrow is not configured for ${network}`)
    const cancelInterface = new ethers.Interface(EVM_ESCROW_ABI)
    const tx = await params.wallet.sendTransaction({
      to: escrowAddress,
      data: cancelInterface.encodeFunctionData('cancel', [codeToBytes8(normalizedCode)]),
    })
    await tx.wait()
    return {
      success: true,
      code: normalizedCode,
      cancelTxHash: tx.hash,
      network,
    }
  }

  const issuedAt = Date.now()
  return fetchOrThrow(`${facilitatorUrl}/payment-codes/${normalizedCode}/cancel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      owner,
      issuedAt,
      signature: await params.wallet.signMessage(buildCancelAuthorizationMessage(normalizedCode, owner, issuedAt)),
    }),
  })
}

export async function claimPaymentLink(
  config: PaymentCodeConfig,
  claimUrlOrToken: string,
  params: ClaimPaymentLinkParams,
): Promise<ClaimPaymentLinkResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR
  const claimToken = extractClaimToken(claimUrlOrToken)
  if (!claimToken) throw new Error('Claim URL or claim token is required')

  const issuedAt = Date.now()
  const mode = params.mode ?? 'claim-usdc'

  if ('solanaWallet' in params && params.solanaWallet) {
    if (!params.solanaWallet.publicKey) throw new Error('Solana wallet not connected')

    const claimer = params.solanaWallet.publicKey.toString()
    const requestedPayee = params.payee?.trim() || claimer
    const targetAddress = mode === 'claim-usdc' ? (isEvmAddress(requestedPayee) ? requestedPayee.toLowerCase() : requestedPayee) : null
    const targetNetwork = mode === 'claim-usdc'
      ? (targetAddress == null ? null : isEvmAddress(targetAddress) ? (params.evmNetwork ?? null) : (params.solanaNetwork ?? null))
      : null

    const message = buildSolanaClaimLinkAuthorizationMessage({
      claimToken,
      claimer,
      issuedAt,
      mode,
      targetAddress,
      targetNetwork,
    })

    const signatureBytes = await params.solanaWallet.signMessage(new TextEncoder().encode(message))
    const payload = await fetchOrThrow(`${facilitatorUrl}/solana-payment-codes/claim-links/${claimToken}/claim`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimer,
        issuedAt,
        signature: bs58.encode(signatureBytes),
        mode,
        ...(targetAddress ? { targetAddress } : {}),
        ...(targetNetwork ? { targetNetwork } : {}),
      }),
    })

    return sanitizeClaimLinkResponse(payload, facilitatorUrl, claimToken)
  }

  if (!('wallet' in params) || !params.wallet) {
    throw new Error('An EVM wallet or Solana wallet is required to claim this payment link')
  }

  const claimer = (await params.wallet.getAddress()).toLowerCase()
  const requestedPayee = params.payee?.trim() || claimer
  const targetAddress = mode === 'claim-usdc' ? (isEvmAddress(requestedPayee) ? requestedPayee.toLowerCase() : requestedPayee) : null
  const targetNetwork = mode === 'claim-usdc'
    ? (targetAddress == null ? null : isEvmAddress(targetAddress) ? (params.evmNetwork ?? null) : (params.solanaNetwork ?? null))
    : null

  const message = buildEvmClaimLinkAuthorizationMessage({
    claimToken,
    claimer,
    issuedAt,
    mode,
    targetAddress,
    targetNetwork,
  })

  const payload = await fetchOrThrow(`${facilitatorUrl}/payment-codes/claim-links/evm/${claimToken}/claim`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      claimer,
      issuedAt,
      signature: await params.wallet.signMessage(message),
      mode,
      ...(targetAddress ? { targetAddress, payee: targetAddress } : {}),
      ...(targetNetwork ? { targetNetwork } : {}),
      ...(targetAddress && isEvmAddress(targetAddress) && targetNetwork ? { evmNetwork: targetNetwork } : {}),
      ...(targetAddress && !isEvmAddress(targetAddress) && targetNetwork ? { solanaNetwork: targetNetwork } : {}),
    }),
  })

  return sanitizeClaimLinkResponse(payload, facilitatorUrl, claimToken)
}

export async function payPayRequestWithStoredCode(
  config: PaymentRequestConfig,
  requestCode: string,
  paymentCode: string,
  options: PayPayRequestWithStoredCodeOptions = {},
): Promise<PayPayRequestWithStoredCodeResponse> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR
  const normalizedRequestCode = requestCode.trim().toUpperCase()
  const normalizedPaymentCode = paymentCode.trim().toUpperCase()

  const codeStatusInfo = await fetchStoredCodeWithFallback(facilitatorUrl, normalizedPaymentCode)

  if (codeStatusInfo.kind === 'solana') {
    return fetchOrThrow(`${facilitatorUrl}/solana-payment-codes/${normalizedPaymentCode}/pay-request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requestCode: normalizedRequestCode,
        ...(options.changeAddress ? { changeAddress: options.changeAddress } : {}),
      }),
    })
  }

  const requestInfo = await getPayRequest(config, normalizedRequestCode)
  const codeStatus = codeStatusInfo.payload
  const allowOverpayment = options.allowOverpayment ?? true
  const returnChange = options.returnChange ?? 'code'

  const codeValue = BigInt(String(codeStatus.value ?? 0))
  const requestAmount = BigInt(requestInfo.amount)

  if (codeValue < requestAmount) {
    throw new Error(
      `Payment code value (${Number(codeValue) / 1e6} USDC) is less than the request amount (${Number(requestAmount) / 1e6} USDC)`,
    )
  }

  if (!allowOverpayment && codeValue > requestAmount) {
    throw new Error(
      `Payment code value (${Number(codeValue) / 1e6} USDC) exceeds the request amount (${Number(requestAmount) / 1e6} USDC)`,
    )
  }

  const merchantAddress = String(requestInfo.to)
  const requestNetwork = String(requestInfo.network)
  const usePartial = codeValue > requestAmount

  return fetchOrThrow(`${facilitatorUrl}/payment-codes/${normalizedPaymentCode}/redeem`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      payee: merchantAddress,
      ...(usePartial ? { invoiceAmount: requestInfo.amount.toString() } : {}),
      ...(usePartial ? { returnChangeAsCode: returnChange === 'code' } : {}),
      ...(usePartial && options.changeAddress ? { changeAddress: options.changeAddress } : {}),
      ...(isEvmAddress(merchantAddress)
        ? { evmNetwork: requestNetwork }
        : { solanaNetwork: requestNetwork }),
    }),
  })
}
