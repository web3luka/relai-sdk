/**
 * SERVER-SIDE BRIDGE — SKALE server exposing evm/charge + bridge/charge
 *
 * This server explicitly advertises two payment methods:
 *   - evm/charge    → direct SKALE payment (for clients with a SKALE wallet)
 *   - bridge/charge → cross-chain via RelAI bridge (Tempo, Base, Solana → SKALE)
 *
 * The client receives both challenges and picks the one it can handle.
 * The server verifies the target tx on SKALE in both cases.
 *
 * Pair with:
 *   client-tempo-to-skale.ts  (MPP client, Tempo → SKALE via bridge/charge)
 *
 * Usage:
 *   npx tsx examples/bridge/server-side/server-skale.ts
 */
import "dotenv/config";
import express from "express";
import { Mppx } from "mppx/server";
import { evmCharge } from "../../../src/mpp/evm-server";
import { bridgeCharge } from "../../../src/mpp/bridge-server";

const PORT = process.env.PORT || 4413;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

const RECIPIENT = process.env.RECIPIENT_WALLET || "0xF6abF8FBDc740786658275Acf7Dc333cFcae5F9b";
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
    bridgeCharge({
      recipient: RECIPIENT,
      tokenAddress: USDC,
      chainId: CHAIN_ID,
      rpcUrl: RPC,
      decimals: DECIMALS,
      network: "skale-base",
    }),
  ],
});

function usdToBaseUnits(usd: string): string {
  return Math.round(parseFloat(usd) * 10 ** DECIMALS).toString();
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get("/api/data", async (req, res) => {
  const amount = usdToBaseUnits("0.10");

  const handler = mppx.compose(
    ["evm/charge", { amount }],
    ["bridge/charge", { amount }],
  );

  const mppUrl = `${req.protocol}://${req.get("host")}${req.originalUrl}`;
  const mppHeaders = new Headers();
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === "string") mppHeaders.set(k, v);
  }
  const result = await handler(new Request(mppUrl, { method: req.method, headers: mppHeaders }));

  if (result.status === 402 && (result as any).challenge) {
    const challengeRes = (result as any).challenge as Response;
    res.status(402);
    const wwwAuth = challengeRes.headers.get("www-authenticate");
    if (wwwAuth) res.setHeader("WWW-Authenticate", wwwAuth);
    const contentType = challengeRes.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    return res.send(await challengeRes.text());
  }

  if ((result as any).withReceipt) {
    const dataResponse = new Response(
      JSON.stringify({ data: "Premium content from SKALE!", note: "Paid via evm/charge or bridge/charge." }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
    const receiptResponse = (result as any).withReceipt(dataResponse);
    res.status(receiptResponse.status);
    receiptResponse.headers.forEach((v: string, k: string) => res.setHeader(k, v));
    return res.send(await receiptResponse.text());
  }

  res.status(500).json({ error: "Unexpected MPP result" });
});

app.listen(PORT, () => {
  console.log(`
  SERVER-SIDE BRIDGE — SKALE Server
  http://localhost:${PORT}

  Methods:
    evm/charge    — direct SKALE payment
    bridge/charge — cross-chain (Tempo/Base/Solana -> SKALE)

  GET /health   — free
  GET /api/data — $0.10
`);
});
