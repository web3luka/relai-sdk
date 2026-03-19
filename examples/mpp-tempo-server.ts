/**
 * Example: Express server protected by MPP Tempo payments via @relai-fi/x402.
 *
 * Usage:
 *   MPP_SECRET_KEY=my-secret npx tsx examples/mpp-tempo-server.ts
 *
 * Then test with the client:
 *   TEMPO_PRIVATE_KEY=0x... npx tsx examples/mpp-tempo-client.ts
 */
import express from "express";
import Relai from "../src/server";
import { shield, circuitBreaker } from "../src/plugins";
import { Mppx, tempo } from "mppx/server";

const PORT = process.env.PORT || 4402;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

// The wallet that receives Tempo payments
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET || "0xB855bb7D5dd48Ef84D9cDbb9BAc59a680C080D3d";

// Tempo USDC (TIP-20) mainnet
const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";

// ── Create mppx server handler ──────────────────────────────────────────────
const mppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [
    tempo.charge({
      recipient: RECIPIENT_WALLET,
      currency: TEMPO_USDC,
      decimals: 6,
    }),
  ],
});

// ── Create Relai instance with MPP + plugins ────────────────────────────────
const relai = new Relai({
  network: "base", // x402 fallback network (not used for MPP)
  mpp: mppx,
  plugins: [
    shield({
      healthCheck: () => true, // always healthy for demo
      cacheTtlMs: 5000,
    }),
    circuitBreaker({
      failureThreshold: 3,
      resetTimeMs: 10000,
    }),
  ],
});

// ── Express app ─────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

// Public endpoint (no payment)
app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Protected endpoint — requires MPP Tempo or x402 payment
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
      data: "This is premium content paid via MPP Tempo!",
      timestamp: new Date().toISOString(),
      paidBy: (_req as any).x402Payer || "unknown",
      transaction: (_req as any).x402Transaction || null,
    });
  }
);

// Protected endpoint — higher price
app.post(
  "/api/generate",
  relai.protect({
    payTo: RECIPIENT_WALLET,
    price: 0.05, // $0.05
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
║  MPP Tempo Example Server                                ║
║  Listening on http://localhost:${PORT}                      ║
║                                                          ║
║  Endpoints:                                              ║
║    GET  /health     - Free health check                  ║
║    GET  /api/data   - $0.01 (MPP Tempo or x402)          ║
║    POST /api/generate - $0.05 (MPP Tempo or x402)        ║
║                                                          ║
║  Recipient: ${RECIPIENT_WALLET.slice(0, 10)}...${RECIPIENT_WALLET.slice(-4)}          ║
╚══════════════════════════════════════════════════════════╝
`);
});
