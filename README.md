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

## Configuration

### Server SDK Options

```typescript
interface RelaiConfig {
  apiKey: string;                      // Required: Your RelayAI API key
  network?: 'solana' | 'solana-devnet'; // Optional: Network to use
  facilitatorUrl?: string;              // Optional: Custom facilitator URL
  apiBaseUrl?: string;                  // Optional: Custom API base URL
}
```

### Protection Options

```typescript
interface ProtectOptions {
  price: number;                        // Required: Price in USD
  description?: string;                 // Optional: Endpoint description
  maxTimeout?: number;                  // Optional: Payment verification timeout
  customRules?: (req: any) => Promise<boolean>; // Optional: Custom validation
}
```

## Features

- **One-Line Integration**: Add payment gates with a single middleware
- **Framework Agnostic**: Works with Express, Next.js, and more
- **Type Safe**: Full TypeScript support
- **x402 Protocol**: Built on the x402 micropayment standard
- **Zero Gas Fees**: Users don't pay blockchain gas fees

## API Reference

### Server SDK

#### `new Relai(config)`

Creates a new RelayAI server instance.

#### `relai.protect(options)`

Returns Express middleware that protects an endpoint with micropayment verification.

#### `relai.getStats(apiId?)`

Get payment statistics for your APIs.

#### `relai.createProtectedEndpoint(options)`

Alias for `relai.protect()`.

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

#### `client.fetch(url, options?)` *(deprecated)*

Legacy helper that proxies to `axios(url, options)`. Prefer `client.useApi(apiId).call()` for paid marketplace APIs.

## Examples

### Express.js

```typescript
import express from 'express';
import Relai from 'relai-sdk/server';

const app = express();
const relai = new Relai({ apiKey: process.env.RELAI_API_KEY });

app.use(express.json());

// Public endpoint
app.get('/api/public', (req, res) => {
  res.json({ message: 'This is free!' });
});

// Protected endpoint
app.post('/api/chat',
  relai.protect({
    price: 0.01,
    description: 'AI Chat Response'
  }),
  async (req, res) => {
    const response = await chatAI(req.body.message);
    res.json({ response });
  }
);

app.listen(3000);
```

### Next.js API Route

```typescript
// pages/api/chat.ts
import { NextApiRequest, NextApiResponse } from 'next';
import Relai from 'relai-sdk/server';

const relai = new Relai({ apiKey: process.env.RELAI_API_KEY });

export default relai.protect({ price: 0.01 })(
  async (req: NextApiRequest, res: NextApiResponse) => {
    const response = await chatAI(req.body.message);
    res.status(200).json({ response });
  }
);
```

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
