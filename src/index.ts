// src/index.ts

// Server-side (Express middleware)
export { default as Relai, Relai as default } from './server';
export type {
  RelaiServerConfig,
  ProtectOptions,
  SettleResult,
  PaymentInfo,
  DynamicPrice,
  StripePayTo,
  RelaiIntegritasFlow,
  RelaiIntegritasOptions,
  MppServerHandler,
} from './server';
export { stripePayTo } from './server';

// Client-side (fetch wrapper)
export { createX402Client } from './client';
export type {
  X402ClientConfig,
  X402Client,
  X402NetworkSelectionMode,
  X402RelayWsConfig,
  X402RelayWsResponse,
  X402RelayWsError,
  X402FetchInit,
  X402IntegritasFlow,
  X402IntegritasConfig,
  X402RequestOptions,
  MppHandler,
  RelayWebSocketFactory,
  RelayWebSocketLike,
} from './client';

// Plugin types (runtime exports via '@relai-fi/x402/plugins')
export type {
  RelaiPlugin,
  PluginContext,
  PluginResult,
  FreeTierPluginConfig,
  BridgePluginConfig,
  ScorePluginConfig,
  FeedbackPluginConfig,
  SolanaFeedbackPluginConfig,
} from './plugins';
export type { RelayFeedbackConfig } from './relay-feedback';
export { submitRelayFeedback } from './relay-feedback';

// Solana Payment Codes — BLIK-style pre-funded codes on Solana (SPL custodial escrow)
export {
  generateSolanaPaymentCode,
  getSolanaPaymentCode,
  redeemSolanaPaymentCode,
  cancelSolanaPaymentCode,
} from './solana-payment-codes';
export type {
  SolanaCodeConfig,
  GenerateSolanaPaymentCodeParams,
  SolanaClaimLink,
  SolanaPaymentCode,
  SolanaCodeStatus,
  SolanaCodeRedeemResult,
  SolanaCodeCancelResult,
} from './solana-payment-codes';

// Payment Requests — Merchant-initiated payment requests (reverse of payment-codes)
export { createPayRequest, getPayRequest, payPayRequest, payPayRequestWithCode, payPayRequestWithSolana } from './payment-requests';
export type {
  PaymentRequestConfig,
  CreatePayRequestParams,
  PaymentRequestNetwork,
  PayRequest,
  PayRequestInfo,
  PayRequestResult,
  PayPayRequestWithCodeOptions,
  SolanaWalletAdapter,
  SolanaPayRequestOptions,
  SolanaPayRequestResult,
} from './payment-requests';

// Payment Codes — BLIK-style x402 payment codes (SKALE L3 + Base L2)
export {
  createPrivateKeySigner,
  generatePaymentCode,
  generatePaymentCodesBatch,
  redeemPaymentCode,
  getPaymentCode,
  cancelPaymentCode,
  NETWORK_CONFIGS,
} from './payment-codes';
export type {
  PaymentCodeConfig,
  PaymentCodeSigner,
  PaymentCodeNetwork,
  NetworkConfig,
  GeneratePaymentCodeParams,
  GeneratePaymentCodesBatchParams,
  BatchCodeItem,
  PaymentCode,
  BatchPaymentCodesResult,
  RedeemResult,
  CodeStatus,
} from './payment-codes';

export {
  createPaymentCode,
  createPaymentCodesBatch,
  listOwnerPaymentCodes,
  getPaymentCodeDetails,
  redeemStoredPaymentCode,
  cancelStoredPaymentCode,
  claimPaymentLink,
  payPayRequestWithStoredCode,
} from './current-payment-codes';
export type {
  CurrentPaymentCodeNetwork,
  EvmCurrentPaymentCodeSigner,
  SolanaCurrentPaymentCodeWallet,
  CreatePaymentCodeParams,
  CreatePaymentCodesBatchItem,
  CreatePaymentCodesBatchParams,
  ListOwnerPaymentCodesParams,
  RedeemStoredPaymentCodeParams,
  CancelStoredPaymentCodeParams,
  ClaimPaymentLinkMode,
  ClaimPaymentLinkParams,
  PayPayRequestWithStoredCodeOptions,
  CurrentPaymentCodeResponse,
  OwnerPaymentCodesResponse,
  PaymentCodeDetailsResponse,
  RedeemStoredPaymentCodeResponse,
  CancelStoredPaymentCodeResponse,
  ClaimPaymentLinkResponse,
  PayPayRequestWithStoredCodeResponse,
  PaymentCodesBatchResponse,
} from './current-payment-codes';

// All types & constants
export * from './types';

// Management API (re-export bridge types for convenience)
export type {
  BridgeQuoteResult,
  BridgeBalances,
  BridgeResult,
} from './management';

// Utility re-exports
export {
  convertV1ToV2,
  convertV2ToV1,
  convertPayloadToVersion,
  detectPayloadVersion,
  normalizePaymentHeader,
  networkV1ToV2,
  networkV2ToV1,
  isSolanaNetwork,
  isEvmNetwork,
  NETWORK_V1_TO_V2,
  NETWORK_V2_TO_V1,
  toAtomicUnits,
  fromAtomicUnits,
  formatUsd,
} from './utils/payload-converter';

// MPP EVM method (SKALE, Base, Polygon, etc.)
export {
  evmChargeMethod,
  evmChargeServer,
  evmChargeClient,
  type EvmChargeConfig,
  type EvmChargeClientConfig,
} from './mpp/index';
