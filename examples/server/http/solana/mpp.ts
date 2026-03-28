/**
 * Example: Express server protected by MPP Solana payments via @relai-fi/x402.
 *
 * Usage:
 *   MPP_SECRET_KEY=my-secret SOLANA_RPC_URL=https://... npx tsx examples/mpp-solana-server.ts
 *
 * Then test with the client:
 *   SOLANA_PRIVATE_KEY=base58... npx tsx examples/mpp-solana-client.ts
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../../src/server";
import { Mppx, solana } from "@solana/mpp/server";

// ---------------------------------------------------------------------------
// Workaround: @solana/mpp sends transactions with skipPreflight: false,
// which causes "Blockhash not found" errors because the RPC node re-simulates
// with a newer slot. Since the SDK already simulates explicitly before
// broadcasting, the preflight is redundant. We patch sendTransaction to
// force skipPreflight: true until this is fixed upstream.
// ---------------------------------------------------------------------------
const _origFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const [url, opts] = args;
  if (opts?.body && typeof opts.body === "string") {
    try {
      const body = JSON.parse(opts.body);
      if (body.method === "sendTransaction" && body.params?.[1]) {
        body.params[1] = { ...body.params[1], skipPreflight: true };
        return _origFetch(url, { ...opts, body: JSON.stringify(body) });
      }
    } catch {}
  }
  return _origFetch(...args);
};

const PORT = process.env.PORT || 4403;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";
const SOLANA_RPC_URL = process.env.SOLANA_RPC_URL || "";

// The Solana wallet that receives USDC payments
const RECIPIENT_WALLET = process.env.SOLANA_RECIPIENT_WALLET || process.env.RECIPIENT_WALLET || "7UhYt3afz4FTk3kjn8H8NatHkFJ1EdJyLNEp4HXoEYYn";

// Solana USDC — devnet uses a different mint
const SOLANA_USDC_MAINNET = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOLANA_NETWORK = process.env.SOLANA_NETWORK || "mainnet-beta";
const SOLANA_USDC = SOLANA_NETWORK === "devnet" ? SOLANA_USDC_DEVNET : SOLANA_USDC_MAINNET;

// ── Create mppx server handler ──────────────────────────────────────────────
const DECIMALS = 6;

const mppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [
    solana.charge({
      recipient: RECIPIENT_WALLET,
      currency: SOLANA_USDC,
      decimals: DECIMALS,
      network: SOLANA_NETWORK,
      ...(SOLANA_RPC_URL ? { rpcUrl: SOLANA_RPC_URL } : {}),
    }),
  ],
});

// Wrap mppx to convert USD amount → base units for Solana SPL.
// Relai SDK passes amount as USD string (e.g. "1.000000"),
// but @solana/mpp expects base units (e.g. "1000000" for 1 USDC).
//
// IMPORTANT: mppx.charge() must be called ONCE per price point to create a
// stateful handler that can both issue challenges and verify credentials.
// Calling it per-request creates a new handler that can't verify old challenges.
const handlerCache = new Map<string, ReturnType<typeof mppx.charge>>();

const mppSolanaWrapper = {
  charge(params: Record<string, unknown>) {
    const usdAmount = parseFloat(params.amount as string);
    const baseUnits = Math.round(usdAmount * 10 ** DECIMALS).toString();

    if (!handlerCache.has(baseUnits)) {
      handlerCache.set(baseUnits, mppx.charge({ ...params, amount: baseUnits }));
    }
    return handlerCache.get(baseUnits)!;
  },
};

// ── Create Relai instance with MPP ──────────────────────────────────────────
const relai = new Relai({
  network: "solana",
  mpp: mppSolanaWrapper as any,
});

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get(
  "/api/data",
  relai.protect({
    payTo: RECIPIENT_WALLET,
    price: 0.01, // $0.01
    description: "Premium data endpoint",
    onPaymentRequired: (_req, info) => {
      console.log(`[Server] 402 returned: $${info.price} on ${info.network}`);
    },
    onPaymentSettled: (_req, result) => {
      console.log(`[Server] Payment settled: tx=${result.transaction}, payer=${result.payer}`);
    },
  }),
  (_req, res) => {
    res.json({
      data: "This is premium content paid via MPP Solana!",
      timestamp: new Date().toISOString(),
      paidBy: (_req as any).x402Payer || "unknown",
      transaction: (_req as any).x402Transaction || null,
    });
  }
);

app.post(
  "/api/generate",
  relai.protect({
    payTo: RECIPIENT_WALLET,
    price: 0.01, // $0.01
    description: "AI generation endpoint",
  }),
  (req, res) => {
    res.json({
      generated: `Response to: ${(req.body as any)?.prompt || "no prompt"}`,
      cost: "$0.05",
      paidBy: (req as any).x402Payer || "unknown",
    });
  }
);

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  MPP Solana Example Server                               ║
║  Listening on http://localhost:${PORT}                      ║
║                                                          ║
║  Endpoints:                                              ║
║    GET  /health     - Free health check                  ║
║    GET  /api/data   - $0.01 (MPP Solana or x402)         ║
║    POST /api/generate - $0.05 (MPP Solana or x402)       ║
║                                                          ║
║  Network: ${SOLANA_NETWORK.padEnd(12)}                              ║
║  Recipient: ${RECIPIENT_WALLET.slice(0, 10)}...${RECIPIENT_WALLET.slice(-4)}                    ║
╚══════════════════════════════════════════════════════════╝
`);
});
