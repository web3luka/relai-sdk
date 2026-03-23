/**
 * Express server protected by MPP EVM payments (Base USDC) via @relai-fi/x402.
 *
 * Usage:
 *   npx tsx examples/server/http/evm/mpp-base.ts
 *
 * Client:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/client/http/evm/mpp.ts http://localhost:4404
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../../src/server";
import { Mppx } from "mppx/server";
import { evmCharge } from "../../../../src/mpp/evm-server";

const PORT = process.env.PORT || 4404;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET || "0xB855bb7D5dd48Ef84D9cDbb9BAc59a680C080D3d";
const CHAIN_ID = 8453;
const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const RPC_URL = "https://mainnet.base.org";
const NETWORK_NAME = "base";
const DECIMALS = 6;

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

const relai = new Relai({ network: "base", mpp: mppEvmWrapper as any });

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.get(
  "/api/data",
  relai.protect({ payTo: RECIPIENT_WALLET, price: 0.01, description: "Premium data endpoint" }),
  (_req, res) => {
    res.json({
      data: "Paid via MPP EVM on Base!",
      timestamp: new Date().toISOString(),
      paidBy: (_req as any).x402Payer || "unknown",
    });
  }
);

app.listen(PORT, () => {
  console.log(`MPP EVM Base server on http://localhost:${PORT} — $0.01/request`);
});
