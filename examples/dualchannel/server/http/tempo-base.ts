/**
 * Dual-channel server: accepts both x402 AND MPP payments on the same endpoint.
 *
 * When a client sends a request without payment:
 *   → Server returns 402 with BOTH:
 *     - WWW-Authenticate: Payment (MPP Tempo challenge)
 *     - x402 payment requirements in body (Base EVM)
 *
 * The client decides which protocol to use:
 *   - MPP client sends Authorization: Payment → settled via Tempo
 *   - x402 client sends X-PAYMENT → settled via Base EVM facilitator
 *
 * Usage:
 *   npx tsx examples/dualchannel/server.ts
 *
 * Then test with:
 *   npx tsx examples/dualchannel/client-mpp.ts
 *   npx tsx examples/dualchannel/client-x402.ts
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../../src/server";
import { Mppx, tempo } from "mppx/server";

const PORT = parseInt(process.env.PORT || "4420", 10);
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET!;
const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";

if (!RECIPIENT_WALLET) {
  console.error("RECIPIENT_WALLET required in .env");
  process.exit(1);
}

// ── MPP Tempo handler ───────────────────────────────────────────────────────
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

// ── Relai with BOTH x402 (Base) + MPP (Tempo) ──────────────────────────────
const relai = new Relai({
  network: "base",   // x402 fallback chain
  mpp: mppx,         // MPP Tempo handler
});

const protect = relai.protect({
  payTo: RECIPIENT_WALLET,
  price: 0.001,
  description: "Dual-channel endpoint ($0.001)",
  onPaymentRequired: (_req, info) => {
    console.log(`[402] Payment required: $${info.price} — x402 on ${info.network}, MPP via Tempo`);
  },
  onPaymentSettled: (_req, result) => {
    console.log(`[200] Paid by ${result.payer} via ${result.transaction ? "x402" : "MPP"}`);
  },
});

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", mode: "dualchannel", timestamp: new Date().toISOString() });
});

app.get("/api/data", protect, (_req, res) => {
  const payer = (_req as any).x402Payer || "unknown";
  const tx = (_req as any).x402Transaction;
  res.json({
    data: "Premium content — dual-channel!",
    paidVia: tx ? "x402" : "mpp",
    paidBy: payer,
    transaction: tx || null,
    timestamp: new Date().toISOString(),
  });
});

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Dual-Channel Server (x402 Base + MPP Tempo)             ║
║  http://localhost:${PORT}                                   ║
║                                                          ║
║  GET /health    — free                                   ║
║  GET /api/data  — $0.001 (x402 OR MPP)                   ║
║                                                          ║
║  x402 → Base EVM (facilitator.x402.fi)                   ║
║  MPP  → Tempo (gas-free)                                 ║
╚══════════════════════════════════════════════════════════╝
`);
});
