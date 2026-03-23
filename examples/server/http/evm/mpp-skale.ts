/**
 * Example: Express server protected by MPP EVM payments (SKALE USDC) via @relai-fi/x402.
 *
 * SKALE is gas-free — ideal for zero-cost micropayments.
 *
 * Usage:
 *   MPP_SECRET_KEY=my-secret npx tsx examples/mpp-evm-server.ts
 *
 * Then test with the client:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/mpp-evm-client.ts
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../../src/server";
import { Mppx } from "mppx/server";
import { evmCharge } from "../../../../src/mpp/evm-server";

const PORT = process.env.PORT || 4404;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

// SKALE Base config (gas-free!)
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET || "0xB855bb7D5dd48Ef84D9cDbb9BAc59a680C080D3d";
const CHAIN_ID = 1187947933;
const USDC_ADDRESS = "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20";
const RPC_URL = process.env.SKALE_RPC_URL || "https://skale-base.skalenodes.com/v1/base";
const NETWORK_NAME = "skale-base";
const DECIMALS = 6;

// ── Create mppx server handler ──────────────────────────────────────────────
const mppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [
    evmCharge({
      recipient: RECIPIENT_WALLET,
      tokenAddress: USDC_ADDRESS,
      chainId: CHAIN_ID,
      rpcUrl: RPC_URL,
      decimals: DECIMALS,
      network: NETWORK_NAME,
    }),
  ],
});

// Wrap mppx to convert USD amount → base units
const handlerCache = new Map<string, ReturnType<typeof mppx.charge>>();
const mppEvmWrapper = {
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
  network: "skale-base",
  mpp: mppEvmWrapper as any,
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
      data: "This is premium content paid via MPP EVM on SKALE!",
      timestamp: new Date().toISOString(),
      paidBy: (_req as any).x402Payer || "unknown",
      transaction: (_req as any).x402Transaction || null,
    });
  }
);

app.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  MPP EVM Example Server (SKALE Base — gas-free)          ║
║  Listening on http://localhost:${PORT}                      ║
║                                                          ║
║  Endpoints:                                              ║
║    GET  /health     - Free health check                  ║
║    GET  /api/data   - $0.01 (MPP EVM or x402)            ║
║                                                          ║
║  Chain: ${NETWORK_NAME} (${CHAIN_ID})                    ║
║  USDC:  ${USDC_ADDRESS.slice(0, 10)}...${USDC_ADDRESS.slice(-4)}                    ║
║  Recipient: ${RECIPIENT_WALLET.slice(0, 10)}...${RECIPIENT_WALLET.slice(-4)}          ║
╚══════════════════════════════════════════════════════════╝
`);
});
