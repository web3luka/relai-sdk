/**
 * Express server protected by x402 payments (Base USDC) via @relai-fi/x402.
 *
 * Pure x402 — no MPP dependency. The RelAI facilitator handles payment
 * verification and settlement (zero gas fees for users).
 *
 * Usage:
 *   npx tsx examples/server/http/evm/x402-base.ts
 *
 * Client:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/client/http/evm/x402-base.ts http://localhost:4410
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../../src/server";

const PORT = process.env.PORT || 4410;
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET || "0xB855bb7D5dd48Ef84D9cDbb9BAc59a680C080D3d";

// ── Create Relai instance (x402 only — no MPP) ─────────────────────────────
const relai = new Relai({ network: "base" });

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
    price: 0.01,
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
      data: "This is premium content paid via x402 on Base!",
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
    price: 0.05,
    description: "AI generation endpoint",
    onPaymentSettled: (_req, result) => {
      console.log(`[Server] Payment settled: tx=${result.transaction}, payer=${result.payer}`);
    },
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
║  x402 Example Server (Base USDC)                         ║
║  Listening on http://localhost:${PORT}                      ║
║                                                          ║
║  Endpoints:                                              ║
║    GET  /health       - Free health check                ║
║    GET  /api/data     - $0.01 (x402 via facilitator)     ║
║    POST /api/generate - $0.05 (x402 via facilitator)     ║
║                                                          ║
║  Network:   Base (eip155:8453)                           ║
║  Recipient: ${RECIPIENT_WALLET.slice(0, 10)}...${RECIPIENT_WALLET.slice(-4)}          ║
╚══════════════════════════════════════════════════════════╝
`);
});
