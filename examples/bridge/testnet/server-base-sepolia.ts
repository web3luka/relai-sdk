/**
 * TESTNET SERVER — Base Sepolia with evm/charge + bridge/charge
 *
 * Chain: Base Sepolia (eip155:84532)
 * USDC:  0x036CbD53842c5426634e7929541eC2318f3dCF7e
 * RPC:   https://sepolia.base.org
 *
 * Static testnet bridge config (no auto-discovery from production API).
 *
 * Pair with:
 *   mpp-tempo-moderato-to-base-sepolia.ts
 *   x402-solana-devnet-to-base-sepolia.ts
 *
 * Prerequisites:
 *   - ETH on Base Sepolia: https://faucets.chain.link/base-sepolia
 *   - USDC on Base Sepolia: https://faucet.circle.com (select Base Sepolia)
 *
 * Usage:
 *   npx tsx examples/bridge/testnet/server-base-sepolia.ts
 */
import "dotenv/config";
import express from "express";
import { Mppx } from "mppx/server";
import { evmCharge } from "../../../src/mpp/evm-server";
import { bridgeCharge } from "../../../src/mpp/bridge-server";

const PORT = process.env.PORT || 4421;
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";

const RECIPIENT = process.env.RECIPIENT_WALLET || "0xF6abF8FBDc740786658275Acf7Dc333cFcae5F9b";
const CHAIN_ID = 84532;
const USDC = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
const RPC = "https://sepolia.base.org";
const DECIMALS = 6;

// Static testnet bridge config
const TESTNET_BRIDGE_SETTLE = "https://api.relai.fi/bridge/settle";
const TESTNET_SOURCE_CHAINS = [
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",  // Solana Devnet
  "eip155:42431",                                 // Tempo Moderato
  "eip155:324705682",                             // SKALE Base Sepolia
];
const TESTNET_SOURCE_ASSETS = [
  "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",  // USDC Devnet
  "0x20c0000000000000000000000000000000000000",       // pathUSD Moderato
  "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD",      // USDC SKALE Sepolia
];
const TESTNET_PAY_TO: Record<string, string> = {
  "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1": "D1rUgfkappgDW4nB9R2DT5ppXWVjxdSHwxRtWb3LRtaY",
  "eip155:42431": "0x1892f72fdB3A966b2AD8595aA5f7741Ef72d6085",
  "eip155:324705682": "0x1892f72fdB3A966b2AD8595aA5f7741Ef72d6085",
};

const mppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [
    evmCharge({
      recipient: RECIPIENT,
      tokenAddress: USDC,
      chainId: CHAIN_ID,
      rpcUrl: RPC,
      decimals: DECIMALS,
      network: "base-sepolia",
    }),
    bridgeCharge({
      recipient: RECIPIENT,
      tokenAddress: USDC,
      chainId: CHAIN_ID,
      rpcUrl: RPC,
      decimals: DECIMALS,
      network: "base-sepolia",
      settleEndpoint: TESTNET_BRIDGE_SETTLE,
      supportedSourceChains: TESTNET_SOURCE_CHAINS,
      supportedSourceAssets: TESTNET_SOURCE_ASSETS,
      payTo: TESTNET_PAY_TO,
      feeBps: 100,
    }),
  ],
});

function usdToBaseUnits(usd: string): string {
  return Math.round(parseFloat(usd) * 10 ** DECIMALS).toString();
}

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", network: "base-sepolia" }));

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
      JSON.stringify({ data: "Testnet content from Base Sepolia!", network: "base-sepolia" }),
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
  TESTNET — Base Sepolia Server (bridge/charge)
  http://localhost:${PORT}
  Chain ID: ${CHAIN_ID}
  USDC: ${USDC}
  Methods: evm/charge + bridge/charge (static testnet config)
  Source chains: ${TESTNET_SOURCE_CHAINS.join(", ")}
  GET /health   — free
  GET /api/data — $0.10
`);
});
