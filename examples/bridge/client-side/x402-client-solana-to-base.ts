/**
 * CLIENT-SIDE BRIDGE — x402 client on Solana paying a Base server
 *
 * The server only accepts x402 on Base — it has NO bridge config.
 * The client uses `bridge: { enabled: true }` which:
 *   1. Receives the 402 with Base USDC accept
 *   2. Can't match (no Base wallet) → triggers auto-bridge
 *   3. Auto-discovers bridge info from RelAI API
 *   4. Pays on Solana → bridge settles on Base → gets xPayment
 *   5. Sends X-PAYMENT header → server validates via facilitator
 *
 * Start the server first:
 *   npx tsx examples/bridge/client-side/server-x402-base.ts
 *
 * Then run this client:
 *   SOLANA_PRIVATE_KEY=... npx tsx examples/bridge/client-side/client-solana-to-base.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../src/client";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const SERVER_URL = process.argv[2] || "http://localhost:4411";
const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;

if (!SOLANA_PRIVATE_KEY) {
  console.error("Usage: SOLANA_PRIVATE_KEY=... npx tsx examples/bridge/client-side/client-solana-to-base.ts");
  process.exit(1);
}

const keypair = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATE_KEY));
console.log(`Solana wallet: ${keypair.publicKey.toBase58()}`);
console.log(`Target:        Base server (${SERVER_URL})`);
console.log(`Bridge:        auto-discovery from RelAI API\n`);

const client = createX402Client({
  wallets: {
    solana: {
      publicKey: keypair.publicKey,
      signTransaction: async (tx: any) => {
        tx.sign([keypair]);
        return tx;
      },
    },
  },
  bridge: { enabled: true },
  verbose: true,
});

console.log("=== Test 1: Health check ===");
try {
  const res = await client.fetch(`${SERVER_URL}/health`);
  console.log(`Status: ${res.status}`, await res.json());
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n=== Test 2: Paid endpoint (Solana -> Base via auto-bridge) ===");
try {
  const res = await client.fetch(`${SERVER_URL}/api/data`);
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "\nSUCCESS" : `\nFAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}
