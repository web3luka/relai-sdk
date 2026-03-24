/**
 * CLIENT-SIDE BRIDGE — Standard x402 Base server (no bridge awareness)
 *
 * This server accepts x402 payments on Base. It knows NOTHING about bridging.
 * The client uses `bridge: { enabled: true }` to auto-bridge from Solana.
 *
 * Pair with:
 *   client-solana-to-base.ts  (x402 client, Solana → Base)
 *
 * Usage:
 *   npx tsx examples/bridge/client-side/server-x402-base.ts
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../src/server";

const PORT = process.env.PORT || 4411;
const PAY_TO = process.env.PAY_TO || "0xB855bb7D5dd48Ef84D9cDbb9BAc59a680C080D3d";

const relai = new Relai({
  network: "base",
  facilitatorUrl: "https://facilitator.x402.fi",
});

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get(
  "/api/data",
  relai.protect({
    payTo: PAY_TO,
    price: 0.10,
    description: "Premium data — $0.10 on Base",
    onPaymentSettled: (_req, result) => {
      console.log(`[Server] Payment settled: tx=${result.transaction}, payer=${result.payer}`);
    },
  }),
  (_req, res) => {
    res.json({ data: "Premium content from Base!", note: "Standard x402, no bridge config." });
  }
);

app.listen(PORT, () => {
  console.log(`
  CLIENT-SIDE BRIDGE — Standard x402 Base Server
  http://localhost:${PORT}

  Protocol: x402 only (no bridge, no MPP)
  GET /health   — free
  GET /api/data — $0.10 (Base USDC)
`);
});
