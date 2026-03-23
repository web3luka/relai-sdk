/**
 * x402 client — Solana SPL payment.
 *
 * Usage:
 *   SOLANA_PRIVATE_KEY=base58... npx tsx examples/client/http/solana/x402.ts [url]
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { Keypair } from "@solana/web3.js";
// @ts-ignore
import bs58 from "bs58";

const TARGET_URL = process.argv[2] || "http://localhost:4414/api/data";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
if (!PRIVATE_KEY) { console.error("SOLANA_PRIVATE_KEY required"); process.exit(1); }

const kp = Keypair.fromSecretKey(new Uint8Array(bs58.decode(PRIVATE_KEY)));

const client = createX402Client({
  wallets: {
    solana: {
      publicKey: kp.publicKey,
      signTransaction: async (tx: any) => { tx.sign([kp]); return tx; },
    },
  },
  solanaRpcUrl: process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com",
  verbose: true,
});

const res = await client.fetch(TARGET_URL, { method: "GET" });
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
