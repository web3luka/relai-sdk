/**
 * Example: Client using WebSocket relay transport with MPP payment (Tempo).
 *
 * When a relay URL returns a 402 with an MPP challenge (WWW-Authenticate: Payment),
 * the client handles the MPP credential exchange entirely over WebSocket — no HTTP
 * round-trip needed. If MPP fails, it falls through to x402 over the same WS connection.
 *
 * Usage:
 *   # Start the WS relay server first:
 *   npx tsx examples/ws-relay-server.ts
 *
 *   # Then run the client:
 *   TEMPO_PRIVATE_KEY=0x... npx tsx examples/ws-mpp-client.ts [relay-url]
 *
 * The relay URL must follow the format:
 *   http://localhost:4405/relay/<apiId>/...
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

const RELAY_URL =
  process.argv[2] || "http://localhost:4405/relay/test-api/v1/data";
const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: TEMPO_PRIVATE_KEY=0x... npx tsx examples/ws-mpp-client.ts [relay-url]");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Relay:   ${RELAY_URL}\n`);

// ── Create mppx client for Tempo ────────────────────────────────────────────
const mppx = Mppx.create({
  methods: [tempo.charge({ account })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    console.log(`  [MPP] Challenge: ${challenge.method}/${challenge.intent}`);
    console.log(`  [MPP] Amount: ${challenge.request?.amount}, Recipient: ${challenge.request?.recipient}`);
    console.log(`  [MPP] Signing tx on Tempo...`);
    const cred = await createCredential();
    console.log(`  [MPP] Done.`);
    return cred;
  },
});

// ── Create x402 client with WS relay + MPP ──────────────────────────────────
const client = createX402Client({
  wallets: {
    evm: {
      address: account.address,
      signTypedData: (data) => account.signTypedData(data as any),
    },
  },
  mpp: mppx,
  relayWs: {
    enabled: true,
    webSocketFactory: (url) => new WebSocket(url) as any,
    preflightTimeoutMs: 10000,
    paymentTimeoutMs: 15000,
    fallbackToHttp: true,
  },
  verbose: true,
});

// ── Test 1: WS relay with MPP payment ───────────────────────────────────────
console.log("═══ Test 1: WS relay + MPP Tempo payment ($0.01) ═══");
try {
  const res = await client.fetch(RELAY_URL, {
    method: "GET",
  });

  console.log(`Status: ${res.status}`);
  const paymentResponse = res.headers.get("PAYMENT-RESPONSE");
  if (paymentResponse) console.log(`Payment-Response: ${paymentResponse.slice(0, 60)}...`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

// ── Test 2: WS relay — free endpoint (no payment needed) ───────────────────
console.log("\n═══ Test 2: WS relay — free endpoint ═══");
try {
  const res = await client.fetch(
    RELAY_URL.replace(/\/v1\/.*$/, "/health"),
    { method: "GET" },
  );

  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n═══ Done ═══");
