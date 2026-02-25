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
  RelayWebSocketFactory,
  RelayWebSocketLike,
} from './client';

// All types & constants
export * from './types';

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
