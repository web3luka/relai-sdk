/**
 * TESTNET E2E — x402 auto-bridge: Solana Devnet → Base Sepolia
 *
 * Chains:
 *   Source: Solana Devnet — USDC 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 *   Target: Base Sepolia (eip155:84532) — USDC 0x036CbD53...
 *
 * Expected: will fail because the bridge API does not support Base Sepolia
 * as a target chain (only SKALE Base Sepolia is a testnet target).
 *
 * Prerequisites:
 *   - SOL on devnet: https://faucet.solana.com
 *   - USDC-Dev on devnet: https://faucet.circle.com (select Solana Devnet)
 *
 * Start server: npx tsx examples/bridge/testnet/server-base-sepolia.ts
 * Run client:   SOLANA_PRIVATE_KEY=... npx tsx examples/bridge/testnet/x402-solana-devnet-to-base-sepolia.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../src/client";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const SOLANA_PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY;
if (!SOLANA_PRIVATE_KEY) { console.error("SOLANA_PRIVATE_KEY required"); process.exit(1); }

const keypair = Keypair.fromSecretKey(bs58.decode(SOLANA_PRIVATE_KEY));
const SERVER_URL = process.argv[2] || "http://localhost:4421";

console.log(`Wallet:   ${keypair.publicKey.toBase58()}`);
console.log(`Source:   Solana Devnet`);
console.log(`Target:   Base Sepolia (eip155:84532)`);
console.log(`Server:   ${SERVER_URL}\n`);

const client = createX402Client({
  wallets: {
    solana: {
      publicKey: keypair.publicKey,
      signTransaction: async (tx: any) => { tx.sign([keypair]); return tx; },
    },
  },
  solanaRpcUrl: "https://api.devnet.solana.com",
  bridge: { enabled: true },
  verbose: true,
});

console.log("=== Solana Devnet -> Base Sepolia (testnet) ===");
try {
  const res = await client.fetch(`${SERVER_URL}/api/data`);
  console.log(`Status: ${res.status}`);
  if (res.status === 200) {
    console.log(`Body:`, await res.json());
    console.log("\nSUCCESS");
  } else {
    console.log(`Body:`, await res.text());
    console.log(`\nFAILED (${res.status})`);
  }
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}
