# SKALE BITE x402 Payment Test

Standalone Next.js app to test x402 payments on SKALE BITE V2 Sandbox using `@relai-fi/x402` SDK.

## What This Demonstrates

- Backend API protection with `Relai.protect()` middleware
- Frontend payment flow with `createX402Client()`
- EIP-3009 `transferWithAuthorization` for gasless payments (no approve needed)
- BITE encrypted transactions for MEV protection
- Full integration with RelAI facilitator on SKALE BITE

## Quick Start

### 1. Install Dependencies

```bash
npm install
```

### 2. Configure Environment

```bash
cp .env.example .env
```

Edit `.env`:
```env
MERCHANT_WALLET=0xYourWalletAddress  # Where you receive payments
FACILITATOR_URL=https://facilitator.x402.fi  # RelAI facilitator (default)
```

### 3. Run Development Server

```bash
npm run dev
```

Open http://localhost:3000

## Testing Flow

### Step 1: Connect Wallet
- Click "Connect Wallet"
- MetaMask will prompt to add/switch to SKALE BITE network
- Approve the network addition

### Step 2: Get Test Tokens

**sFUEL (Gas Token)**
- Visit: https://sfuel.skale.network/
- Enter your wallet address
- Get free sFUEL for gas

**USDC (Payment Token)**
- Contact RelAI team for test USDC
- Or use the included script: `npm run send-usdc` (requires backend wallet with USDC)

### Step 3: Approve Facilitator (One-time)
- Click "Approve USDC"
- Confirm transaction in MetaMask
- This allows RelAI facilitator to execute payments on your behalf
- **Only needed once per wallet**

### Step 4: Make Payment
- Click "Pay & Access Premium API"
- Sign the payment authorization in MetaMask (no gas!)
- Receive premium content

## Network Details

| Parameter | Value |
|-----------|-------|
| **Network** | SKALE BITE V2 Sandbox |
| **Chain ID** | 103698795 |
| **RPC URL** | https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox |
| **Explorer** | https://base-sepolia-testnet-explorer.skalenodes.com:10032 |
| **USDC Contract** | `0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8` |
| **RelAI Facilitator** | `0x1892f72fdB3A966b2AD8595aA5f7741Ef72d6085` |
| **Gas Token** | sFUEL (free) |

## How It Works

### Backend (`/api/premium/route.ts`)

```typescript
import Relai from '@relai-fi/x402/server';

const relai = new Relai({
  network: 'skale-bite',
  facilitatorUrl: 'https://facilitator.x402.fi',
});

export async function GET(req: NextRequest) {
  return relai.protect({
    payTo: process.env.MERCHANT_WALLET,
    price: 0.01, // $0.01 USD
    description: 'Premium API access',
  })(req, res, next);
}
```

### Frontend (`/page.tsx`)

```typescript
import { createX402Client } from '@relai-fi/x402/client';

// 1. Create x402 client
const client = createX402Client({
  wallets: { evm: { address, signTypedData } },
  facilitatorUrl: 'https://facilitator.x402.fi',
});

// 2. Make payment automatically (no approve needed!)
const response = await client.fetch('/api/premium');
```

## Key Features

✅ **Gasless Payments** - Users only sign, no gas fees  
✅ **EIP-3009 Standard** - Secure `transferWithAuthorization` (no approve needed)  
✅ **BITE Encrypted** - MEV protection on SKALE chains  
✅ **Auto-Detection** - SDK automatically handles everything  
✅ **Full Type Safety** - TypeScript support throughout  

## Why No Approve Is Needed

EIP-3009 `transferWithAuthorization` is **fundamentally different** from standard ERC-20 transfers:

1. **Direct Authorization** - User signs a permit for specific transfer
2. **No Allowance** - No need to pre-approve spending limits
3. **One Signature** - Single signature authorizes the exact payment
4. **More Secure** - No unlimited allowances, each payment is explicit

This is the same mechanism used by Coinbase, Circle, and other major platforms.

## Troubleshooting

### "Insufficient USDC balance"
- Get test USDC on SKALE BITE (see below)

### "Payment failed"
- Check console for error details
- Ensure MetaMask is on SKALE BITE network

### MetaMask shows wrong network
- Manually add SKALE BITE network using the details above
- Or let the app add it automatically when connecting

## Learn More

- [x402 Protocol](https://x402.org)
- [RelAI Documentation](https://relai.fi/documentation)
- [SKALE Network](https://skale.space)
- [@relai-fi/x402 SDK](https://www.npmjs.com/package/@relai-fi/x402)

## SKALE BITE Details

- **Chain ID**: 103698795
- **RPC**: `https://base-sepolia-testnet.skalenodes.com/v1/bite-v2-sandbox`
- **USDC**: `0xc4083B1E81ceb461Ccef3FDa8A9F24F0d764B6D8`
- **Gas Token**: sFUEL (free from faucet)
- **Explorer**: https://base-sepolia-testnet-explorer.skalenodes.com:10032

## Get Test USDC

Get USDC: Bridge from Base Sepolia or ask in SKALE Discord

## Troubleshooting

### "Insufficient USDC balance"
- Get test USDC on SKALE BITE (see above)

### "Payment failed"
- Check console for error details
- Verify `validAfter: 0` (not timestamp)
- Ensure MetaMask is on SKALE BITE network

### "402 after payment"
- Check backend logs for facilitator error
- Verify merchant wallet address in `.env`
- Ensure facilitator URL is correct

## SDK Documentation

- Client SDK: `@relai-fi/x402/client`
- Server SDK: `@relai-fi/x402/server`
- Full docs: https://relai.fi/documentation/sdk

## License

MIT
