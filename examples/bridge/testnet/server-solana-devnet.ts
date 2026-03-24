/**
 * TESTNET SERVER — MPP server-side bridge on Solana Devnet
 *
 * Exposes solana/charge + bridge/charge for cross-chain payments.
 *
 * Chain: Solana Devnet (solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1)
 * USDC:  4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 * RPC:   https://api.devnet.solana.com
 *
 * Use with mpp-skale-sepolia-to-solana-devnet.ts client.
 *
 * Usage:
 *   npx tsx examples/bridge/testnet/server-solana-devnet.ts
 */
import "dotenv/config";
import express from "express";
import { Mppx, solana } from "@solana/mpp/server";
import { bridgeCharge } from "../../../src/mpp/bridge-server";

const PORT = process.env.PORT || 4422;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

const SOLANA_RPC = "https://api.devnet.solana.com";
const RECIPIENT = process.env.SOLANA_RECIPIENT_WALLET || "CZY8X43V2txfRLWgif59NpDDqTQPnue1CbFH7iCBMZ8n";
const SOLANA_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const SOLANA_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
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
      chainId: 0,
      rpcUrl: SOLANA_RPC,
      network: SOLANA_CAIP2,
      // Static testnet config — no auto-discovery from production API
      settleEndpoint: "https://api.relai.fi/bridge/settle",
      supportedSourceChains: [
        "eip155:324705682",  // SKALE Base Sepolia
        "eip155:42431",      // Tempo Moderato
      ],
      supportedSourceAssets: [
        "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD",  // USDC SKALE Sepolia
        "0x20c0000000000000000000000000000000000000",    // pathUSD Moderato
      ],
      payTo: {
        "eip155:324705682": "0x1892f72fdB3A966b2AD8595aA5f7741Ef72d6085",
        "eip155:42431": "0x1892f72fdB3A966b2AD8595aA5f7741Ef72d6085",
      },
      feeBps: 100,
    }),
  ],
});

function usdToBaseUnits(usd: string): string {
  return Math.round(parseFloat(usd) * 10 ** DECIMALS).toString();
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", network: "solana-devnet" }));

app.get("/api/data", async (req, res) => {
  const amount = usdToBaseUnits("0.10");

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
      JSON.stringify({ data: "Testnet content from Solana Devnet!", network: "solana-devnet" }),
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
  TESTNET — Solana Devnet Server (bridge/charge)
  http://localhost:${PORT}
  USDC: ${SOLANA_USDC}
  Methods: solana/charge + bridge/charge
  GET /health   — free
  GET /api/data — $0.10
`);
});
