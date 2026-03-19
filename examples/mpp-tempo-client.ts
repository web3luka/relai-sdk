/**
 * Example: Client paying for APIs protected by MPP Tempo via @relai-fi/x402.
 *
 * Usage:
 *   TEMPO_PRIVATE_KEY=0x... npx tsx examples/mpp-tempo-client.ts [server-url]
 *
 * Start the server first:
 *   MPP_SECRET_KEY=my-secret npx tsx examples/mpp-tempo-server.ts
 */
import { createX402Client } from "../src/client";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.argv[2] || "http://localhost:4402";
const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: TEMPO_PRIVATE_KEY=0x... npx tsx examples/mpp-tempo-client.ts [server-url]");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Server:  ${SERVER_URL}\n`);

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

// ── Create x402 client with MPP handler ─────────────────────────────────────
const client = createX402Client({
  mpp: mppx,
  verbose: true,
});

// ── Test 1: Free endpoint ───────────────────────────────────────────────────
console.log("═══ Test 1: Health check (free) ═══");
try {
  const res = await client.fetch(`${SERVER_URL}/health`);
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

// ── Test 2: Paid endpoint (GET) ─────────────────────────────────────────────
console.log("\n═══ Test 2: GET /api/data ($0.01 via MPP Tempo) ═══");
try {
  const res = await client.fetch(`${SERVER_URL}/api/data`);
  console.log(`Status: ${res.status}`);
  const receipt = res.headers.get("payment-receipt");
  if (receipt) console.log(`Payment-Receipt: ${receipt.slice(0, 60)}...`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

// ── Test 3: Paid endpoint (POST) ────────────────────────────────────────────
console.log("\n═══ Test 3: POST /api/generate ($0.05 via MPP Tempo) ═══");
try {
  const res = await client.fetch(`${SERVER_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Hello from MPP Tempo!" }),
  });
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n═══ Done ═══");
