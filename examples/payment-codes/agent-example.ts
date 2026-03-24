/**
 * Payment Codes — Agent example
 *
 * Shows how an AI agent or server-side script can:
 *  1. Generate a payment code from a private key
 *  2. Generate a batch of codes (budget allocation)
 *  3. Check code status
 *  4. Redeem a code (payee side)
 *  5. Cancel an unused code
 *
 * Run: npx tsx examples/payment-codes/agent-example.ts
 */

import {
  createPrivateKeySigner,
  generatePaymentCode,
  generatePaymentCodesBatch,
  getPaymentCode,
  redeemPaymentCode,
  cancelPaymentCode,
} from '../../src/index.js';

const FACILITATOR = { facilitatorUrl: 'https://relai.fi/facilitator' };

// ── 1. Single code ────────────────────────────────────────────────────────────

async function createSingleCode() {
  const signer = createPrivateKeySigner(process.env.AGENT_PRIVATE_KEY!);

  const result = await generatePaymentCode(FACILITATOR, {
    signer,
    network: 'base-sepolia',
    value:   1_000_000n,   // $1.00 USDC
    ttl:     3600,         // 1 hour
    description: 'coffee ☕',
  });

  console.log('Code:', result.code);
  console.log('Expires in:', result.expiresIn, 'seconds');
  console.log('Settlement:', result.settlementNetwork);
  // → "X7K9P2AB"
}

// ── 2. Locked code (only a specific wallet can redeem) ────────────────────────

async function createLockedCode() {
  const signer = createPrivateKeySigner(process.env.AGENT_PRIVATE_KEY!);

  const result = await generatePaymentCode(FACILITATOR, {
    signer,
    network:     'base-sepolia',
    value:       5_000_000n,  // $5.00
    ttl:         86400,
    description: 'reward payout',
    payee:       '0xRecipientWalletAddress...',  // only this address can claim
  });

  console.log('Locked code:', result.code, '→ locked:', result.locked);
}

// ── 3. Batch (budget allocation — up to 20 codes at once) ────────────────────

async function createBatchCodes() {
  const signer = createPrivateKeySigner(process.env.AGENT_PRIVATE_KEY!);

  const { registered, codes, failed } = await generatePaymentCodesBatch(FACILITATOR, {
    signer,
    authToken: process.env.RELAI_API_KEY!,
    network:   'base-sepolia',
    codes:     Array(5).fill({ value: 1_000_000n, ttl: 3600 }),  // 5 × $1.00
  });

  console.log(`Registered: ${registered}, failed: ${failed.length}`);
  codes.forEach(c => console.log(' -', c.code, 'expires in', c.expiresIn, 's'));
}

// ── 4. Check status ───────────────────────────────────────────────────────────

async function checkStatus(code: string) {
  const status = await getPaymentCode(FACILITATOR, code);
  console.log('Code:', status.code);
  console.log('Value:', Number(status.value) / 1e6, 'USDC');
  console.log('Redeemable:', status.redeemable);
  console.log('Redeemed:', status.redeemed);
}

// ── 5. Redeem (payee side — no wallet connection needed) ──────────────────────

async function redeem(code: string, payeeAddress: string) {
  const result = await redeemPaymentCode(FACILITATOR, code, payeeAddress);
  console.log('Success:', result.success);
  console.log('Amount:', Number(result.amount) / 1e6, 'USDC');
  console.log('Explorer:', result.explorerUrl);
}

// ── 6. Cancel an unused code ──────────────────────────────────────────────────

async function cancel(code: string) {
  const result = await cancelPaymentCode(FACILITATOR, code);
  console.log('Cancelled:', result.success, '| L3 tx:', result.l3TxHash);
}

// ── Run ───────────────────────────────────────────────────────────────────────

if (!process.env.AGENT_PRIVATE_KEY) {
  console.error('Set AGENT_PRIVATE_KEY env var first');
  process.exit(1);
}

await createSingleCode();
