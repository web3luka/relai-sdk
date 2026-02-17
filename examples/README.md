# @relai-fi/x402 Examples

Complete examples demonstrating x402 payment integration with the RelAI SDK.

## Available Examples

### [SKALE BITE Next.js](./skale-bite-nextjs)

Full-stack Next.js application showing:
- Backend API protection with `Relai.protect()`
- Frontend payment flow with `createX402Client()`
- EIP-3009 gasless payments on SKALE BITE (no approve needed)
- BITE encrypted transactions for MEV protection
- Complete UI with wallet connection

**Quick Start:**
```bash
cd skale-bite-nextjs
npm install
cp .env.example .env
npm run dev
```

## What You'll Learn

- How to protect API endpoints with x402 payments
- How to implement client-side payment flow with EIP-3009 (no approve needed)
- How BITE encrypted transactions work on SKALE chains
- How to use SDK for gasless, MEV-protected payments
- Best practices for x402 integration

## Prerequisites

- Node.js 18+
- MetaMask or compatible wallet
- Basic understanding of Next.js and React

## Getting Help

- [SDK Documentation](https://www.npmjs.com/package/@relai-fi/x402)
- [RelAI Docs](https://relai.fi/docs)
- [x402 Protocol](https://x402.org)

## Contributing

Have an example to share? Open a PR!
