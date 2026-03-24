/**
 * CLIENT-SIDE BRIDGE — Standard Base server (no bridge awareness)
 *
 * This server only exposes evm/charge on Base. It knows NOTHING about
 * bridging. The client handles cross-chain routing transparently.
 *
 * Pair with:
 *   client-tempo-to-base.ts  (MPP client, Tempo → Base)
 *
 * Usage:
 *   npx tsx examples/bridge/client-side/server-base.ts
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../src/server";
import { Mppx } from "mppx/server";
import { evmCharge } from "../../../src/mpp/evm-server";

const PORT = process.env.PORT || 4412;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

const RECIPIENT = process.env.RECIPIENT_WALLET || "0xF6abF8FBDc740786658275Acf7Dc333cFcae5F9b";
const CHAIN_ID = 8453;
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC = "https://mainnet.base.org";
const DECIMALS = 6;

const mppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [
    evmCharge({
      recipient: RECIPIENT,
      tokenAddress: USDC,
      chainId: CHAIN_ID,
      rpcUrl: RPC,
      decimals: DECIMALS,
      network: "base",
    }),
  ],
});

const handlerCache = new Map<string, ReturnType<typeof mppx.charge>>();
const mppWrapper = {
  charge(params: Record<string, unknown>) {
    const baseUnits = Math.round(parseFloat(params.amount as string) * 10 ** DECIMALS).toString();
    if (!handlerCache.has(baseUnits)) {
      handlerCache.set(baseUnits, mppx.charge({ ...params, amount: baseUnits }));
    }
    return handlerCache.get(baseUnits)!;
  },
};

const relai = new Relai({ network: "base", mpp: mppWrapper as any });
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get(
  "/api/data",
  relai.protect({
    payTo: RECIPIENT,
    price: 0.10,
    description: "Premium data — $0.10 on Base",
    onPaymentSettled: (_req, result) => {
      console.log(`[Server] Payment settled: tx=${result.transaction}`);
    },
  }),
  (_req, res) => {
    res.json({ data: "Premium content from Base!", note: "Server has NO bridge config." });
  }
);

app.listen(PORT, () => {
  console.log(`
  CLIENT-SIDE BRIDGE — Standard Base Server
  http://localhost:${PORT}

  Methods:  evm/charge only (no bridge)
  GET /health   — free
  GET /api/data — $0.10 (Base USDC)
`);
});
