/**
 * Payment Requests — Merchant / Buyer example
 *
 * Flow 2: Sprzedawca wystawia fakturę → kupujący płaci
 *
 *   Merchant creates a payment request with amount + description
 *   → gets a short code (e.g. "X7K9P2AB")
 *   → shares it with the buyer (QR, link, message)
 *   Buyer reads the request, signs EIP-3009, submits → USDC goes to merchant
 *
 * Also shows "pay invoice with a code" — buyer has a pre-generated
 * payment code and uses it to settle the merchant's invoice.
 *
 * Run: npx tsx examples/payment-codes/merchant-example.ts
 */

import {
  createPayRequest,
  getPayRequest,
  payPayRequest,
  payPayRequestWithCode,
  createPrivateKeySigner,
} from '../../src/index.js';

const FACILITATOR = { facilitatorUrl: 'https://relai.fi/facilitator' };

// ── 1. Merchant creates a payment request ─────────────────────────────────────

async function merchantCreateRequest() {
  const req = await createPayRequest(FACILITATOR, {
    to:          process.env.MERCHANT_WALLET!,  // merchant receives USDC here
    amount:      5_000_000,   // $5.00 USDC (micro-units)
    network:     'base-sepolia',
    description: 'Order #1234 — 2× coffee ☕',
    ttlSeconds:  900,         // 15 minutes
  });

  console.log('Payment request created!');
  console.log('Code:', req.code);
  console.log('Expires at:', new Date(req.validUntil * 1000).toISOString());
  console.log('Share link: https://relai.fi/pay#' + req.code);
  // → "X7K9P2AB"
  return req.code;
}

// ── 2. Buyer checks the request ───────────────────────────────────────────────

async function buyerCheckRequest(code: string) {
  const info = await getPayRequest(FACILITATOR, code);

  console.log('\nPayment request info:');
  console.log(' Code:', info.code);
  console.log(' To (merchant):', info.to);
  console.log(' Amount: $' + (info.amount / 1e6).toFixed(2), 'USDC');
  console.log(' Description:', info.description);
  console.log(' Network:', info.network);
  console.log(' Payable:', info.payable);
  console.log(' Expires in:', info.expiresIn, 's');
  return info;
}

// ── 3a. Buyer pays with their signer (direct EIP-3009) ────────────────────────

async function buyerPayDirect(code: string) {
  const signer = createPrivateKeySigner(process.env.BUYER_PRIVATE_KEY!);

  const result = await payPayRequest(FACILITATOR, code, signer);

  console.log('\nPayment sent!');
  console.log(' Success:', result.success);
  console.log(' Amount: $' + (Number(result.amount) / 1e6).toFixed(2), 'USDC');
  console.log(' Network:', result.network);
  console.log(' Explorer:', result.explorerUrl);
}

// ── 3b. Buyer pays using a pre-generated payment code ─────────────────────────
//
// The buyer already has a BLIK-style payment code (e.g. generated earlier
// by an agent or via /codes/create). Instead of signing EIP-3009 on the spot,
// they redeem that code and the USDC goes directly to the merchant.
//
// If the code is worth MORE than the invoice:
//   returnChange: 'code'   (default) — relayer pays merchant, returns a new code for the difference
//   returnChange: 'wallet'           — settler.settleExact(): change goes atomically to buyer wallet

async function buyerPayWithCode(requestCode: string, paymentCode: string) {
  const result = await payPayRequestWithCode(FACILITATOR, requestCode, paymentCode, {
    returnChange: 'code',   // default: no-wallet-friendly, get change as a new code
  });

  console.log('\nPayment via code sent!');
  console.log(' Success:', result.success);
  console.log(' Amount: $' + (Number(result.amount) / 1e6).toFixed(2), 'USDC');
  console.log(' Explorer:', result.explorerUrl);

  if (result.changeCode) {
    console.log(` Change: $${(Number(result.change) / 1e6).toFixed(2)} USDC → new code: ${result.changeCode}`);
    // Pass this code to the buyer — they can spend it later
  }
}

// ── Run ───────────────────────────────────────────────────────────────────────

const missingVars = ['MERCHANT_WALLET', 'BUYER_PRIVATE_KEY'].filter(v => !process.env[v]);
if (missingVars.length) {
  console.error('Missing env vars:', missingVars.join(', '));
  process.exit(1);
}

// Demo: merchant creates → buyer checks → buyer pays directly
const requestCode = await merchantCreateRequest();
await buyerCheckRequest(requestCode);
await buyerPayDirect(requestCode);

// Demo: pay with a pre-generated code (replace with a real code)
// const paymentCode = 'X7K9P2AB';
// await buyerPayWithCode(requestCode, paymentCode);
