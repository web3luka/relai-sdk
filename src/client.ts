// src/client.ts
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { SolanaWallet, EvmWallet, WalletSet } from './types';
import {
  RELAI_FACILITATOR_URL,
  NETWORK_CAIP2,
  CHAIN_IDS,
  NETWORK_TOKENS,
  isSolana,
  isEvm,
  normalizeNetwork,
  type RelaiNetwork,
} from './types';

// ============================================================================
// Types
// ============================================================================

export type X402NetworkSelectionMode = 'prefer_then_any' | 'strict_preferred';

export interface X402ClientConfig {
  /** Multi-chain wallets (Solana + EVM) */
  wallets?: WalletSet;
  /** Single Solana wallet (legacy shortcut) */
  wallet?: SolanaWallet;
  /** Custom facilitator URL, default: RelAI facilitator */
  facilitatorUrl?: string;
  /** Optional Relay WebSocket transport for /relay/:apiId endpoints */
  relayWs?: X402RelayWsConfig;
  /** Preferred network when multiple options available */
  preferredNetwork?: RelaiNetwork;
  /**
   * How to handle 402 accepts when preferredNetwork is set.
   * - prefer_then_any (default): prefer preferredNetwork, then fall back to any payable option.
   * - strict_preferred: only accept preferredNetwork, fail otherwise.
   */
  networkSelectionMode?: X402NetworkSelectionMode;
  /** Custom Solana RPC URL */
  solanaRpcUrl?: string;
  /** Custom EVM RPC URLs per network (e.g. { 'skale-base': 'https://...' }) */
  evmRpcUrls?: Record<string, string>;
  /** Maximum payment amount in atomic units */
  maxAmountAtomic?: string;
  /** Default Integritas behavior for outgoing requests */
  integritas?: boolean | X402IntegritasConfig;
  /** Enable verbose logging */
  verbose?: boolean;
  /** Default headers added to every request (e.g. X-Service-Key, X-Agent-ID for agent use) */
  defaultHeaders?: Record<string, string>;
}

export type X402IntegritasFlow = 'single' | 'dual';

export interface X402IntegritasConfig {
  /** Enable Integritas stamp request headers */
  enabled?: boolean;
  /** Preferred Integritas flow for the request */
  flow?: X402IntegritasFlow;
}

export interface X402RequestOptions {
  /** Per-request Integritas override */
  integritas?: boolean | X402IntegritasConfig;
}

export type X402FetchInit = RequestInit & {
  /** SDK-specific per-request options (not forwarded to fetch as-is) */
  x402?: X402RequestOptions;
};

export interface RelayWebSocketLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener?: (type: string, listener: (...args: any[]) => void) => void;
  removeEventListener?: (type: string, listener: (...args: any[]) => void) => void;
  on?: (type: string, listener: (...args: any[]) => void) => void;
  off?: (type: string, listener: (...args: any[]) => void) => void;
  removeListener?: (type: string, listener: (...args: any[]) => void) => void;
  onopen?: ((event: unknown) => void) | null;
  onmessage?: ((event: unknown) => void) | null;
  onerror?: ((event: unknown) => void) | null;
  onclose?: ((event: unknown) => void) | null;
}

export type RelayWebSocketFactory = (url: string) => RelayWebSocketLike;

export interface X402RelayWsConfig {
  /** Enable WebSocket transport for relay URLs (still falls back to HTTP by default). */
  enabled?: boolean;
  /** Explicit WebSocket relay URL (default is derived from relay URL host). */
  wsUrl?: string;
  /** Timeout for WS connect and preflight call in milliseconds. Default: 5000. */
  preflightTimeoutMs?: number;
  /** Timeout for paid WS retry in milliseconds. Default: 10000. */
  paymentTimeoutMs?: number;
  /** Fallback to standard HTTP x402 flow when WS transport fails. Default: true. */
  fallbackToHttp?: boolean;
  /** Custom WebSocket factory, useful in runtimes without global WebSocket. */
  webSocketFactory?: RelayWebSocketFactory;
}

export interface X402RelayWsError {
  code: number;
  message: string;
  data?: unknown;
  paymentRequired?: unknown;
}

export interface X402RelayWsResponse {
  id?: string | number;
  result?: unknown;
  error?: X402RelayWsError;
  paymentResponse?: unknown;
  metadata?: Record<string, unknown>;
}

export interface X402Client {
  /** Fetch with automatic x402 payment handling */
  fetch(input: string | URL | Request, init?: X402FetchInit): Promise<Response>;
}

type RelaySocketEventName = 'open' | 'message' | 'error' | 'close';
type RelaySocketListener = (...args: any[]) => void;

interface RelayWsCallRequest {
  relayUrl: string;
  requestMethod: string;
  requestHeaders: Record<string, string>;
  requestBody?: unknown;
  paymentPayload?: unknown;
  timeoutMs: number;
}

/**
 * Create an x402 client for automatic payment handling.
 * Supports all RelAI facilitator networks: Solana, Base, Avalanche, SKALE Base, SKALE Base Sepolia, SKALE BITE, Polygon, and Ethereum.
 * Auto-detects the correct chain from the 402 response and picks the right
 * signing method (Solana SPL transfer, EVM EIP-3009 transferWithAuthorization).
 *
 * @example
 * ```typescript
 * import { createX402Client } from '@relai-fi/x402';
 *
 * const client = createX402Client({
 *   wallets: { solana: solanaWallet, evm: evmWalletClient },
 * });
 *
 * // Automatically handles 402 on any RelAI-supported network
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 */
// Networks that use EIP-2612 permit instead of EIP-3009 transferWithAuthorization (currently none)
const PERMIT_NETWORKS = new Set<string>([]);

// Default EVM RPC URLs
const DEFAULT_EVM_RPC_URLS: Record<string, string> = {
  'skale-base': 'https://skale-base.skalenodes.com/v1/base',
  'skale-base-sepolia': 'https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha',
  'skale-bite': 'https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox',
  'base': 'https://mainnet.base.org',
  'avalanche': 'https://api.avax.network/ext/bc/C/rpc',
  'polygon': 'https://polygon-rpc.com',
  'ethereum': 'https://ethereum-rpc.publicnode.com',
  'telos': 'https://rpc.telos.net',
};

export function createX402Client(config: X402ClientConfig): X402Client {
  const {
    wallets = {},
    wallet: legacyWallet,
    facilitatorUrl = RELAI_FACILITATOR_URL,
    relayWs,
    preferredNetwork,
    networkSelectionMode = 'prefer_then_any',
    solanaRpcUrl = 'https://api.mainnet-beta.solana.com',
    evmRpcUrls = {},
    maxAmountAtomic,
    integritas,
    verbose = false,
    defaultHeaders = {},
  } = config;

  const relayWsEnabled = relayWs?.enabled === true;
  const relayWsPreflightTimeoutMs = relayWs?.preflightTimeoutMs ?? 5000;
  const relayWsPaymentTimeoutMs = relayWs?.paymentTimeoutMs ?? 10000;
  const relayWsFallbackToHttp = relayWs?.fallbackToHttp ?? true;
  const defaultIntegritas = normalizeIntegritasOptions(integritas);
  const relayWsReservedSubdomains = new Set<string>([
    'www',
    'api',
    'localhost',
    'admin',
    'app',
    'dashboard',
    'docs',
    'documentation',
    'status',
    'blog',
    'facilitator',
  ]);

  const log = verbose ? console.log.bind(console, '[relai-x402]') : () => {};

  // Merge legacy wallet into wallet set
  const effectiveWallets: WalletSet = { ...wallets };
  if (legacyWallet && !effectiveWallets.solana) {
    effectiveWallets.solana = legacyWallet;
  }

  const hasSolanaWallet = Boolean(
    effectiveWallets.solana?.publicKey && effectiveWallets.solana?.signTransaction
  );
  if (hasSolanaWallet) log('Solana wallet ready');

  function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  function parseJsonSafe(value: string): unknown {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }

  function addSocketListener(
    socket: RelayWebSocketLike,
    eventName: RelaySocketEventName,
    listener: RelaySocketListener,
  ): void {
    if (socket.addEventListener) {
      socket.addEventListener(eventName, listener);
      return;
    }

    if (socket.on) {
      socket.on(eventName, listener);
    }
  }

  function removeSocketListener(
    socket: RelayWebSocketLike,
    eventName: RelaySocketEventName,
    listener: RelaySocketListener,
  ): void {
    if (socket.removeEventListener) {
      socket.removeEventListener(eventName, listener);
      return;
    }

    if (socket.off) {
      socket.off(eventName, listener);
      return;
    }

    if (socket.removeListener) {
      socket.removeListener(eventName, listener);
    }
  }

  function resolveRelayWsUrl(relayUrl: string): string {
    if (relayWs?.wsUrl && relayWs.wsUrl.trim() !== '') {
      return relayWs.wsUrl.trim();
    }

    const parsedRelayUrl = new URL(relayUrl);
    const wsProtocol = parsedRelayUrl.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsProtocol}//${parsedRelayUrl.host}/api/ws/relay`;
  }

  function resolveRelayWhitelabel(parsedRelayUrl: URL): string | null {
    const hostParts = parsedRelayUrl.hostname.toLowerCase().split('.').filter(Boolean);
    if (hostParts.length < 2) {
      return null;
    }

    const candidate = decodeURIComponent(hostParts[0] || '').trim();
    if (!candidate) {
      return null;
    }

    if (relayWsReservedSubdomains.has(candidate.toLowerCase())) {
      return null;
    }

    const lastPart = hostParts[hostParts.length - 1];
    const secondLastPart = hostParts[hostParts.length - 2];
    const isX402WhitelabelHost = hostParts.length >= 3 && secondLastPart === 'x402' && lastPart === 'fi';
    const isLocalWhitelabelHost = hostParts.length === 2 && lastPart === 'localhost';

    if (!isX402WhitelabelHost && !isLocalWhitelabelHost) {
      return null;
    }

    return candidate;
  }

  function resolveRelayTarget(relayUrl: string): { apiId: string; path: string } {
    const parsedRelayUrl = new URL(relayUrl);
    const match = parsedRelayUrl.pathname.match(/\/relay\/([^/]+)(\/.*)?$/);
    if (match) {
      const apiId = decodeURIComponent(match[1]);
      const pathPart = match[2] || '/';
      return {
        apiId,
        path: `${pathPart}${parsedRelayUrl.search || ''}`,
      };
    }

    const whitelabel = resolveRelayWhitelabel(parsedRelayUrl);
    if (!whitelabel) {
      throw new Error(
        `[relai-x402] Unsupported relay URL format for WS transport: ${relayUrl}. ` +
        'Expected /relay/:apiId/... or <whitelabel>.x402.fi/...',
      );
    }

    const pathPart = parsedRelayUrl.pathname && parsedRelayUrl.pathname !== ''
      ? parsedRelayUrl.pathname
      : '/';
    return {
      apiId: whitelabel,
      path: `${pathPart}${parsedRelayUrl.search || ''}`,
    };
  }

  function isRelayRequestUrl(requestUrl: string): boolean {
    try {
      resolveRelayTarget(requestUrl);
      return true;
    } catch {
      return false;
    }
  }

  function headersToRecord(headersInit?: HeadersInit): Record<string, string> {
    if (!headersInit) return {};

    const output: Record<string, string> = {};

    if (typeof Headers !== 'undefined' && headersInit instanceof Headers) {
      headersInit.forEach((value, key) => {
        output[key] = value;
      });
      return output;
    }

    if (Array.isArray(headersInit)) {
      for (const [key, value] of headersInit) {
        output[key] = value;
      }
      return output;
    }

    for (const [key, value] of Object.entries(headersInit)) {
      if (typeof value === 'string') {
        output[key] = value;
      } else if (Array.isArray(value)) {
        output[key] = value.join(', ');
      } else if (value !== undefined && value !== null) {
        output[key] = String(value);
      }
    }

    return output;
  }

  function hasHeaderCaseInsensitive(headers: Record<string, string>, headerName: string): boolean {
    const normalized = headerName.toLowerCase();
    return Object.keys(headers).some((key) => key.toLowerCase() === normalized);
  }

  function normalizeIntegritasFlow(value: unknown): X402IntegritasFlow | undefined {
    const normalized = String(value || '').trim().toLowerCase();
    if (normalized === 'single') return 'single';
    if (normalized === 'dual') return 'dual';
    return undefined;
  }

  function normalizeIntegritasOptions(
    value: boolean | X402IntegritasConfig | undefined,
  ): { enabled: boolean; flow?: X402IntegritasFlow } {
    if (value === true) return { enabled: true };
    if (value === false || value == null) return { enabled: false };

    const flow = normalizeIntegritasFlow(value.flow);
    const enabled =
      typeof value.enabled === 'boolean'
        ? value.enabled
        : true;

    return {
      enabled,
      ...(flow ? { flow } : {}),
    };
  }

  function resolveIntegritasOptions(
    override: boolean | X402IntegritasConfig | undefined,
  ): { enabled: boolean; flow?: X402IntegritasFlow } {
    if (override === undefined) {
      return defaultIntegritas;
    }

    if (typeof override === 'boolean') {
      return {
        enabled: override,
        ...(override && defaultIntegritas.flow ? { flow: defaultIntegritas.flow } : {}),
      };
    }

    const flow = normalizeIntegritasFlow(override.flow) || defaultIntegritas.flow;
    const enabled =
      typeof override.enabled === 'boolean'
        ? override.enabled
        : defaultIntegritas.enabled;

    return {
      enabled,
      ...(enabled && flow ? { flow } : {}),
    };
  }

  function stripInternalInit(init?: X402FetchInit): RequestInit | undefined {
    if (!init) return undefined;
    const { x402: _x402, ...requestInit } = init;
    return requestInit;
  }

  function applyIntegritasHeaders(
    headers: Record<string, string>,
    options: { enabled: boolean; flow?: X402IntegritasFlow },
  ): Record<string, string> {
    if (!options.enabled) return headers;

    if (!hasHeaderCaseInsensitive(headers, 'x-integritas')) {
      headers['X-Integritas'] = 'true';
    }

    if (options.flow && !hasHeaderCaseInsensitive(headers, 'x-integritas-flow')) {
      headers['X-Integritas-Flow'] = options.flow;
    }

    return headers;
  }

  function getRequestMethod(input: string | URL | Request, init?: RequestInit): string {
    const inputMethod = input instanceof Request ? input.method : undefined;
    return (init?.method || inputMethod || 'GET').toUpperCase();
  }

  async function bodyInitToWsPayload(bodyInit: unknown): Promise<unknown> {
    if (bodyInit === undefined || bodyInit === null) {
      return undefined;
    }

    if (typeof bodyInit === 'string') {
      const parsed = parseJsonSafe(bodyInit);
      return parsed === null ? bodyInit : parsed;
    }

    if (typeof URLSearchParams !== 'undefined' && bodyInit instanceof URLSearchParams) {
      return bodyInit.toString();
    }

    if (typeof FormData !== 'undefined' && bodyInit instanceof FormData) {
      const entries: Record<string, string> = {};
      for (const [key, value] of bodyInit.entries()) {
        entries[key] = typeof value === 'string' ? value : value.name;
      }
      return entries;
    }

    if (typeof Blob !== 'undefined' && bodyInit instanceof Blob) {
      const text = await bodyInit.text();
      if (!text) return undefined;
      const parsed = parseJsonSafe(text);
      return parsed === null ? text : parsed;
    }

    if (bodyInit instanceof ArrayBuffer) {
      return Array.from(new Uint8Array(bodyInit));
    }

    if (ArrayBuffer.isView(bodyInit)) {
      return Array.from(new Uint8Array(bodyInit.buffer, bodyInit.byteOffset, bodyInit.byteLength));
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(bodyInit)) {
      return Array.from(bodyInit.values());
    }

    if (isRecord(bodyInit)) {
      return bodyInit;
    }

    return String(bodyInit);
  }

  async function resolveRequestBody(input: string | URL | Request, init?: RequestInit): Promise<unknown> {
    if (init && Object.prototype.hasOwnProperty.call(init, 'body')) {
      return bodyInitToWsPayload(init.body as unknown);
    }

    if (input instanceof Request) {
      const method = getRequestMethod(input, init);
      if (method === 'GET' || method === 'HEAD') {
        return undefined;
      }

      try {
        const cloned = input.clone();
        const text = await cloned.text();
        if (!text) return undefined;
        const parsed = parseJsonSafe(text);
        return parsed === null ? text : parsed;
      } catch {
        return undefined;
      }
    }

    return undefined;
  }

  function getRequestHeaders(input: string | URL | Request, init?: RequestInit): Record<string, string> {
    const fromInput = input instanceof Request ? headersToRecord(input.headers) : {};
    const fromInit = headersToRecord(init?.headers);
    const merged = {
      ...defaultHeaders,
      ...fromInput,
      ...fromInit,
    };

    if (!merged.Accept && !merged.accept) {
      merged.Accept = 'application/json';
    }

    return merged;
  }

  function toMessageString(data: unknown): string {
    if (typeof data === 'string') {
      return data;
    }

    if (isRecord(data) && typeof data.data !== 'undefined') {
      return toMessageString(data.data);
    }

    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) {
      return data.toString('utf8');
    }

    if (data instanceof ArrayBuffer) {
      const bytes = new Uint8Array(data);
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('utf8');
      }
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder().decode(bytes);
      }
      throw new Error('Unsupported WebSocket message data type');
    }

    if (ArrayBuffer.isView(data)) {
      const bytes = new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(bytes).toString('utf8');
      }
      if (typeof TextDecoder !== 'undefined') {
        return new TextDecoder().decode(bytes);
      }
      throw new Error('Unsupported WebSocket message data type');
    }

    throw new Error('Unsupported WebSocket message data type');
  }

  function getWebSocketFactory(): RelayWebSocketFactory {
    if (relayWs?.webSocketFactory) {
      return relayWs.webSocketFactory;
    }

    if (typeof WebSocket !== 'undefined') {
      return (wsUrl: string) => new WebSocket(wsUrl) as unknown as RelayWebSocketLike;
    }

    throw new Error(
      '[relai-x402] WebSocket is not available in this runtime. Provide relayWs.webSocketFactory.',
    );
  }

  async function relayCallOverWebSocket(request: RelayWsCallRequest): Promise<X402RelayWsResponse> {
    const wsFactory = getWebSocketFactory();
    const wsUrl = resolveRelayWsUrl(request.relayUrl);
    const target = resolveRelayTarget(request.relayUrl);
    const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const socket = wsFactory(wsUrl);

    return new Promise<X402RelayWsResponse>((resolve, reject) => {
      let settled = false;

      const settleResolve = (value: X402RelayWsResponse) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close errors.
        }
        resolve(value);
      };

      const settleReject = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        try {
          socket.close();
        } catch {
          // Ignore close errors.
        }
        reject(error);
      };

      const timeoutId = setTimeout(() => {
        settleReject(new Error(`[relai-x402] Timed out waiting for WS relay response after ${request.timeoutMs}ms`));
      }, request.timeoutMs);

      const cleanup = () => {
        clearTimeout(timeoutId);
        removeSocketListener(socket, 'open', onOpen);
        removeSocketListener(socket, 'message', onMessage);
        removeSocketListener(socket, 'error', onError);
        removeSocketListener(socket, 'close', onClose);
      };

      const onOpen = () => {
        const envelope: Record<string, unknown> = {
          id: requestId,
          method: 'relay.call',
          params: {
            apiId: target.apiId,
            path: target.path,
            requestMethod: request.requestMethod,
            requestHeaders: request.requestHeaders,
            ...(request.requestBody !== undefined ? { requestBody: request.requestBody } : {}),
          },
        };

        if (request.paymentPayload !== undefined) {
          envelope.payment = request.paymentPayload;
        }

        try {
          socket.send(JSON.stringify(envelope));
        } catch {
          settleReject(new Error('[relai-x402] Failed to send WS relay request'));
        }
      };

      const onMessage = (...args: any[]) => {
        const payload = args.length > 0 ? args[0] : undefined;

        let parsed: unknown;
        try {
          parsed = parseJsonSafe(toMessageString(payload));
        } catch {
          return;
        }

        if (!isRecord(parsed)) return;

        const responseId =
          typeof parsed.id === 'string' || typeof parsed.id === 'number' ? String(parsed.id) : '';
        if (responseId !== requestId) return;

        settleResolve(parsed as X402RelayWsResponse);
      };

      const onError = () => {
        settleReject(new Error('[relai-x402] WebSocket relay transport error'));
      };

      const onClose = () => {
        settleReject(new Error('[relai-x402] WebSocket relay connection closed before response'));
      };

      addSocketListener(socket, 'open', onOpen);
      addSocketListener(socket, 'message', onMessage);
      addSocketListener(socket, 'error', onError);
      addSocketListener(socket, 'close', onClose);
    });
  }

  function extractPaymentRequirementsFromWsError(error: X402RelayWsError): any | null {
    const candidates: unknown[] = [error.paymentRequired, error.data];

    for (const candidate of candidates) {
      if (!isRecord(candidate)) continue;

      if (Array.isArray(candidate.accepts)) {
        return candidate;
      }

      if (isRecord(candidate.paymentRequired) && Array.isArray(candidate.paymentRequired.accepts)) {
        return candidate.paymentRequired;
      }

      if (isRecord(candidate.data) && Array.isArray(candidate.data.accepts)) {
        return candidate.data;
      }
    }

    return null;
  }

  function buildWsResponse(wsResponse: X402RelayWsResponse): Response {
    const statusFromMetadata =
      isRecord(wsResponse.metadata) && typeof wsResponse.metadata.status === 'number'
        ? wsResponse.metadata.status
        : 200;
    const status = Number.isInteger(statusFromMetadata) && statusFromMetadata >= 100 && statusFromMetadata <= 599
      ? statusFromMetadata
      : 200;

    const headers = new Headers();
    headers.set('Content-Type', 'application/json');

    if (wsResponse.paymentResponse !== undefined) {
      headers.set('PAYMENT-RESPONSE', encodeBase64Json(wsResponse.paymentResponse));
    }

    const bodyPayload = wsResponse.result === undefined ? null : wsResponse.result;
    return new Response(JSON.stringify(bodyPayload), {
      status,
      headers,
    });
  }

  // -----------------------------------------------------------------------
  // Select a payment option from the 402 response's `accepts` array
  // -----------------------------------------------------------------------
  function selectAcceptForWallet(a: any): { accept: any; chain: 'solana' | 'evm' } | null {
    const net = a.network || '';
    if (isSolana(net) && hasSolanaWallet) {
      return { accept: a, chain: 'solana' };
    }
    if (isEvm(net) && effectiveWallets.evm) {
      return { accept: a, chain: 'evm' };
    }
    return null;
  }

  function buildNoWalletError(accepts: any[], isWs: boolean): string {
    const networks = accepts.map((a: any) => a.network).join(', ');
    if (preferredNetwork && networkSelectionMode === 'strict_preferred') {
      const preferredCaip2 = NETWORK_CAIP2[preferredNetwork];
      return (
        `[relai-x402] Preferred network ${preferredNetwork} (${preferredCaip2}) is required, ` +
        `but no compatible wallet is connected. Available networks: ${networks}`
      );
    }

    return `[relai-x402] No wallet available for${isWs ? ' WS' : ''} networks: ${networks}`;
  }

  function selectAccept(accepts: any[]): { accept: any; chain: 'solana' | 'evm' } | null {
    // 1) Preferred network first
    if (preferredNetwork) {
      const caip2 = NETWORK_CAIP2[preferredNetwork];
      for (const a of accepts) {
        const net = a.network || '';
        if (net === preferredNetwork || net === caip2) {
          const selected = selectAcceptForWallet(a);
          if (selected) {
            return selected;
          }
        }
      }

      if (networkSelectionMode === 'strict_preferred') {
        return null;
      }
    }

    // 2) First option we have a wallet for
    for (const a of accepts) {
      const selected = selectAcceptForWallet(a);
      if (selected) {
        return selected;
      }
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // Bridge extension — cross-chain payment routing (x402 bridge spec)
  // -----------------------------------------------------------------------

  function getBridgeExtension(requirements: any): any | null {
    const ext = requirements?.extensions?.bridge;
    if (!ext?.info?.endpoint || !Array.isArray(ext.info.supportedSourceChains)) return null;
    return ext.info;
  }

  function selectBridgeSource(bridge: any): { chain: 'solana' | 'evm'; network: string; asset: string } | null {
    const sourceChains: string[] = bridge.supportedSourceChains || [];
    const sourceAssets: string[] = bridge.supportedSourceAssets || [];
    for (const caip2 of sourceChains) {
      if (isSolana(caip2) && hasSolanaWallet) {
        const asset = sourceAssets.find((a: string) => !a.startsWith('0x')) || '';
        return { chain: 'solana', network: caip2, asset };
      }
      if (isEvm(caip2) && effectiveWallets.evm) {
        const asset = sourceAssets.find((a: string) => a.startsWith('0x')) || '';
        return { chain: 'evm', network: caip2, asset };
      }
    }
    return null;
  }

  async function executeBridgePayment(
    bridge: any,
    accepts: any[],
    requirements: any,
    url: string,
  ): Promise<string> {
    const source = selectBridgeSource(bridge);
    if (!source) {
      throw new Error('[relai-x402] bridge extension found but no wallet matches supported source chains');
    }

    // Pick first accept as the target (merchant's preferred chain)
    const targetAccept = accepts[0];
    const amount = targetAccept.amount || targetAccept.maxAmountRequired;

    log(`Bridge: ${source.network} → ${targetAccept.network}, amount=${amount}`);

    // Amount guard
    if (maxAmountAtomic && BigInt(amount) > BigInt(maxAmountAtomic)) {
      throw new Error(`[relai-x402] Amount ${amount} exceeds max ${maxAmountAtomic}`);
    }

    // Build source-chain payment header (same logic as direct payment)
    let sourcePaymentHeader: string;
    if (source.chain === 'solana') {
      // Build a synthetic accept entry for the source chain.
      // payTo must be the bridge facilitator's Solana wallet (bridge.payTo),
      // NOT the merchant's address (which may be an EVM address).
      // feePayer comes from bridge.info — facilitator sponsors Solana gas.
      if (!bridge.payTo) {
        throw new Error('[relai-x402] bridge.info.payTo is required for Solana source payments');
      }
      const sourceAccept = {
        scheme: 'exact',
        network: source.network,
        asset: source.asset,
        payTo: bridge.payTo,
        amount: targetAccept.amount || targetAccept.maxAmountRequired,
        extra: {
          ...(bridge.feePayer ? { feePayer: bridge.feePayer } : {}),
          decimals: 6,
        },
      };
      sourcePaymentHeader = await buildSolanaPayment(sourceAccept, requirements, url);
    } else {
      const evmNetwork = normalizeNetwork(source.network);
      const usePermit = evmNetwork && PERMIT_NETWORKS.has(evmNetwork);
      const sourceAccept = {
        ...targetAccept,
        network: source.network,
        asset: source.asset || targetAccept.asset,
        ...(bridge.payTo ? { payTo: bridge.payTo } : {}),
      };
      sourcePaymentHeader = usePermit
        ? await buildEvmPermitPayment(sourceAccept, requirements, url)
        : await buildEvmPayment(sourceAccept, requirements, url);
    }

    // POST to bridge endpoint
    const bridgeRes = await fetch(bridge.endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourcePayment: sourcePaymentHeader,
        sourceChain: source.network,
        targetAccept,
        requirements,
        resource: url,
        paymentFacilitator: bridge.paymentFacilitator || null,
      }),
    });

    if (!bridgeRes.ok) {
      const err = await bridgeRes.json().catch(() => ({}));
      throw new Error(`[relai-x402] bridge settle failed: ${err.error || bridgeRes.status}`);
    }

    const bridgeData = await bridgeRes.json();
    if (!bridgeData.xPayment) {
      throw new Error('[relai-x402] bridge endpoint did not return xPayment header');
    }

    log(`Bridge settled: sourceTx=${bridgeData.sourceTxId}, targetTx=${bridgeData.targetTxId}`);
    return bridgeData.xPayment;
  }

  // -----------------------------------------------------------------------
  // JSON-RPC helper (for reading EVM contract state without ethers)
  // -----------------------------------------------------------------------
  async function evmRpcCall(rpcUrl: string, to: string, data: string): Promise<string> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
        id: 1,
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result;
  }

  function getEvmRpcUrl(network: string): string {
    return evmRpcUrls[network] || DEFAULT_EVM_RPC_URLS[network] || '';
  }

  // -----------------------------------------------------------------------
  // Build EVM payment — EIP-2612 permit (for SKALE Base)
  // -----------------------------------------------------------------------
  async function buildEvmPermitPayment(
    accept: any,
    requirements: any,
    url: string,
  ): Promise<string> {
    const evmWallet = effectiveWallets.evm!;
    const extra = accept.extra || {};

    const rawNetwork = accept.network || '';
    const network = normalizeNetwork(rawNetwork);
    const chainId = network ? CHAIN_IDS[network] : parseInt(rawNetwork.split(':')[1] || '8453');
    const paymentAmount = accept.amount || accept.maxAmountRequired;
    const spender = extra.feePayer || accept.payTo;
    const usdcAddress = accept.asset;

    const rpcUrl = getEvmRpcUrl(network || rawNetwork);
    if (!rpcUrl) throw new Error(`[relai-x402] No EVM RPC URL for network ${network || rawNetwork}`);

    log('Building EIP-2612 permit on chain', chainId);

    // Read nonce from USDC contract: nonces(address) = 0x7ecebe00
    const paddedAddress = evmWallet.address.toLowerCase().replace('0x', '').padStart(64, '0');
    const nonceHex = await evmRpcCall(rpcUrl, usdcAddress, '0x7ecebe00' + paddedAddress);
    const nonce = nonceHex ? parseInt(nonceHex, 16) : 0;
    if (isNaN(nonce)) throw new Error(`[relai-x402] Failed to read permit nonce from ${usdcAddress} on ${rpcUrl}`);
    log('  Permit nonce:', nonce);

    // Read token name: name() = 0x06fdde03
    const nameHex = await evmRpcCall(rpcUrl, usdcAddress, '0x06fdde03');
    // Decode ABI-encoded string
    let tokenName = 'USD Coin';
    try {
      const offset = parseInt(nameHex.slice(2, 66), 16) * 2;
      const length = parseInt(nameHex.slice(2 + offset, 2 + offset + 64), 16);
      const hex = nameHex.slice(2 + offset + 64, 2 + offset + 64 + length * 2);
      tokenName = decodeURIComponent(hex.replace(/[0-9a-f]{2}/g, '%$&'));
    } catch {
      tokenName = extra.name || 'USD Coin';
    }
    log('  Token name:', tokenName);

    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 min

    const domain = {
      name: tokenName,
      version: extra.version || '2',
      chainId,
      verifyingContract: usdcAddress,
    };

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const message = {
      owner: evmWallet.address,
      spender,
      value: paymentAmount,
      nonce: String(nonce),
      deadline: String(deadline),
    };

    log('Signing EIP-2612 permit:', message);

    const signature = await evmWallet.signTypedData({
      domain,
      types,
      message,
      primaryType: 'Permit',
    });

    // Split signature into v, r, s
    const sigHex = (signature as string).replace('0x', '');
    const r = '0x' + sigHex.slice(0, 64);
    const s = '0x' + sigHex.slice(64, 128);
    const v = parseInt(sigHex.slice(128, 130), 16);

    log('  Permit signed: v=%d r=%s s=%s', v, r, s);

    // Build x402 v2 payment payload (SKALE format)
    const paymentPayload = {
      x402Version: 2,
      scheme: 'exact',
      network: network || rawNetwork,
      payload: {
        userAddress: evmWallet.address,
        permit: { deadline: String(deadline), v, r, s },
        amount: paymentAmount,
      },
    };

    return encodeBase64Json(paymentPayload);
  }

  // -----------------------------------------------------------------------
  // Build EVM payment (EIP-3009 transferWithAuthorization)
  // -----------------------------------------------------------------------
  async function buildEvmPayment(
    accept: any,
    requirements: any,
    url: string,
  ): Promise<string> {
    const evmWallet = effectiveWallets.evm!;
    const extra = accept.extra || {};

    const rawNetwork = accept.network || '';
    const network = normalizeNetwork(rawNetwork);
    const chainId = network ? CHAIN_IDS[network] : parseInt(rawNetwork.split(':')[1] || '8453');

    const paymentAmount = accept.amount || accept.maxAmountRequired;

    // EIP-3009 transferWithAuthorization does NOT require approve
    // Facilitator executes transfer directly with user's signature (zero gas for user)
    
    // For relayer-based facilitators (0xGasless), 'to' is the payTo (merchant).
    // For standard x402 (RelAI), 'to' is also payTo (merchant).
    const useRelayer = !!extra.relayerContract;

    const rpcUrl = getEvmRpcUrl(network || rawNetwork);
    const defaultTokenVersion = chainId === CHAIN_IDS['skale-bite'] ? '1' : '2';

    let tokenName = extra.name || 'USD Coin';
    if (!useRelayer && rpcUrl) {
      try {
        // Read token name from contract to avoid EIP-712 domain mismatch across bridged assets.
        const nameHex = await evmRpcCall(rpcUrl, accept.asset, '0x06fdde03');
        const offset = parseInt(nameHex.slice(2, 66), 16) * 2;
        const length = parseInt(nameHex.slice(2 + offset, 2 + offset + 64), 16);
        const hex = nameHex.slice(2 + offset + 64, 2 + offset + 64 + length * 2);
        tokenName = decodeURIComponent(hex.replace(/[0-9a-f]{2}/g, '%$&'));
      } catch {
        tokenName = extra.name || 'USD Coin';
      }
    }

    // EIP-3009 transferWithAuthorization typed data
    // When extra.relayerContract is present (e.g. 0xGasless), sign against the
    // relayer contract's EIP-712 domain instead of the token contract's domain.
    const domain = {
      name: useRelayer ? (extra.domainName || 'A402') : tokenName,
      version: useRelayer ? (extra.domainVersion || '1') : (extra.version || defaultTokenVersion),
      chainId,
      verifyingContract: useRelayer ? extra.relayerContract : accept.asset,
    };

    // Detect whether token supports EIP-2612 permit (but not EIP-3009)
    const tokenNetworkKey = network || rawNetwork;
    const networkTokens = NETWORK_TOKENS[tokenNetworkKey as keyof typeof NETWORK_TOKENS];
    const assetLower = (accept.asset || '').toLowerCase();
    const tokenInfo = networkTokens?.find((t: any) => t.address.toLowerCase() === assetLower) || networkTokens?.[0];
    const tokenStandards: string[] = Array.isArray(tokenInfo?.standards) ? tokenInfo.standards : [];
    const hasEip3009 = tokenStandards.some((s: string) => s.toLowerCase() === 'eip3009');
    const hasEip2612 = tokenStandards.some((s: string) => s.toLowerCase() === 'eip2612');
    const usePermit2612 = !hasEip3009 && hasEip2612;

    let message: Record<string, unknown>;
    let signature: string;
    let authorizationScheme: string;

    if (usePermit2612) {
      // EIP-2612 permit flow: read nonce from contract, sign Permit typed data
      // spender = feePayer (RelAI backend) who will call permit + transferFrom
      const spender = extra.feePayer || accept.payTo;
      const deadline = Math.floor(Date.now() / 1000) + 3600;

      let nonce = 0;
      if (rpcUrl) {
        try {
          const paddedAddress = evmWallet.address.toLowerCase().replace('0x', '').padStart(64, '0');
          const nonceHex = await evmRpcCall(rpcUrl, accept.asset, '0x7ecebe00' + paddedAddress);
          nonce = nonceHex ? parseInt(nonceHex, 16) : 0;
        } catch { nonce = 0; }
      }

      const permitTypes = {
        Permit: [
          { name: 'owner', type: 'address' },
          { name: 'spender', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
          { name: 'deadline', type: 'uint256' },
        ],
      };

      message = {
        owner: evmWallet.address,
        spender,
        value: paymentAmount,
        nonce: String(nonce),
        deadline: String(deadline),
      };

      log('Signing EIP-2612 permit on chain', chainId);

      signature = await evmWallet.signTypedData({
        domain,
        types: permitTypes,
        message,
        primaryType: 'Permit',
      });

      authorizationScheme = 'eip2612';
    } else {
      // EIP-3009 transferWithAuthorization flow (default)
      const validAfter = 0;
      const validBefore = Math.floor(Date.now() / 1000) + 3600;
      const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))]
        .map(b => b.toString(16).padStart(2, '0')).join('');

      const transferTypes = {
        TransferWithAuthorization: [
          { name: 'from', type: 'address' },
          { name: 'to', type: 'address' },
          { name: 'value', type: 'uint256' },
          { name: 'validAfter', type: 'uint256' },
          { name: 'validBefore', type: 'uint256' },
          { name: 'nonce', type: 'bytes32' },
        ],
      };

      message = {
        from: evmWallet.address,
        to: accept.payTo,
        value: paymentAmount,
        validAfter: String(validAfter),
        validBefore: String(validBefore),
        nonce,
      };

      log('Signing EIP-3009 transferWithAuthorization on chain', chainId);

      signature = await evmWallet.signTypedData({
        domain,
        types: transferTypes,
        message,
        primaryType: 'TransferWithAuthorization',
      });

      authorizationScheme = 'eip3009';
    }

    // Build x402 v2 payment payload
    const paymentPayload = {
      x402Version: 2,
      resource: requirements.resource || { url },
      accepted: accept,
      payload: {
        authorization: message,
        signature,
        authorizationScheme,
      },
      facilitatorUrl,
    };

    return encodeBase64Json(paymentPayload);
  }

  // -----------------------------------------------------------------------
  // Build Solana payment (SPL transfer with fee payer sponsorship)
  // -----------------------------------------------------------------------
  async function buildSolanaPayment(
    accept: any,
    requirements: any,
    url: string,
  ): Promise<string> {
    const solWallet = effectiveWallets.solana!;
    const extra = accept.extra || {};

    if (!extra.feePayer) {
      throw new Error('[relai-x402] Missing feePayer in Solana payment requirements');
    }

    const connection = new Connection(solanaRpcUrl, 'confirmed');
    const userPubkey = new PublicKey(solWallet.publicKey!.toString());
    const merchantPubkey = new PublicKey(accept.payTo);
    const feePayerPubkey = new PublicKey(extra.feePayer);
    const mintPubkey = new PublicKey(accept.asset);
    const paymentAmount = BigInt(accept.amount || accept.maxAmountRequired);

    log('Building Solana SPL transfer');
    log('  User:', userPubkey.toBase58());
    log('  Merchant:', merchantPubkey.toBase58());
    log('  FeePayer:', feePayerPubkey.toBase58());
    log('  Mint:', mintPubkey.toBase58());
    log('  Amount:', paymentAmount.toString());

    // Determine token program (TOKEN_PROGRAM_ID vs TOKEN_2022)
    const mintInfo = await getMint(connection, mintPubkey);
    const programId = mintInfo.address.equals(mintPubkey)
      ? (mintInfo as any).owner?.toBase58?.() === TOKEN_2022_PROGRAM_ID.toBase58()
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    // Get ATAs (allowOffCurve=true for smart wallets / PDA signers)
    const sourceAta = await getAssociatedTokenAddress(
      mintPubkey, userPubkey, true, programId,
    );
    const destinationAta = await getAssociatedTokenAddress(
      mintPubkey, merchantPubkey, true, programId,
    );

    log('  Source ATA:', sourceAta.toBase58());
    log('  Dest ATA:', destinationAta.toBase58());

    // Build transfer instruction
    const transferIx = createTransferCheckedInstruction(
      sourceAta,
      mintPubkey,
      destinationAta,
      userPubkey,
      paymentAmount,
      mintInfo.decimals,
      [],
      programId,
    );

    // Build versioned transaction with feePayer
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);

    // User signs (feePayer signs on backend/facilitator side)
    const signedTx = await solWallet.signTransaction!(transaction) as VersionedTransaction;
    log('Transaction signed by user');

    // Serialize to base64
    const serializedTx = Buffer.from(signedTx.serialize()).toString('base64');

    // Build x402 v2 payment payload
    const paymentPayload = {
      x402Version: 2,
      resource: requirements.resource || { url },
      accepted: accept,
      payload: {
        transaction: serializedTx,
      },
    };

    return encodeBase64Json(paymentPayload);
  }

  // -----------------------------------------------------------------------
  // Main fetch
  // -----------------------------------------------------------------------
  function encodeBase64Json(payload: unknown): string {
    const serialized = JSON.stringify(payload);
    if (typeof Buffer !== 'undefined') {
      return Buffer.from(serialized, 'utf8').toString('base64');
    }
    if (typeof btoa !== 'undefined') {
      return btoa(serialized);
    }
    throw new Error('[relai-x402] Base64 encoding is not available in this runtime');
  }

  function decodeBase64Json(encoded: string): any | null {
    try {
      const normalized = encoded.trim().replace(/-/g, '+').replace(/_/g, '/');
      const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, '=');
      const decoded = typeof Buffer !== 'undefined'
        ? Buffer.from(padded, 'base64').toString('utf8')
        : atob(padded);
      return JSON.parse(decoded);
    } catch {
      return null;
    }
  }

  function parsePaymentRequiredHeader(response: Response): any | null {
    const headerValue =
      response.headers.get('payment-required') ||
      response.headers.get('PAYMENT-REQUIRED') ||
      response.headers.get('x-payment-required') ||
      response.headers.get('X-PAYMENT-REQUIRED');

    if (!headerValue) return null;

    const trimmed = headerValue.trim();
    if (!trimmed) return null;

    try {
      return JSON.parse(trimmed);
    } catch {
      return decodeBase64Json(trimmed);
    }
  }

  function getAccepts(requirements: any): any[] {
    if (!requirements || typeof requirements !== 'object') {
      return [];
    }

    if (Array.isArray(requirements.accepts)) {
      return requirements.accepts;
    }

    if (requirements.paymentRequired && Array.isArray(requirements.paymentRequired.accepts)) {
      return requirements.paymentRequired.accepts;
    }

    if (requirements.data && Array.isArray(requirements.data.accepts)) {
      return requirements.data.accepts;
    }

    return [];
  }

  async function x402Fetch(
    input: string | URL | Request,
    init?: X402FetchInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    log('Request:', url);

    const requestInit = stripInternalInit(init);
    const integritasOptions = resolveIntegritasOptions(init?.x402?.integritas);
    const requestMethod = getRequestMethod(input, requestInit);
    const requestHeaders = applyIntegritasHeaders(
      getRequestHeaders(input, requestInit),
      integritasOptions,
    );
    const requestInitWithHeaders: RequestInit = {
      ...(requestInit || {}),
      headers: requestHeaders,
    };
    const requestBody = await resolveRequestBody(input, requestInitWithHeaders);

    if (relayWsEnabled && isRelayRequestUrl(url)) {
      let wsPaymentPhaseStarted = false;
      try {
        log('Using WebSocket relay transport');

        const wsPreflightResponse = await relayCallOverWebSocket({
          relayUrl: url,
          requestMethod,
          requestHeaders,
          requestBody,
          timeoutMs: relayWsPreflightTimeoutMs,
        });

        if (!wsPreflightResponse.error) {
          return buildWsResponse(wsPreflightResponse);
        }

        if (Number(wsPreflightResponse.error.code) !== 402) {
          throw new Error(wsPreflightResponse.error.message || '[relai-x402] WebSocket relay request failed');
        }

        const wsRequirements = extractPaymentRequirementsFromWsError(wsPreflightResponse.error);
        if (!wsRequirements) {
          throw new Error(
            wsPreflightResponse.error.message || '[relai-x402] No payment requirements in WS 402 response'
          );
        }

        const wsAccepts = getAccepts(wsRequirements);
        if (!wsAccepts.length) {
          throw new Error('[relai-x402] No payment options in WS 402 response');
        }

        if (wsAccepts.length > 1) {
          throw new Error(
            '[relai-x402] WS relay currently supports a single payment payload; use HTTP flow for multi-accept payments'
          );
        }

        const wsSelected = selectAccept(wsAccepts);
        if (!wsSelected) {
          throw new Error(buildNoWalletError(wsAccepts, true));
        }

        const { accept, chain } = wsSelected;
        const amount = accept.amount || accept.maxAmountRequired;

        if (maxAmountAtomic && BigInt(amount) > BigInt(maxAmountAtomic)) {
          throw new Error(`[relai-x402] Amount ${amount} exceeds max ${maxAmountAtomic}`);
        }

        wsPaymentPhaseStarted = true;

        let paymentHeader: string | null = null;
        if (chain === 'solana' && hasSolanaWallet) {
          paymentHeader = await buildSolanaPayment(accept, wsRequirements, url);
        } else if (chain === 'evm') {
          const evmNetwork = normalizeNetwork(accept.network || '');
          const usePermit = evmNetwork && PERMIT_NETWORKS.has(evmNetwork);
          paymentHeader = usePermit
            ? await buildEvmPermitPayment(accept, wsRequirements, url)
            : await buildEvmPayment(accept, wsRequirements, url);
        }

        if (!paymentHeader) {
          throw new Error('[relai-x402] Unexpected state - no WS payment handler matched');
        }

        const paymentPayload = decodeBase64Json(paymentHeader);
        if (!paymentPayload) {
          throw new Error('[relai-x402] Failed to decode payment payload for WS relay call');
        }

        const wsPaidResponse = await relayCallOverWebSocket({
          relayUrl: url,
          requestMethod,
          requestHeaders,
          requestBody,
          paymentPayload,
          timeoutMs: relayWsPaymentTimeoutMs,
        });

        if (wsPaidResponse.error) {
          throw new Error(wsPaidResponse.error.message || '[relai-x402] WebSocket paid relay request failed');
        }

        return buildWsResponse(wsPaidResponse);
      } catch (wsError) {
        const wsMessage = wsError instanceof Error ? wsError.message : String(wsError);
        log('WebSocket relay transport failed:', wsMessage);

        if (wsPaymentPhaseStarted) {
          // Do not retry over HTTP after payment flow has started (may trigger duplicate signing/payment prompts).
          throw wsError instanceof Error ? wsError : new Error(`[relai-x402] ${wsMessage}`);
        }

        if (!relayWsFallbackToHttp) {
          throw wsError instanceof Error ? wsError : new Error(`[relai-x402] ${wsMessage}`);
        }

        log('Falling back to HTTP x402 flow');
      }
    }

    const response = await fetch(input, requestInitWithHeaders);
    if (response.status !== 402) return response;

    log('Got 402 Payment Required');

    let requirementsFromBody: any = null;
    try {
      requirementsFromBody = await response.clone().json();
    } catch {}

    const requirementsFromHeader = parsePaymentRequiredHeader(response);

    let requirements: any = requirementsFromBody;
    let accepts = getAccepts(requirementsFromBody);

    if (!accepts.length && requirementsFromHeader) {
      const headerAccepts = getAccepts(requirementsFromHeader);

      if (headerAccepts.length || !requirements || typeof requirements !== 'object') {
        requirements = requirementsFromHeader;
        accepts = headerAccepts;
        log('402 body missing accepts; using PAYMENT-REQUIRED header fallback');
      }
    }

    if (!requirements || typeof requirements !== 'object') {
      throw new Error('[relai-x402] Failed to parse 402 response body/header');
    }

    if (!accepts.length) throw new Error('[relai-x402] No payment options in 402 response');

    const selected = selectAccept(accepts);
    if (!selected) {
      // Fallback: check bridge extension for cross-chain routing
      const bridge = getBridgeExtension(requirements);
      if (bridge && selectBridgeSource(bridge)) {
        log('No direct wallet match — attempting bridge extension flow');
        const paymentHeader = await executeBridgePayment(bridge, accepts, requirements, url);
        log('Retrying with X-PAYMENT header (bridge)');
        return fetch(input, {
          ...requestInitWithHeaders,
          headers: { ...requestHeaders, 'X-PAYMENT': paymentHeader },
        });
      }
      throw new Error(buildNoWalletError(accepts, false));
    }

    const { accept, chain } = selected;
    const amount = accept.amount || accept.maxAmountRequired;
    log(`Selected: ${chain} / ${accept.network} / amount=${amount}`);

    // Amount guard
    if (maxAmountAtomic && BigInt(amount) > BigInt(maxAmountAtomic)) {
      throw new Error(`[relai-x402] Amount ${amount} exceeds max ${maxAmountAtomic}`);
    }

    // Solana — build SPL transfer natively (no x402-solana dependency)
    if (chain === 'solana' && hasSolanaWallet) {
      const paymentHeader = await buildSolanaPayment(accept, requirements, url);
      log('Retrying with X-PAYMENT header (Solana)');
      return fetch(input, {
        ...requestInitWithHeaders,
        headers: {
          ...requestHeaders,
          'X-PAYMENT': paymentHeader,
        },
      });
    }

    // EVM — build payment header and retry
    if (chain === 'evm') {
      const evmNetwork = normalizeNetwork(accept.network || '');
      const usePermit = evmNetwork && PERMIT_NETWORKS.has(evmNetwork);
      const paymentHeader = usePermit
        ? await buildEvmPermitPayment(accept, requirements, url)
        : await buildEvmPayment(accept, requirements, url);
      log('Retrying with X-PAYMENT header');
      return fetch(input, {
        ...requestInitWithHeaders,
        headers: {
          ...requestHeaders,
          'X-PAYMENT': paymentHeader,
        },
      });
    }

    throw new Error('[relai-x402] Unexpected state - no payment handler matched');
  }

  return { fetch: x402Fetch };
}

export default createX402Client;
