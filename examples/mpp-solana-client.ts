/**
 * Example: Client paying for APIs protected by MPP Solana via @relai-fi/x402.
 *
 * Usage:
 *   SOLANA_PRIVATE_KEY=base58... npx tsx examples/mpp-solana-client.ts [server-url]
 *
 * Start the server first:
 *   MPP_SECRET_KEY=my-secret npx tsx examples/mpp-solana-server.ts
 */
import { createX402Client } from "../src/client";
import { Mppx, solana } from "@solana/mpp/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
// @ts-ignore — bs58 has no type declarations
import bs58 from "bs58";

const SERVER_URL = process.argv[2] || "http://localhost:4403";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: SOLANA_PRIVATE_KEY=base58... npx tsx examples/mpp-solana-client.ts [server-url]");
  process.exit(1);
}

// Decode base58 private key using bs58 (avoids @solana/kit codec issues)
const secretBytes = bs58.decode(PRIVATE_KEY);
const signer = await createKeyPairSignerFromBytes(new Uint8Array(secretBytes));
console.log(`Account: ${signer.address}`);
console.log(`Server:  ${SERVER_URL}\n`);

// ── Create mppx client for Solana ───────────────────────────────────────────
const mppx = Mppx.create({
  methods: [solana.charge({ signer })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    console.log(`  [MPP] Challenge: ${challenge.method}/${challenge.intent}`);
    console.log(`  [MPP] Amount: ${challenge.request?.amount}, Recipient: ${challenge.request?.recipient}`);
    console.log(`  [MPP] Signing Solana tx...`);
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
console.log("\n═══ Test 2: GET /api/data ($0.01 via MPP Solana) ═══");
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
console.log("\n═══ Test 3: POST /api/generate ($0.05 via MPP Solana) ═══");
try {
  const res = await client.fetch(`${SERVER_URL}/api/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt: "Hello from MPP Solana!" }),
  });
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "SUCCESS" : `FAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n═══ Done ═══");
