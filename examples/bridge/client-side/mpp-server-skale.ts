/**
 * CLIENT-SIDE BRIDGE — Standard SKALE server (no bridge awareness)
 *
 * This server only exposes evm/charge on SKALE. It knows NOTHING about
 * bridging. The client handles cross-chain routing transparently using
 * evmChargeWithBridge() — the server just sees a normal ERC-20 transfer.
 *
 * Pair with:
 *   client-tempo-to-skale.ts  (MPP client, Tempo → SKALE)
 *
 * Usage:
 *   npx tsx examples/bridge/client-side/server-skale.ts
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../src/server";
import { Mppx } from "mppx/server";
import { evmCharge } from "../../../src/mpp/evm-server";

const PORT = process.env.PORT || 4410;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

const RECIPIENT = process.env.RECIPIENT_WALLET || "0xB855bb7D5dd48Ef84D9cDbb9BAc59a680C080D3d";
const CHAIN_ID = 1187947933;
const USDC = "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20";
const RPC = process.env.SKALE_RPC_URL || "https://skale-base.skalenodes.com/v1/base";
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
      network: "skale-base",
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

const relai = new Relai({ network: "skale-base", mpp: mppWrapper as any });
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get(
  "/api/data",
  relai.protect({
    payTo: RECIPIENT,
    price: 0.10,
    description: "Premium data — $0.10 on SKALE",
    onPaymentSettled: (_req, result) => {
      console.log(`[Server] Payment settled: tx=${result.transaction}`);
    },
  }),
  (_req, res) => {
    res.json({ data: "Premium content from SKALE!", note: "Server has NO bridge config." });
  }
);

app.listen(PORT, () => {
  console.log(`
  CLIENT-SIDE BRIDGE — Standard SKALE Server
  http://localhost:${PORT}

  Methods:  evm/charge only (no bridge)
  GET /health   — free
  GET /api/data — $0.10 (SKALE USDC)
`);
});
