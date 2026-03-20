/**
 * Example: Client paying for APIs protected by MPP EVM (SKALE USDC) via @relai-fi/x402.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/mpp-evm-client.ts [server-url]
 *
 * Start the server first:
 *   MPP_SECRET_KEY=my-secret npx tsx examples/mpp-evm-server.ts
 */
import { createX402Client } from "../src/client";
import { Mppx } from "mppx/client";
import { evmCharge } from "../src/mpp/evm-client";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.argv[2] || "http://localhost:4404";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: EVM_PRIVATE_KEY=0x... npx tsx examples/mpp-evm-client.ts [server-url]");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Server:  ${SERVER_URL}\n`);

// ── Create mppx client for EVM ──────────────────────────────────────────────
const mppx = Mppx.create({
  methods: [evmCharge({ account })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    const req = challenge.request as any;
    console.log(`  [MPP] Challenge: ${challenge.method}/${challenge.intent}`);
    console.log(`  [MPP] Amount: ${req?.amount} ${req?.currency?.slice(0, 10)}...`);
    console.log(`  [MPP] Chain: ${req?.methodDetails?.network} (${req?.methodDetails?.chainId})`);
    console.log(`  [MPP] Sending ERC-20 transfer...`);
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

// ── Test 2: Paid endpoint ───────────────────────────────────────────────────
console.log("\n═══ Test 2: GET /api/data ($0.01 via MPP EVM on SKALE) ═══");
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

console.log("\n═══ Done ═══");
