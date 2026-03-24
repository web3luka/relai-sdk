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

// Payment Requests — Merchant-initiated payment requests (reverse of payment-codes)
export { createPayRequest, getPayRequest, payPayRequest, payPayRequestWithCode } from './payment-requests';
export type {
  PaymentRequestConfig,
  CreatePayRequestParams,
  PayRequest,
  PayRequestInfo,
  PayRequestResult,
  PayPayRequestWithCodeOptions,
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
