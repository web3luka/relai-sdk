# relai-sdk

Official SDK for RelayAI - Monetize any API endpoint with x402 micropayments.

## Installation

```bash
npm install relai-sdk
```

## Quick Start

```bash
npm install relai-sdk
```

## Get Your API ID

**RelayAI API ID:**
- Browse the [RelayAI marketplace](https://relai.fi)
- Find an API you want to use
- Copy the `apiId` from the API details page

No registration or API keys required for using existing APIs!

## Client-Side Usage

```typescript
import { RelaiClient } from 'relai-sdk/client';

const client = new RelaiClient({
  // Optional: override defaults
  baseUrl: 'https://relai.fi',          // RelayAI backend base URL
  network: 'solana',                    // or 'solana-devnet'
  rpcUrl: 'https://api.mainnet-beta.solana.com',

  // Required: wallet used to sign x402 payments
  wallet: {
    address: publicKey.toString(),
    signTransaction: async (tx) => await signTransaction(tx),
  },

  // Optional: safety limit for a single payment (in lamports)
  maxPaymentAmount: BigInt(10_000_000),
});

// Get API instance using apiId from RelayAI dashboard / marketplace
const api = client.useApi('1762961727264');

// Call API endpoint with automatic x402 payment handling
const response = await api.call({
  path: '/api/Public/askstreaming',
  method: 'POST',
  body: { prompt: 'Hello world' },
});

console.log(response.data);
```

## Features

- **One-Line Integration**: Add payment gates with a single middleware
- **Framework Agnostic**: Works with Express, Next.js, and more
- **Type Safe**: Full TypeScript support
- **x402 Protocol**: Built on the x402 micropayment standard
- **Zero Gas Fees**: Users don't pay blockchain gas fees

## API Reference

### Client SDK

#### `new RelaiClient(config?)`

Creates a new RelayAI client instance.

```ts
interface RelaiClientConfig {
  baseUrl?: string;
  network?: 'solana' | 'solana-devnet';
  rpcUrl?: string;
  maxPaymentAmount?: bigint;
  wallet?: {
    address: string;
    signTransaction: (tx: any) => Promise<any>;
  };
  requestTimeoutMs?: number;

  // Optional hooks
  onPaymentRequired?: (info: { price: number; description?: string; network?: string }) => void;
  onPaymentVerified?: (info: { signature: string; price: number }) => void;
  onError?: (error: unknown) => void;
}
```

#### `client.useApi(apiId)`

Returns a lightweight API helper bound to a specific `apiId` from RelayAI marketplace.

```ts
const api = client.useApi(apiId);

const response = await api.call({
  path: '/api/your-endpoint',
  method: 'GET',
  body: { foo: 'bar' },
});
```

## Examples

### Client Usage

```typescript
import { RelaiClient } from 'relai-sdk/client';

const client = new RelaiClient({
  baseUrl: 'https://relai.fi',
  network: 'solana',
  wallet: {
    address: publicKey.toString(),
    signTransaction: async (tx) => await signTransaction(tx),
  },
});

// Use apiId from RelayAI dashboard / marketplace
const api = client.useApi('<your-api-id>');

const response = await api.call({
  path: '/api/your-endpoint',
  method: 'POST',
  body: { message: 'Hello!' },
});

console.log(response.data);
```

## License

MIT
