<h1 align="center">@relai-fi/x402</h1>

<p align="center">
  <strong>Unified x402 payment SDK for Solana and EVM networks, including SKALE Base Sepolia.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@relai-fi/x402"><img src="https://img.shields.io/npm/v/@relai-fi/x402.svg" alt="npm"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E=18-brightgreen.svg" alt="Node"></a>
  <a href="https://relai.fi"><img src="https://img.shields.io/badge/Marketplace-relai.fi-blueviolet" alt="Marketplace"></a>
</p>

<p align="center">
  <a href="https://relai.fi"><strong>Browse APIs →</strong></a>
</p>

---

## What is x402?

x402 is a protocol for HTTP-native micropayments. When a server returns HTTP `402 Payment Required`, it includes payment details in the response. The client signs a payment, retries the request, and the server settles the payment and returns the protected content.

This SDK handles the entire flow automatically — call `fetch()` and payments happen transparently.

---

## Why This SDK?

**Multi-chain.** Solana, Base, Avalanche, SKALE Base, SKALE Base Sepolia, SKALE BITE, Polygon, and Ethereum with a single API. Connect your wallets and the SDK picks the right chain and signing method automatically.

**Zero gas fees.** The RelAI facilitator sponsors gas — users only pay for content (USDC).

**Auto-detects signing method.** EIP-3009 `transferWithAuthorization` for all supported EVM networks and native SPL transfer for Solana, all handled internally.

**Works out of the box.** Uses the [RelAI facilitator](https://facilitator.x402.fi) by default.

---

## Examples

Try a live end-to-end flow in the **RelAI Playground**:

- **[RelAI Playground](https://relai.fi/playground)**

---

## Quick Start

### Install

```bash
npm install @relai-fi/x402
```

### Client (Browser / Node.js)

```typescript
import { createX402Client } from '@relai-fi/x402/client';

const client = createX402Client({
  wallets: {
    solana: solanaWallet,  // @solana/wallet-adapter compatible
    evm: evmWallet,        // wagmi/viem compatible
  },
  preferredNetwork: 'base',
  // default: 'prefer_then_any'
  // - prefer_then_any: try preferred network, then any payable wallet/network
  // - strict_preferred: fail if preferred network isn't payable with connected wallets
  networkSelectionMode: 'prefer_then_any',
  integritas: {
    enabled: true,
    flow: 'single', // or 'dual'
  },
  relayWs: {
    enabled: true,
    // optional: explicit WS endpoint
    // wsUrl: 'wss://api.relai.fi/api/ws/relay',
  },
});

// 402 responses are handled automatically
const response = await client.fetch('https://api.example.com/protected');
const data = await response.json();
```

### Preferred network behavior

If the 402 challenge contains multiple `accepts` networks:

- `networkSelectionMode: 'prefer_then_any'` (**default**) tries `preferredNetwork` first, then falls back to any payable option.
- `networkSelectionMode: 'strict_preferred'` only allows the preferred network and throws if it's not payable with connected wallets.

```typescript
const client = createX402Client({
  wallets: { evm: evmWallet },
  preferredNetwork: 'solana',
  networkSelectionMode: 'strict_preferred',
});

// Throws if only Solana accept is preferred but no Solana wallet is connected.
await client.fetch('https://api.example.com/protected');
```

### Integritas (client)

`createX402Client` can set Integritas headers automatically for every request.

```typescript
const client = createX402Client({
  wallets: { evm: evmWallet },
  integritas: {
    enabled: true,
    flow: 'single',
  },
});

// Sends:
// X-Integritas: true
// X-Integritas-Flow: single
await client.fetch('https://api.relai.fi/relay/<apiId>/v1/chat/completions');

// Per-request override
await client.fetch('https://api.relai.fi/relay/<apiId>/v1/chat/completions', {
  method: 'POST',
  x402: {
    integritas: { enabled: true, flow: 'dual' },
  },
});
```

### AI Agents

Use `defaultHeaders` to attach agent identity headers to every request — no need to set them manually on each call.

```typescript
import { createX402Client } from '@relai-fi/x402/client';
import { Keypair } from '@solana/web3.js';

// Agent wallet (e.g. loaded from env or key management)
const keypair = Keypair.fromSecretKey(Buffer.from(process.env.AGENT_PRIVATE_KEY!, 'base64'));

const agentWallet = {
  publicKey: keypair.publicKey,
  signTransaction: async (tx: any) => {
    tx.sign([keypair]);
    return tx;
  },
};

const client = createX402Client({
  wallets: { solana: agentWallet },
  preferredNetwork: 'solana',
  // Attach agent identity headers to every request automatically
  defaultHeaders: {
    'X-Service-Key': process.env.RELAI_SERVICE_KEY!,  // RelAI Service Key
    'X-Agent-ID': process.env.AGENT_ID!,              // Your agent identifier
  },
});

// Agent calls a paid API — payment + identity headers are handled automatically
const response = await client.fetch('https://api.relai.fi/relay/<apiId>/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'Summarize the latest market news.' }],
  }),
});

const result = await response.json();
```

> **Tip:** `defaultHeaders` are merged with per-request headers. Per-request headers always win, so you can override them on individual calls when needed.

---

### Crossmint Smart Wallet (server-side / agent)

Use `createCrossmintX402Fetch` from `@relai-fi/x402/crossmint` — no `signTransaction` needed, Crossmint handles signing and broadcasting.

```typescript
import { createCrossmintX402Fetch } from '@relai-fi/x402/crossmint';
import { Connection } from '@solana/web3.js';

const fetch402 = createCrossmintX402Fetch({
  apiKey: process.env.CROSSMINT_API_KEY!,   // sk_production_... or sk_staging_...
  wallet: process.env.CROSSMINT_WALLET!,    // Crossmint smart wallet address
  connection: new Connection(process.env.SOLANA_RPC_URL!),
  onPayment: (txHash) => console.log('On-chain tx:', txHash),
});

// RelAI sponsors SOL gas — wallet only needs USDC
const response = await fetch402('https://api.example.com/protected');
const data = await response.json();
```

For agents that require explicit transaction approval before Crossmint broadcasts, use the **delegated mode** — an external Ed25519 signer must be registered on the Crossmint smart wallet:

```typescript
import { createCrossmintDelegatedX402Fetch } from '@relai-fi/x402/crossmint';
import { Connection } from '@solana/web3.js';

const fetch402 = createCrossmintDelegatedX402Fetch({
  apiKey: process.env.CROSSMINT_API_KEY!,
  wallet: process.env.CROSSMINT_WALLET!,
  signerSecretKey: Buffer.from(process.env.SIGNER_SECRET_KEY!, 'base64'), // 64-byte Ed25519
  connection: new Connection(process.env.SOLANA_RPC_URL!),
});

const response = await fetch402('https://api.example.com/protected');
```

> Both modes use Crossmint's API to sign and broadcast — no private key handling in your code.

---

### WebSocket relay transport (optional)

If your protected API is behind a relay URL like `https://api.relai.fi/relay/:apiId/...`
or a whitelabel relay URL like `https://<whitelabel>.x402.fi/...`,
the SDK can use the Relay WebSocket transport automatically.

```typescript
const client = createX402Client({
  wallets: {
    evm: evmWallet,
  },
  relayWs: {
    enabled: true,
    preflightTimeoutMs: 5000,
    paymentTimeoutMs: 10000,
    fallbackToHttp: true,
  },
});

// Pass your standard relay HTTP URL (apiId-based or whitelabel-based).
// SDK handles WS preflight + paid retry internally.
await client.fetch('https://api.relai.fi/relay/1769629274857/v1/chat/completions', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ messages: [{ role: 'user', content: 'Hello' }] }),
});

// Whitelabel relay URL is also supported.
await client.fetch('https://tgmetrics.x402.fi/projects?page=1', {
  method: 'GET',
});
```

For Node.js runtimes without global `WebSocket`, provide `relayWs.webSocketFactory`.

If the relay returns multiple `accepts` options for one request, the SDK automatically
falls back to standard HTTP x402 flow for that call.

### React Hook

Works with [`@solana/wallet-adapter-react`](https://github.com/anza-xyz/wallet-adapter) and [`wagmi`](https://wagmi.sh/):

```tsx
import { useRelaiPayment } from '@relai-fi/x402/react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useAccount, useSignTypedData } from 'wagmi';

function PayButton() {
  const solanaWallet = useWallet();
  const { address } = useAccount();
  const { signTypedDataAsync } = useSignTypedData();

  const {
    fetch,
    isLoading,
    status,
    transactionUrl,
    transactionNetworkLabel,
  } = useRelaiPayment({
    wallets: {
      solana: solanaWallet,
      evm: address ? { address, signTypedData: signTypedDataAsync } : undefined,
    },
  });

  return (
    <div>
      <button onClick={() => fetch('/api/protected')} disabled={isLoading}>
        {isLoading ? 'Paying...' : 'Access API'}
      </button>
      {transactionUrl && (
        <a href={transactionUrl} target="_blank">
          View on {transactionNetworkLabel}
        </a>
      )}
    </div>
  );
}
```

---

## Supported Networks

| Network | Identifier | CAIP-2 | Signing Method | USDC Contract |
|---------|-----------|--------|----------------|---------------|
| **Solana** | `solana` | `solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp` | SPL transfer + fee payer | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| **Base** | `base` | `eip155:8453` | EIP-3009 transferWithAuthorization | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` |
| **Avalanche** | `avalanche` | `eip155:43114` | EIP-3009 transferWithAuthorization | `0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E` |
| **SKALE Base** | `skale-base` | `eip155:1187947933` | EIP-3009 transferWithAuthorization | `0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20` |
| **SKALE Base Sepolia** | `skale-base-sepolia` | `eip155:324705682` | EIP-3009 transferWithAuthorization | `0x2e08028E3C4c2356572E096d8EF835cD5C6030bD` |
| **SKALE BITE** | `skale-bite` | `eip155:103698795` | EIP-3009 transferWithAuthorization | `0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8` |
| **Polygon** | `polygon` | `eip155:137` | EIP-3009 transferWithAuthorization | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` |
| **Ethereum** | `ethereum` | `eip155:1` | EIP-3009 transferWithAuthorization | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` |

All networks support **USDC** (6 decimals). On SKALE Base networks, the SDK also supports:

- **SKALE Base (`skale-base`)**: USDT (`0x2bF5bF154b515EaA82C31a65ec11554fF5aF7fCA`), WBTC (`0x1aeeCFE5454c83B42D8A316246CAc9739E7f690e`), WETH (`0x7bD39ABBd0Dd13103542cAe3276C7fA332bCA486`)
- **SKALE Base Sepolia (`skale-base-sepolia`)**: USDT (`0x3ca0a49f511c2c89c4dcbbf1731120d8919050bf`), WBTC (`0x4512eacd4186b025186e1cf6cc0d89497c530e87`), WETH (`0xf94056bd7f6965db3757e1b145f200b7346b4fc0`)

Gas fees are sponsored by the RelAI facilitator.

---

## Package Exports

```typescript
// Client — browser & Node.js fetch wrapper with automatic 402 handling
import { createX402Client } from '@relai-fi/x402/client';

// React hook — state management + wallet integration
import { useRelaiPayment } from '@relai-fi/x402/react';

// Server — Express middleware for protecting endpoints
import Relai from '@relai-fi/x402/server';

// Utilities — payload conversion, unit helpers
import {
  convertV1ToV2,
  convertV2ToV1,
  networkV1ToV2,
  networkV2ToV1,
  toAtomicUnits,
  fromAtomicUnits,
} from '@relai-fi/x402/utils';

// Plugins — extend protect() with built-in & custom logic
import { freeTier, bridge, shield, preflight, circuitBreaker, refund } from '@relai-fi/x402/plugins';

// Management API — create/manage APIs, pricing, analytics, agent bootstrap
import {
  createManagementClient,
  bootstrapAgentKeySolana,
  bootstrapAgentKeyEvm,
} from '@relai-fi/x402/management';

// Types & constants
import {
  RELAI_NETWORKS,
  CHAIN_IDS,
  USDC_ADDRESSES,
  NETWORK_CAIP2,
  EXPLORER_TX_URL,
  type RelaiNetwork,
  type SolanaWallet,
  type EvmWallet,
  type WalletSet,
} from '@relai-fi/x402';
```

---

## API Reference

### `createX402Client(config)`

Creates a fetch wrapper that automatically handles 402 Payment Required responses.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `wallets` | `{ solana?, evm? }` | `{}` | Wallet adapters for each chain |
| `relayWs` | `X402RelayWsConfig` | `undefined` | Optional WS transport for relay URLs |
| `integritas` | `boolean \| X402IntegritasConfig` | `undefined` | Automatically set Integritas headers |
| `facilitatorUrl` | `string` | RelAI facilitator | Custom facilitator endpoint |
| `preferredNetwork` | `RelaiNetwork` | — | Prefer this network when multiple `accepts` |
| `networkSelectionMode` | `'prefer_then_any' \| 'strict_preferred'` | `'prefer_then_any'` | Selection policy for `preferredNetwork` when multiple `accepts` are returned |
| `solanaRpcUrl` | `string` | `https://api.mainnet-beta.solana.com` | Solana RPC (use Helius/Quicknode for production) |
| `evmRpcUrls` | `Record<string, string>` | Built-in defaults | RPC URLs per network name |
| `maxAmountAtomic` | `string` | — | Safety cap on payment amount |
| `verbose` | `boolean` | `false` | Log payment flow to console |
| `defaultHeaders` | `Record<string, string>` | `{}` | Headers added to every request (e.g. `X-Service-Key`, `X-Agent-ID`) |

**`integritas` options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `true` when object is provided | Adds `X-Integritas: true` |
| `flow` | `'single' \| 'dual'` | — | Adds `X-Integritas-Flow` |

**`relayWs` options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `enabled` | `boolean` | `false` | Enable WS transport for relay URLs |
| `wsUrl` | `string` | derived from relay host | Explicit WebSocket relay endpoint |
| `preflightTimeoutMs` | `number` | `5000` | Timeout for WS preflight request |
| `paymentTimeoutMs` | `number` | `10000` | Timeout for paid WS retry |
| `fallbackToHttp` | `boolean` | `true` | Fall back to standard HTTP flow if WS fails |
| `webSocketFactory` | `(url) => WebSocketLike` | runtime WebSocket | Custom WS factory for Node.js/server runtimes |

**Wallet interfaces:**

```typescript
// Solana — compatible with @solana/wallet-adapter-react useWallet()
interface SolanaWallet {
  publicKey: { toString(): string } | null;
  signTransaction: ((tx: unknown) => Promise<unknown>) | null;
}

// EVM — pass address + signTypedData from wagmi
interface EvmWallet {
  address: string;
  signTypedData: (params: {
    domain: Record<string, unknown>;
    types: Record<string, unknown[]>;
    message: Record<string, unknown>;
    primaryType: string;
  }) => Promise<string>;
}
```

---

### `useRelaiPayment(config)`

React hook wrapping `createX402Client` with state management.

**Config** — same as `createX402Client` (see above).

**Returns:**

| Property | Type | Description |
|----------|------|-------------|
| `fetch` | `(input, init?) => Promise<Response>` | Payment-aware fetch |
| `isLoading` | `boolean` | Payment in progress |
| `status` | `'idle' \| 'pending' \| 'success' \| 'error'` | Current state |
| `error` | `Error \| null` | Error details on failure |
| `transactionId` | `string \| null` | Tx hash/signature on success |
| `transactionNetwork` | `RelaiNetwork \| null` | Network used for payment |
| `transactionNetworkLabel` | `string \| null` | Human-readable label (e.g. "Base") |
| `transactionUrl` | `string \| null` | Block explorer link |
| `connectedChains` | `{ solana: boolean, evm: boolean }` | Which wallets are connected |
| `isConnected` | `boolean` | Any wallet connected |
| `reset` | `() => void` | Reset state to idle |

---

### Server SDK (Express)

```typescript
import Relai from '@relai-fi/x402/server';

const relai = new Relai({
  network: 'base', // or 'solana', 'avalanche', 'skale-base', 'skale-base-sepolia', ...
});

// Protect any Express route with micropayments
app.get('/api/data', relai.protect({
  payTo: '0xYourWallet',
  price: 0.01,  // $0.01 USDC
  description: 'Premium data access',
  integritas: {
    enabled: true,
    flow: 'single',
  },
}), (req, res) => {
  // req.payment = { verified, transactionId, payer, network, amount }
  res.json({ data: 'Protected content', payment: req.payment });
});

// Dynamic pricing
app.get('/api/premium', relai.protect({
  payTo: '0xYourWallet',
  price: (req) => req.query.tier === 'pro' ? 0.10 : 0.01,
}), handler);

// Per-endpoint network override
app.get('/api/solana-data', relai.protect({
  payTo: 'SolanaWalletAddress',
  price: 0.005,
  network: 'solana', // overrides the default 'base'
}), handler);
```

**Flow:**
1. Request without payment → 402 with `accepts` array
2. Client signs payment (SDK handles this) → retries with `X-PAYMENT` header
3. Server calls RelAI facilitator `/settle` → gas sponsored by RelAI
4. Settlement success → `PAYMENT-RESPONSE` header set, `req.payment` populated, `next()` called

**Integritas on server protect:**

- `integritas: true` enables Integritas metadata for the endpoint.
- `integritas: { enabled: true, flow: 'single' }` sets default flow.
- Buyer headers (`X-Integritas`, `X-Integritas-Flow`) override defaults per request.

**`req.payment` fields:**
| Field | Type | Description |
|-------|------|-------------|
| `verified` | `boolean` | Always `true` after settlement |
| `transactionId` | `string` | On-chain transaction hash |
| `payer` | `string` | Payer wallet address |
| `network` | `string` | Network name (e.g., `base`) |
| `amount` | `number` | Price in USD |

---

## Plugins

Extend `Relai.protect()` with plugins that hook into the payment lifecycle. Six built-in plugins ship with the SDK:

```typescript
import { freeTier, bridge, shield, preflight, circuitBreaker, refund } from '@relai-fi/x402/plugins';
```

| Plugin | Purpose | Hook |
|--------|---------|------|
| **freeTier** | Free API calls before payment | `beforePaymentCheck` → `skip` |
| **bridge** | Cross-chain payments (Solana ↔ SKALE ↔ Base) | `enrich402Response` |
| **shield** | Global service health check before payment | `beforePaymentCheck` → `reject` |
| **preflight** | Per-endpoint liveness probe before payment | `beforePaymentCheck` → `reject` |
| **circuitBreaker** | Failure history tracking, auto-open circuit | `beforePaymentCheck` → `reject` + `afterSettled` |
| **refund** | Auto-credit buyers when paid requests fail | `beforePaymentCheck` → `skip` + `afterSettled` |

### Free Tier Plugin

Allow buyers to make free API calls before requiring x402 payment. Usage is tracked per buyer (by JWT `sub`, wallet address, or IP) with optional global caps and periodic resets.

```typescript
import Relai from '@relai-fi/x402/server';
import { freeTier } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  plugins: [
    freeTier({
      serviceKey: process.env.RELAI_SERVICE_KEY!,
      perBuyerLimit: 10,        // 10 free calls per buyer
      resetPeriod: 'daily',     // reset daily (or 'monthly', 'never')
      globalCap: 1000,          // optional: max 1000 free calls total
      paths: ['*'],             // optional: apply to all endpoints (default)
    }),
  ],
});

app.get('/api/data', relai.protect({
  payTo: '0xYourWallet',
  price: 0.01,
}), (req, res) => {
  if (req.x402Free) {
    // Free tier call — no payment was made
    console.log('Free call from:', req.x402Plugin);
  }
  res.json({ data: 'content' });
});
```

**How it works:**
1. On server start, the plugin syncs its config to the RelAI backend via your service key.
2. On each request, `beforePaymentCheck` asks the RelAI API if the buyer has free calls remaining.
3. If free → `next()` is called without payment, `req.x402Free = true`, and usage is recorded.
4. If exhausted → normal x402 payment flow continues.

**Config:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serviceKey` | `string` | — | Your `sk_live_...` key. Omit for local in-memory mode. |
| `perBuyerLimit` | `number` | **required** | Free calls each buyer gets per period |
| `resetPeriod` | `'none' \| 'daily' \| 'monthly'` | `'none'` | When counters reset |
| `globalCap` | `number` | — | Max total free calls across all buyers |
| `paths` | `string[]` | `['*']` | Which endpoints the free tier applies to |

**Request properties set on free-tier bypass:**

| Property | Type | Description |
|----------|------|-------------|
| `req.x402Free` | `boolean` | `true` when request was served for free |
| `req.x402Paid` | `boolean` | `false` on free tier, `true` on paid |
| `req.x402Plugin` | `string` | Plugin name that granted the bypass (`'freeTier'`) |
| `req.pluginMeta` | `object` | `{ freeTier: true, remaining: number }` |

### Bridge Plugin

Accept cross-chain payments. Buyers on Solana can pay your SKALE Base API — the SDK handles bridging automatically.

```typescript
import Relai from '@relai-fi/x402/server';
import { bridge } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'skale-bite',
  plugins: [
    bridge({ serviceKey: process.env.RELAI_SERVICE_KEY }),
  ],
});
```

The plugin auto-discovers bridge capabilities from `/bridge/info`. No manual chain configuration needed.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `serviceKey` | `string` | — | Recommended. Tracks bridge usage in dashboard. |
| `settleEndpoint` | `string` | `/bridge/settle` | Custom settle endpoint |
| `feeBps` | `number` | `100` | Bridge fee in basis points (100 = 1%) |

### Shield Plugin

Global service health check — protects buyers from paying for unhealthy endpoints. Before the server returns 402, Shield runs a health check. If unhealthy, returns 503 instead of asking for payment.

```typescript
import Relai from '@relai-fi/x402/server';
import { shield } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  plugins: [
    shield({
      healthUrl: 'https://my-api.com/health',
      timeoutMs: 3000,
    }),
    // Or use a custom function:
    // shield({
    //   healthCheck: async () => {
    //     const dbOk = await checkDatabase();
    //     return dbOk;
    //   },
    // }),
  ],
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `healthUrl` | `string` | — | URL to probe. 2xx = healthy. |
| `healthCheck` | `() => boolean \| Promise<boolean>` | — | Custom function. Takes priority over `healthUrl`. |
| `timeoutMs` | `number` | `5000` | Timeout for health probe (ms) |
| `cacheTtlMs` | `number` | `10000` | Cache health result (ms) |
| `unhealthyStatus` | `number` | `503` | HTTP status when unhealthy |
| `unhealthyMessage` | `string` | `Service temporarily unavailable...` | Error message |

**Response headers:** `X-Shield-Status: healthy|unhealthy`, `Retry-After` (when unhealthy).

### Preflight Plugin

Per-endpoint liveness probe — verifies the **specific endpoint** responds before payment. Sends `HEAD` with `X-Preflight: true` header; the middleware responds 200 instantly without triggering payment.

```typescript
import Relai from '@relai-fi/x402/server';
import { preflight } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  plugins: [
    preflight({ baseUrl: 'https://my-api.com' }),
  ],
});

// If /api/data doesn't respond, buyers get 503 — never 402
app.get('/api/data', relai.protect({
  payTo: '0xYourWallet',
  price: 0.01,
}), handler);
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `baseUrl` | `string` | **required** | Base URL of the API. Request path is appended automatically. |
| `timeoutMs` | `number` | `3000` | Timeout for probe (ms) |
| `cacheTtlMs` | `number` | `5000` | Cache per-path result (ms) |
| `unhealthyStatus` | `number` | `503` | HTTP status when unreachable |
| `unhealthyMessage` | `string` | `Endpoint not responding...` | Error message |

**Response headers:** `X-Preflight-Status: ok|unreachable`, `Retry-After` (when unreachable).

**Shield vs Preflight:**

| | Shield | Preflight |
|---|--------|-----------|
| Scope | Global service health | Per-endpoint liveness |
| Probe target | Separate health URL / function | The actual protected endpoint |
| Cache | Single result (10s) | Per-path (5s) |
| Use case | DB/Redis/external API down | Specific endpoint not responding |

### Circuit Breaker Plugin

Tracks failure history and automatically "opens the circuit" after repeated failures — preventing buyers from paying for broken endpoints. **Zero-latency** — no extra HTTP requests.

```typescript
import Relai from '@relai-fi/x402/server';
import { circuitBreaker } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  plugins: [
    circuitBreaker({
      failureThreshold: 5,  // open after 5 failures
      resetTimeMs: 30000,   // try again after 30s
    }),
  ],
});
```

**States:** closed (normal) → open (all rejected 503) → half-open (test requests) → closed.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `failureThreshold` | `number` | `5` | Consecutive failures before circuit opens |
| `resetTimeMs` | `number` | `30000` | Time (ms) circuit stays open before half-open |
| `halfOpenSuccesses` | `number` | `2` | Successes needed in half-open to close |
| `openStatus` | `number` | `503` | HTTP status when circuit is open |
| `openMessage` | `string` | `Service temporarily unavailable...` | Error message |
| `failureCodes` | `number[]` | `[500, 502, 503, 504]` | HTTP codes treated as failures |
| `scope` | `'global' \| 'per-path'` | `'per-path'` | Track globally or per endpoint |

**Response headers:** `X-Circuit-State: closed|open|half-open`, `Retry-After` (when open).

### Refund Plugin

Automatically compensates buyers when paid requests fail. Records an in-memory credit or calls your custom handler.

```typescript
import Relai from '@relai-fi/x402/server';
import { refund } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  plugins: [
    refund({
      triggerCodes: [500, 502, 503],
      mode: 'credit',
      onRefund: (event) => {
        console.log(`Refund: $${event.amount} to ${event.payer}`);
      },
    }),
  ],
});
```

**Modes:**
- `credit` — records credit per buyer. Next request skips payment automatically. Header: `X-Refund-Credit: applied`.
- `log` — only calls `onRefund`. Handle refunds externally (DB, Stripe, etc.).

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `triggerCodes` | `number[]` | `[500, 502, 503, 504]` | HTTP codes that trigger a refund |
| `mode` | `'credit' \| 'log'` | `'credit'` | Auto-credit or callback-only |
| `onRefund` | `(event: RefundEvent) => void` | — | Callback on every refund event |
| `refundOnSettlementFailure` | `boolean` | `true` | Also refund when settlement itself fails |

### ERC-8004 Reputation Plugins

Build verifiable on-chain reputation for your API using the [ERC-8004](https://eips.ethereum.org/EIPS/eip-8004) standard. Scores are stored on SKALE Base Sepolia (zero-cost transactions) and readable by any agent before payment.

#### `score()` — Inject reputation into the 402 response

Before an agent pays, it can see your API's live on-chain score in the `extensions.score` field of the 402 response. Fetches directly from the SKALE RPC node — no REST API.

```typescript
import Relai from '@relai-fi/x402/server';
import { score } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  plugins: [
    score({ agentId: process.env.ERC8004_AGENT_ID! }),
  ],
});
```

The 402 response will include:
```json
{
  "extensions": {
    "score": {
      "agentId": "5",
      "feedbackCount": 142,
      "successRate": 98.6,
      "avgResponseMs": 312
    }
  }
}
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | `string \| number` | — | ERC-8004 NFT token ID from your dashboard |
| `rpcUrl` | `string` | `process.env.ERC8004_RPC_URL` | SKALE Base Sepolia RPC URL |
| `identityRegistryAddress` | `string` | `process.env.ERC8004_IDENTITY_REGISTRY` | IdentityRegistry contract address |
| `reputationRegistryAddress` | `string` | `process.env.ERC8004_REPUTATION_REGISTRY` | ReputationRegistry contract address |
| `cacheTtlMs` | `number` | `300000` | Score cache TTL (default: 5 min) |

#### `feedback()` — Record your own API metrics on-chain

Submit `successRate` and `responseTime` after every settled x402 payment. This is what builds the score that `score()` later reads.

```typescript
import Relai from '@relai-fi/x402/server';
import { score, feedback } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  plugins: [
    score({ agentId: process.env.ERC8004_AGENT_ID! }),
    feedback({ agentId: process.env.ERC8004_AGENT_ID! }),
  ],
});
```

Requires `BACKEND_WALLET_PRIVATE_KEY` — the wallet must hold CREDIT tokens on SKALE Base for gas.

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | `string \| number` | — | Your ERC-8004 agent token ID |
| `walletPrivateKey` | `string` | `process.env.BACKEND_WALLET_PRIVATE_KEY` | EVM private key, needs CREDIT on SKALE |
| `rpcUrl` | `string` | `process.env.ERC8004_RPC_URL` | SKALE RPC URL |
| `reputationRegistryAddress` | `string` | `process.env.ERC8004_REPUTATION_REGISTRY` | Contract address |
| `submitSuccessRate` | `boolean` | `true` | Submit 1/0 success signal |
| `submitResponseTime` | `boolean` | `true` | Submit response time in ms |

#### `solanaFeedback()` — Native Solana 8004-solana feedback

For Solana APIs registered via `8004-solana` (MPL Core NFT). Requires `npm install 8004-solana`.

```typescript
import Relai from '@relai-fi/x402/server';
import { solanaFeedback } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'solana',
  plugins: [
    solanaFeedback({
      assetPubkey: process.env.SOLANA_AGENT_ASSET!, // MPL Core NFT address
    }),
  ],
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `assetPubkey` | `string` | — | Solana MPL Core NFT address (`solanaAgentAsset`) |
| `feedbackWalletPrivateKey` | `string` | `process.env.SOLANA_8004_FEEDBACK_KEY` | base58 or JSON array |
| `cluster` | `'mainnet-beta' \| 'devnet'` | `process.env.SOLANA_8004_CLUSTER` | Solana cluster |
| `rpcUrl` | `string` | `process.env.SOLANA_8004_RPC_URL` | Custom RPC (Helius / QuickNode) |

#### `submitRelayFeedback()` — Third-party feedback utility

If your server acts as a **relay or marketplace** that calls other APIs, use this standalone function to record feedback about those APIs. Uses a separate relay wallet to avoid self-feedback restrictions.

```typescript
import { submitRelayFeedback } from '@relai-fi/x402/plugins';

// After calling an external API:
const start = Date.now();
const result = await fetch('https://other-api.com/v1/data');

submitRelayFeedback({
  agentId: '5',                        // target API's ERC-8004 agentId
  success: result.ok,
  responseTimeMs: Date.now() - start,
  endpoint: '/v1/data',
});
```

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `agentId` | `string \| number` | — | ERC-8004 agentId of the API you called |
| `success` | `boolean` | — | Whether the call succeeded |
| `responseTimeMs` | `number` | `0` | Elapsed time in ms |
| `endpoint` | `string` | `''` | Endpoint path |
| `feedbackWalletPrivateKey` | `string` | `process.env.FEEDBACK_WALLET_PRIVATE_KEY` | Must differ from API owner key |

#### Required environment variables (ERC-8004)

```bash
ERC8004_IDENTITY_REGISTRY=0x8724C768547d7fFb1722b13a84F21CCF5010641f
ERC8004_REPUTATION_REGISTRY=0xe946A7F08d1CC0Ed0eC1fC131D0135d9c0Dd7d9D
ERC8004_RPC_URL=https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha
ERC8004_AGENT_ID=5                          # your agent NFT token ID

BACKEND_WALLET_PRIVATE_KEY=0x...            # for feedback() — needs CREDIT on SKALE
FEEDBACK_WALLET_PRIVATE_KEY=0x...           # for submitRelayFeedback() — different wallet

# Solana 8004 (only if using solanaFeedback)
SOLANA_AGENT_ASSET=GH93tGR8...             # MPL Core NFT pubkey
SOLANA_8004_FEEDBACK_KEY=...               # base58 or JSON array
SOLANA_8004_CLUSTER=mainnet-beta
SOLANA_8004_RPC_URL=https://...
```

### Combining Plugins

Plugins run in array order. Combine them for layered protection:

```typescript
const relai = new Relai({
  network: 'base',
  plugins: [
    shield({ healthUrl: 'https://my-api.com/health' }),  // 1. Is the service up?
    preflight({ baseUrl: 'https://my-api.com' }),         // 2. Is this endpoint alive?
    circuitBreaker({ failureThreshold: 5 }),              // 3. Too many recent failures?
    freeTier({ perBuyerLimit: 5, resetPeriod: 'daily' }), // 4. Free calls left?
    refund({ triggerCodes: [500, 502, 503] }),             // 5. Compensate on error
    bridge({ serviceKey: process.env.RELAI_SERVICE_KEY }), // 6. Cross-chain support
    score({ agentId: process.env.ERC8004_AGENT_ID }),      // 7. Show reputation in 402
    feedback({ agentId: process.env.ERC8004_AGENT_ID }),   // 8. Record metrics on-chain
  ],
});
```

### Custom Plugins

```typescript
import type { RelaiPlugin, PluginContext, PluginResult } from '@relai-fi/x402/plugins';

const myPlugin: RelaiPlugin = {
  name: 'my-plugin',

  async beforePaymentCheck(req, ctx) {
    if (req.headers['x-vip'] === 'true') {
      return { skip: true, headers: { 'X-VIP': 'true' } };
    }
    return {};
  },

  async afterSettled(req, result, ctx) {
    console.log(`Paid $${ctx.price} by ${result.payer} on ${ctx.network}`);
  },

  async onInit() {
    console.log('Plugin initialized');
  },
};
```

**Plugin interface:**

```typescript
interface RelaiPlugin {
  name: string;
  beforePaymentCheck?(req: any, ctx: PluginContext): Promise<PluginResult>;
  afterSettled?(req: any, result: SettleResult, ctx: PluginContext): Promise<void>;
  onInit?(): Promise<void>;
  enrich402Response?(response: any, ctx: PluginContext): any;
}

interface PluginResult {
  skip?: boolean;      // Bypass payment, serve content free
  reject?: boolean;    // Block request entirely (e.g. unhealthy)
  rejectStatus?: number;
  rejectMessage?: string;
  headers?: Record<string, string>;
  meta?: Record<string, unknown>;
}

interface PluginContext {
  network: string;
  price: number;
  path: string;
  method: string;
}
```

---

## Management API

Programmatically create and manage monetised APIs, update pricing, and read analytics. Designed for agents and CI/CD — no browser needed.

```typescript
import { createManagementClient } from '@relai-fi/x402/management';

const mgmt = createManagementClient({ serviceKey: process.env.RELAI_SERVICE_KEY! });

// Create a monetised API
const api = await mgmt.createApi({
  name: 'My ML API',
  baseUrl: 'https://inference.example.com',
  merchantWallet: '0xYourWallet',
  network: 'base',
  endpoints: [
    { path: '/v1/predict', method: 'post', usdPrice: 0.05 },
    { path: '/v1/status',  method: 'get',  usdPrice: 0.001 },
  ],
});

// List / get / update / delete
const all   = await mgmt.listApis();
const one   = await mgmt.getApi(api.apiId);
await mgmt.updateApi(api.apiId, { description: 'Updated description' });
await mgmt.deleteApi(api.apiId);

// Pricing
await mgmt.setPricing(api.apiId, [{ path: '/v1/predict', method: 'post', usdPrice: 0.10 }]);
const pricing = await mgmt.getPricing(api.apiId);

// Analytics
const stats    = await mgmt.getStats(api.apiId);
const payments = await mgmt.getPayments(api.apiId, { limit: 20, from: '2025-01-01' });
const logs     = await mgmt.getLogs(api.apiId, { limit: 20 });
```

### Agent self-setup (autonomous key provisioning)

Agents can provision their own service key with zero human involvement — no dashboard, no JWT, no copy-paste. Run once and store the key.

```typescript
import { bootstrapAgentKeySolana, bootstrapAgentKeyEvm } from '@relai-fi/x402/management';
import { Keypair } from '@solana/web3.js';

// Solana agent
const keypair = Keypair.fromSecretKey(Buffer.from(process.env.AGENT_PRIVATE_KEY!, 'base64'));
const { key } = await bootstrapAgentKeySolana(keypair, 'my-agent');
// → key: "sk_live_..."  — store securely, never re-run

// EVM agent (ethers.js Wallet)
import { ethers } from 'ethers';
const wallet = new ethers.Wallet(process.env.AGENT_PRIVATE_KEY!);
const { key: evmKey } = await bootstrapAgentKeyEvm(wallet, 'my-evm-agent');
```

Once you have a service key, combine it with `createX402Client` for a fully autonomous agent:

```typescript
import { createX402Client } from '@relai-fi/x402/client';
import { createManagementClient } from '@relai-fi/x402/management';

const serviceKey = process.env.RELAI_SERVICE_KEY!;

// Pay for APIs
const client = createX402Client({
  wallets: { solana: agentWallet },
  defaultHeaders: { 'X-Service-Key': serviceKey },
});

// Manage APIs
const mgmt = createManagementClient({ serviceKey });
```

---

## x402 Bridge

Bridge USDC between **Solana** and **SKALE Base** using the x402 protocol. The bridge uses a liquidity network model — instant payouts, no canonical bridge delays.

> Requires a service key (`sk_live_...`). Get one via `bootstrapAgentKeySolana` or the RelAI dashboard.

### How it works

```
Agent pays USDC on Solana (x402)
  ↓ facilitator verifies payment
Bridge pays out USDC on SKALE Base from its liquidity pool  ← instant
  ↓ async in background
Rebalance via Circle CCTP restores liquidity
```

### Quick start

```typescript
import { createManagementClient } from '@relai-fi/x402/management';
import { createX402Client } from '@relai-fi/x402/client';
import { Keypair } from '@solana/web3.js';

const serviceKey = process.env.RELAI_SERVICE_KEY!;
const mgmt = createManagementClient({ serviceKey });

// 1. Check liquidity before bridging
const balances = await mgmt.getBridgeBalances();
console.log(`SKALE Base liquidity: $${balances.skaleBase.usd} USDC`);

// 2. Get a quote
const quote = await mgmt.getBridgeQuote(10.0, 'solana');
// { inputUsd: 10, outputUsd: 9.99, feeBps: 10, direction: 'solana-to-skale' }

// 3. Bridge Solana → SKALE Base
const keypair = Keypair.fromSecretKey(Buffer.from(process.env.SOLANA_PRIVATE_KEY!, 'base64'));
const solanaWallet = {
  publicKey: keypair.publicKey,
  signTransaction: async (tx: any) => { tx.sign([keypair]); return tx; },
};

const x402 = createX402Client({
  wallets: { solana: solanaWallet },
  solanaRpcUrl: process.env.SOLANA_RPC_URL,
  defaultHeaders: { 'X-Service-Key': serviceKey },
});

const result = await mgmt.bridgeSolanaToSkale(
  10.0,                    // $10 USDC
  '0xYourSkaleAddress',    // destination EVM address on SKALE Base
  x402,
);
// { success: true, txHash: '0x...', amountOutUsd: 9.99, explorerUrl: '...' }
```

### Bridge SKALE Base → Solana

```typescript
import { ethers } from 'ethers';

const provider = new ethers.JsonRpcProvider(process.env.SKALE_RPC_URL);
const signer = new ethers.Wallet(process.env.EVM_PRIVATE_KEY!, provider);

const evmWallet = {
  address: signer.address,
  signTypedData: (params: any) => signer.signTypedData(
    params.domain, params.types, params.message
  ),
};

const x402 = createX402Client({
  wallets: { evm: evmWallet },
  defaultHeaders: { 'X-Service-Key': serviceKey },
});

const result = await mgmt.bridgeSkaleToSolana(
  5.0,                        // $5 USDC
  'YourSolanaPublicKey',      // destination Solana address (base58)
  x402,
);
// { success: true, txHash: '...', amountOutUsd: 4.995, explorerUrl: '...' }
```

### Bridge API reference

| Method | Description |
|--------|-------------|
| `getBridgeQuote(amount, from?)` | Fee and net output for a given amount |
| `getBridgeBalances()` | Current USDC liquidity on Solana / SKALE Base / Base |
| `bridgeSolanaToSkale(amount, dest, x402Client)` | Bridge Solana → SKALE Base |
| `bridgeSkaleToSolana(amount, dest, x402Client)` | Bridge SKALE Base → Solana |

### Error handling

```typescript
try {
  const result = await mgmt.bridgeSolanaToSkale(100.0, '0x...', x402);
} catch (err) {
  if (err.message.includes('insufficient_liquidity')) {
    // Bridge temporarily unavailable — check balances and retry later
    const { skaleBase } = await mgmt.getBridgeBalances();
    console.log(`Available: $${skaleBase.usd} USDC`);
  }
}
```

**Fee:** 0.1% (10 bps) deducted from output amount. Check `getBridgeQuote` for exact amounts.

**Limits:** min $0.000001, max $10,000 per transaction.

---

## Utilities

```typescript
import { toAtomicUnits, fromAtomicUnits } from '@relai-fi/x402/utils';

toAtomicUnits(0.05, 6);       // '50000'   ($0.05 USDC)
toAtomicUnits(1.50, 6);       // '1500000' ($1.50 USDC)

fromAtomicUnits('50000', 6);  // 0.05
fromAtomicUnits('1500000', 6); // 1.5
```

### Payload Conversion (v1 ↔ v2)

```typescript
import { convertV1ToV2, convertV2ToV1, networkV1ToV2 } from '@relai-fi/x402/utils';

networkV1ToV2('solana');     // 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'
networkV1ToV2('base');       // 'eip155:8453'
networkV1ToV2('avalanche');  // 'eip155:43114'
networkV1ToV2('skale-base'); // 'eip155:1187947933'
networkV1ToV2('skale-base-sepolia'); // 'eip155:324705682'

const v2Payload = convertV1ToV2(v1Payload);
const v1Payload = convertV2ToV1(v2Payload);
```

---

## How It Works

```
Client                        Server                     Facilitator
  |                             |                             |
  |── GET /api/data ──────────>|                             |
  |<── 402 Payment Required ───|                             |
  |   (accepts: network, amount, asset)                      |
  |                             |                             |
  | SDK signs payment           |                             |
  | (EIP-3009/SPL)              |                             |
  |                             |                             |
  |── GET /api/data ──────────>|                             |
  |   X-PAYMENT: <signed>      |── settle ─────────────────>|
  |                             |<── tx hash ────────────────|
  |<── 200 OK + data ─────────|                             |
  |   PAYMENT-RESPONSE: <tx>   |                             |
```

---

## MPP (Machine Payment Protocol)

MPP is an alternative payment channel that works alongside x402. Instead of the client building and signing blockchain transactions, MPP delegates signing to specialized payment providers — simpler client code, same `protect()` middleware on the server.

| | x402 | MPP |
|---|------|-----|
| **Payment flow** | Client builds tx (SPL / EIP-3009), signs, server settles via facilitator | Provider handles signing & broadcasting via challenge-response |
| **Header protocol** | `X-PAYMENT` (base64 JSON) | `WWW-Authenticate: Payment` / `Authorization: Payment` |
| **Supported providers** | — | Tempo (EVM), Solana (`@solana/mpp`), EVM/SKALE (built-in), Stripe |

When both are enabled the server returns a 402 with **both** an MPP challenge (`WWW-Authenticate`) and the standard x402 `accepts` body. The client tries MPP first, then falls back to x402.

---

### MPP Server Setup

#### Tempo (EVM)

```typescript
import express from 'express';
import Relai from '@relai-fi/x402/server';
import { Mppx, tempo } from 'mppx/server';

const TEMPO_USDC = '0x20C000000000000000000000b9537d11c60E8b50';

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    tempo.charge({
      recipient: '0xYourWallet',
      currency: TEMPO_USDC,
      decimals: 6,
    }),
  ],
});

const relai = new Relai({
  network: 'base',
  mpp: mppx,
});

const app = express();

app.get('/api/data', relai.protect({
  payTo: '0xYourWallet',
  price: 0.01,
}), (req, res) => {
  res.json({ data: 'Paid via MPP Tempo or x402' });
});
```

#### Solana (`@solana/mpp`)

`@solana/mpp` expects amounts in **base units** (1 000 000 = 1 USDC), while the SDK passes USD. A thin wrapper with a handler cache is needed:

```typescript
import Relai from '@relai-fi/x402/server';
import { Mppx, solana } from '@solana/mpp/server';

const SOLANA_USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const DECIMALS = 6;

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    solana.charge({
      recipient: 'YourSolanaWallet',
      splToken: SOLANA_USDC,
      decimals: DECIMALS,
      network: 'mainnet-beta',
      rpcUrl: process.env.SOLANA_RPC_URL,
    }),
  ],
});

// Wrap to convert USD → base units and cache handlers (mppx.charge is stateful)
const handlerCache = new Map<string, ReturnType<typeof mppx.charge>>();
const mppSolanaWrapper = {
  charge(params: Record<string, unknown>) {
    const usdAmount = parseFloat(params.amount as string);
    const baseUnits = Math.round(usdAmount * 10 ** DECIMALS).toString();
    if (!handlerCache.has(baseUnits)) {
      handlerCache.set(baseUnits, mppx.charge({ ...params, amount: baseUnits }));
    }
    return handlerCache.get(baseUnits)!;
  },
};

const relai = new Relai({
  network: 'solana',
  mpp: mppSolanaWrapper as any,
});
```

#### EVM — SKALE, Base, Polygon (built-in)

The SDK ships a built-in EVM MPP method that works with any EVM chain. SKALE chains are **gas-free**, making them ideal for zero-cost micropayments. The same USD→base-units wrapper pattern applies:

```typescript
import Relai from '@relai-fi/x402/server';
import { Mppx } from 'mppx/server';
import { evmCharge } from '@relai-fi/x402/mpp/evm-server';

const DECIMALS = 6;

const mppx = Mppx.create({
  secretKey: process.env.MPP_SECRET_KEY!,
  methods: [
    evmCharge({
      recipient: '0xYourWallet',
      tokenAddress: '0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20', // USDC on SKALE Base
      chainId: 1187947933,                                         // SKALE Base
      rpcUrl: 'https://skale-base.skalenodes.com/v1/base',
      decimals: DECIMALS,
      network: 'skale-base',
    }),
  ],
});

// Same wrapper pattern as Solana
const handlerCache = new Map<string, ReturnType<typeof mppx.charge>>();
const mppEvmWrapper = {
  charge(params: Record<string, unknown>) {
    const usdAmount = parseFloat(params.amount as string);
    const baseUnits = Math.round(usdAmount * 10 ** DECIMALS).toString();
    if (!handlerCache.has(baseUnits)) {
      handlerCache.set(baseUnits, mppx.charge({ ...params, amount: baseUnits }));
    }
    return handlerCache.get(baseUnits)!;
  },
};

const relai = new Relai({
  network: 'skale-base',
  mpp: mppEvmWrapper as any,
});
```

---

### MPP Client Setup

#### Tempo (EVM)

```typescript
import { createX402Client } from '@relai-fi/x402/client';
import { Mppx, tempo } from 'mppx/client';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.TEMPO_PRIVATE_KEY as `0x${string}`);

const mppx = Mppx.create({
  methods: [tempo.charge({ account })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    console.log(`Amount: ${challenge.request?.amount}`);
    return await createCredential();
  },
});

const client = createX402Client({ mpp: mppx });
const response = await client.fetch('https://api.example.com/protected');
```

#### Solana

```typescript
import { createX402Client } from '@relai-fi/x402/client';
import { Mppx, solana } from '@solana/mpp/client';
import { createKeyPairSignerFromBytes } from '@solana/kit';
import bs58 from 'bs58';

const signer = await createKeyPairSignerFromBytes(
  new Uint8Array(bs58.decode(process.env.SOLANA_PRIVATE_KEY!))
);

const mppx = Mppx.create({
  methods: [solana.charge({ signer })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    console.log(`Amount: ${challenge.request?.amount}`);
    return await createCredential();
  },
});

const client = createX402Client({ mpp: mppx });
const response = await client.fetch('https://api.example.com/protected');
```

#### EVM — SKALE, Base, Polygon (built-in)

```typescript
import { createX402Client } from '@relai-fi/x402/client';
import { Mppx } from 'mppx/client';
import { evmCharge } from '@relai-fi/x402/mpp/evm-client';
import { privateKeyToAccount } from 'viem/accounts';

const account = privateKeyToAccount(process.env.EVM_PRIVATE_KEY as `0x${string}`);

const mppx = Mppx.create({
  methods: [evmCharge({ account })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    const req = challenge.request as any;
    console.log(`Chain: ${req?.methodDetails?.network}, Amount: ${req?.amount}`);
    return await createCredential();
  },
});

const client = createX402Client({ mpp: mppx });
const response = await client.fetch('https://api.example.com/protected');
```

---

### MPP + Plugins

All existing plugins work with MPP payments. `afterSettled` fires on both success and failure for both x402 and MPP:

```typescript
import { freeTier, shield, circuitBreaker, refund } from '@relai-fi/x402/plugins';

const relai = new Relai({
  network: 'base',
  mpp: mppx,
  plugins: [
    shield({ healthUrl: 'https://my-api.com/health' }),
    circuitBreaker({ failureThreshold: 5 }),
    freeTier({ perBuyerLimit: 5, resetPeriod: 'daily' }),
    refund({ triggerCodes: [500, 502, 503] }),
  ],
});
```

### MPP API Reference

**Server — `MppServerHandler`**

```typescript
interface MppServerHandler {
  charge(params: Record<string, unknown>): (request: Request) => Promise<MppChargeResult>;
}

type MppChargeResult = {
  status: number;
  challenge?: Response;                            // 402 with WWW-Authenticate header
  withReceipt?: (response: Response) => Response;  // Attaches Payment-Receipt header
  receipt?: { method?: string; reference?: string; status?: string };
};
```

**Client — `MppHandler`**

```typescript
interface MppHandler {
  createCredential(response: Response): Promise<string>;
}
```

Both interfaces are exported from `@relai-fi/x402`.

---

## Development

```bash
npm run build        # Build ESM + CJS bundles
npm run dev          # Watch mode
npm run type-check   # TypeScript checks
npm test             # Run tests
```

---

## License

MIT

---

<p align="center">
  <a href="https://facilitator.x402.fi">RelAI Facilitator</a> · 
  <a href="https://relai.fi">Marketplace</a> ·
  <a href="https://github.com/web3luka/relai-sdk">GitHub</a>
</p>
