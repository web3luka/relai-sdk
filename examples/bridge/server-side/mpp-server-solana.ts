/**
 * SERVER-SIDE BRIDGE — Solana server exposing solana/charge + bridge/charge
 *
 * This server advertises two payment methods:
 *   - solana/charge → direct Solana SPL payment (for clients with a Solana wallet)
 *   - bridge/charge → cross-chain via RelAI bridge (Tempo/Base → Solana)
 *
 * Use this approach when the target chain is NOT EVM (e.g. Solana),
 * because client-side bridging (evmChargeWithBridge) only works for EVM targets.
 *
 * Pair with:
 *   client-tempo-to-solana.ts  (MPP client, Tempo → Solana via bridge/charge)
 *
 * Usage:
 *   npx tsx examples/bridge/server-side/server-solana.ts
 */
import "dotenv/config";
import express from "express";
import { Mppx, solana } from "@solana/mpp/server";
import { bridgeCharge } from "../../../src/mpp/bridge-server";

const PORT = process.env.PORT || 4405;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const RECIPIENT = process.env.SOLANA_RECIPIENT_WALLET || "7UhYt3afz4FTk3kjn8H8NatHkFJ1EdJyLNEp4HXoEYYn";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const SOLANA_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";
const DECIMALS = 6;

const mppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [
    solana.charge({
      recipient: RECIPIENT,
      currency: SOLANA_USDC,
      decimals: DECIMALS,
    }),
    bridgeCharge({
      recipient: RECIPIENT,
      tokenAddress: SOLANA_USDC,
      chainId: 0,  // placeholder — bridge settle uses targetAccept.network
      rpcUrl: SOLANA_RPC,
      network: SOLANA_CAIP2,
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
  const amount = usdToBaseUnits("0.10");  // Bridge minimum is $0.05

  const handler = mppx.compose(
    ["solana/charge", { amount }],
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
      JSON.stringify({ data: "Premium content!", note: "Paid via solana/charge or bridge/charge." }),
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
  SERVER-SIDE BRIDGE — Solana Server
  http://localhost:${PORT}

  Methods:
    solana/charge — direct Solana SPL payment
    bridge/charge — cross-chain (Tempo/Base -> Solana)

  GET /health   — free
  GET /api/data — $0.01
`);
});
