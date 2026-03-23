/**
 * Example: Client using WebSocket relay transport with x402 payment.
 *
 * WebSocket transport is faster than HTTP for relay URLs because it avoids
 * a full HTTP round-trip for the preflight 402 check — the payment challenge
 * and the paid retry both happen over the same persistent WS connection.
 *
 * Usage:
 *   # Start the WS relay test server first:
 *   npx tsx examples/ws-relay-server.ts
 *
 *   # Then run the client:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/ws-x402-client.ts [relay-url]
 *
 * The relay URL must follow the format:
 *   http://localhost:4405/relay/<apiId>/...
 *   https://api.relai.fi/relay/<apiId>/...
 *   or a whitelabel domain like https://<name>.x402.fi/...
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

const RELAY_URL =
  process.argv[2] || "http://localhost:4405/relay/test-api/v1/chat/completions";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: EVM_PRIVATE_KEY=0x... npx tsx examples/ws-x402-client.ts [relay-url]");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Relay:   ${RELAY_URL}\n`);

// ── Create x402 client with WebSocket relay enabled ─────────────────────────
const client = createX402Client({
  wallets: {
    evm: {
      address: account.address,
      signTypedData: (data) => account.signTypedData(data as any),
    },
  },
  relayWs: {
    enabled: true,
    // Custom WebSocket factory for Node.js (browsers have global WebSocket)
    webSocketFactory: (url) => new WebSocket(url) as any,
    preflightTimeoutMs: 5000,
    paymentTimeoutMs: 10000,
    fallbackToHttp: true,
  },
  verbose: true,
});

// ── Test 1: Relay request via WebSocket (x402 payment) ──────────────────────
console.log("═══ Test 1: WS relay request with x402 payment ═══");
try {
  const res = await client.fetch(RELAY_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "gpt-4",
      messages: [{ role: "user", content: "Hello from WS relay!" }],
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

// ── Test 2: Second WS relay request (same server) ──────────────────────────
console.log("\n═══ Test 2: WS relay GET request ═══");
try {
  const baseUrl = RELAY_URL.replace(/\/v1\/.*$/, "/v1/data");
  const res = await client.fetch(baseUrl, {
    method: "GET",
  });

  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n═══ Done ═══");
