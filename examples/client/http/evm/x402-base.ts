/**
 * Example: Basic x402 client — automatic payment for 402-protected endpoints.
 *
 * This is the simplest usage: the client detects a 402 response, signs
 * a payment (EVM EIP-3009 or Solana SPL), and retries with the payment header.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/x402-client.ts [url]
 *
 * Works with any x402-protected endpoint (RelAI relay, direct server, etc.).
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { privateKeyToAccount } from "viem/accounts";

const TARGET_URL = process.argv[2] || "http://localhost:4405/relay/test-api/v1/chat/completions";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: EVM_PRIVATE_KEY=0x... npx tsx examples/x402-client.ts [url]");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Target:  ${TARGET_URL}\n`);

// ── Create x402 client (HTTP mode, no WebSocket) ────────────────────────────
const client = createX402Client({
  wallets: {
    evm: {
      address: account.address,
      signTypedData: (data) => account.signTypedData(data as any),
    },
  },
  verbose: true,
});

// ── Test 1: Simple paid request ─────────────────────────────────────────────
console.log("═══ Test 1: x402 paid request (HTTP) ═══");
try {
  const res = await client.fetch(TARGET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello via x402!" }],
    }),
  });

  console.log(`Status: ${res.status}`);
  const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
  if (paymentResponse) console.log(`Payment-Response: ${paymentResponse.slice(0, 60)}...`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

// ── Test 2: With max amount guard ───────────────────────────────────────────
console.log("\n═══ Test 2: x402 with max amount guard ($0.50 cap) ═══");
const guardedClient = createX402Client({
  wallets: {
    evm: {
      address: account.address,
      signTypedData: (data) => account.signTypedData(data as any),
    },
  },
  maxAmountAtomic: "500000", // $0.50 in 6-decimal USDC
  verbose: true,
});

try {
  const res = await guardedClient.fetch(TARGET_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Guarded request" }],
    }),
  });

  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n═══ Done ═══");
