/**
 * Solana Payment Request examples — two flows:
 *
 * Flow A — Solana buyer → EVM merchant (cross-chain):
 *   Merchant receives USDC on Base Sepolia.
 *   Buyer pays from their Solana wallet.
 *   SDK sends buyer ATA → relayer ATA on Solana; relayer pays merchant on Base.
 *   Env: MERCHANT_WALLET=0x...  SOLANA_PRIVATE_KEY=<base58>
 *
 * Flow B — Solana buyer → Solana merchant (direct, same chain):
 *   Merchant receives USDC on Solana Devnet.
 *   Buyer pays from their Solana wallet directly to merchant ATA.
 *   No bridge or EVM step involved.
 *   Env: MERCHANT_SOLANA_WALLET=<base58>  SOLANA_PRIVATE_KEY=<base58>
 *
 * Prerequisites (testnet):
 *   - SOL on devnet (gas):  https://faucet.solana.com
 *   - USDC on devnet:       https://faucet.circle.com  (select Solana Devnet)
 *
 * Run Flow A:  MERCHANT_WALLET=0x... SOLANA_PRIVATE_KEY=... npx tsx examples/payment-codes/solana-crosschain-example.ts a
 * Run Flow B:  MERCHANT_SOLANA_WALLET=... SOLANA_PRIVATE_KEY=... npx tsx examples/payment-codes/solana-crosschain-example.ts b
 */

import "dotenv/config";
import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import {
  createPayRequest,
  getPayRequest,
  payPayRequestWithSolana,
} from "../../src/index.js";

// ── Config ────────────────────────────────────────────────────────────────────

const FACILITATOR      = { facilitatorUrl: "https://relai.fi/facilitator" };
const SOLANA_OPTS      = { solanaNetwork: "solana-devnet" as const, solanaRpcUrl: "https://api.devnet.solana.com" };
const FLOW             = (process.argv[2] || "a").toLowerCase();

// Decode buyer's Solana keypair — accepts base58 string or JSON byte array
function loadKeypair(raw: string): Keypair {
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return Keypair.fromSecretKey(Uint8Array.from(parsed));
  } catch {}
  return Keypair.fromSecretKey(bs58.decode(raw));
}

if (!process.env.SOLANA_PRIVATE_KEY) {
  console.error("Missing env var: SOLANA_PRIVATE_KEY");
  process.exit(1);
}

const buyerKeypair = loadKeypair(process.env.SOLANA_PRIVATE_KEY);

// Minimal SolanaWalletAdapter backed by a Keypair (agent / server-side usage)
const solanaWallet = {
  publicKey: buyerKeypair.publicKey,
  signTransaction: async <T>(tx: T): Promise<T> => {
    (tx as any).sign([buyerKeypair]);
    return tx;
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// FLOW A — Solana buyer → EVM merchant (cross-chain)
// ─────────────────────────────────────────────────────────────────────────────

async function runFlowA() {
  const MERCHANT_WALLET = process.env.MERCHANT_WALLET;
  if (!MERCHANT_WALLET) { console.error("Missing env var: MERCHANT_WALLET (0x EVM address)"); process.exit(1); }

  console.log("══ Flow A: Solana buyer → Base Sepolia merchant (cross-chain) ══\n");

  // 1. Merchant creates invoice on Base Sepolia
  console.log("── Step 1: Merchant creates payment request on base-sepolia ──");
  const req = await createPayRequest(FACILITATOR, {
    to:          MERCHANT_WALLET,
    amount:      1_000_000,         // $1.00 USDC
    network:     "base-sepolia",
    description: "Cross-chain coffee ☕ (Solana → Base)",
    ttlSeconds:  600,
  });
  console.log(" Code:      ", req.code);
  console.log(" Expires:   ", new Date(req.validUntil * 1000).toISOString());
  console.log(" Pay link:   https://relai.fi/pay#" + req.code);

  // 2. Buyer checks request
  console.log("\n── Step 2: Buyer reads request ───────────────────────────────");
  const info = await getPayRequest(FACILITATOR, req.code);
  console.log(` Amount: $${(info.amount / 1e6).toFixed(2)} USDC  |  Merchant: ${info.to}  |  Network: ${info.network}`);
  console.log(" Note: buyer has only a Solana wallet — no EVM wallet required");

  // 3. Buyer pays with Solana wallet
  console.log("\n── Step 3: Buyer pays with Solana wallet ─────────────────────");
  console.log(" Buyer:", buyerKeypair.publicKey.toBase58());
  const result = await payPayRequestWithSolana(FACILITATOR, req.code, solanaWallet, SOLANA_OPTS);

  console.log("\n✅ Payment complete!");
  console.log(` Amount:  $${(Number(result.amount) / 1e6).toFixed(2)} USDC`);
  console.log(" Solana:  ", result.solanaExplorerUrl);
  console.log(" Base:    ", result.explorerUrl);
}

// ─────────────────────────────────────────────────────────────────────────────
// FLOW B — Solana buyer → Solana merchant (direct, same chain)
// ─────────────────────────────────────────────────────────────────────────────

async function runFlowB() {
  const MERCHANT_SOLANA_WALLET = process.env.MERCHANT_SOLANA_WALLET;
  if (!MERCHANT_SOLANA_WALLET) { console.error("Missing env var: MERCHANT_SOLANA_WALLET (base58 Solana address)"); process.exit(1); }

  console.log("══ Flow B: Solana buyer → Solana merchant (direct, same chain) ══\n");

  // 1. Merchant creates invoice on solana-devnet (Solana address)
  console.log("── Step 1: Merchant creates payment request on solana-devnet ─");
  const req = await createPayRequest(FACILITATOR, {
    to:          MERCHANT_SOLANA_WALLET,
    amount:      1_000_000,         // $1.00 USDC
    network:     "solana-devnet",
    description: "Direct Solana coffee ☕",
    ttlSeconds:  600,
  });
  console.log(" Code:      ", req.code);
  console.log(" Expires:   ", new Date(req.validUntil * 1000).toISOString());
  console.log(" Pay link:   https://relai.fi/pay#" + req.code);

  // 2. Buyer checks request
  console.log("\n── Step 2: Buyer reads request ───────────────────────────────");
  const info = await getPayRequest(FACILITATOR, req.code);
  console.log(` Amount: $${(info.amount / 1e6).toFixed(2)} USDC  |  Merchant: ${info.to}  |  Network: ${info.network}`);

  // 3. Buyer pays with Solana wallet — direct SPL transfer, no bridge
  console.log("\n── Step 3: Buyer pays (direct Solana → Solana) ───────────────");
  console.log(" Buyer:   ", buyerKeypair.publicKey.toBase58());
  console.log(" Merchant:", MERCHANT_SOLANA_WALLET);
  const result = await payPayRequestWithSolana(FACILITATOR, req.code, solanaWallet, SOLANA_OPTS);

  console.log("\n✅ Payment complete!");
  console.log(` Amount:  $${(Number(result.amount) / 1e6).toFixed(2)} USDC`);
  console.log(" Solana:  ", result.solanaExplorerUrl);
  console.log(" (No EVM tx — merchant received directly on Solana)");
}

// ── Run ───────────────────────────────────────────────────────────────────────

if (FLOW === "b") {
  await runFlowB();
} else {
  await runFlowA();
}
