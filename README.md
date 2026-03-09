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
