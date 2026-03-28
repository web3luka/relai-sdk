/**
 * Comprehensive functional test runner — all protocol × channel × chain combinations.
 *
 * Usage:
 *   npx tsx examples/test-all.ts
 *
 * Requires .env with: EVM_PRIVATE_KEY, TEMPO_PRIVATE_KEY, SOLANA_PRIVATE_KEY,
 *   MPP_SECRET_KEY, RECIPIENT_WALLET, SOLANA_RECIPIENT_WALLET
 */
import "dotenv/config";
import http from "http";
import express from "express";
import Relai from "../../src/server";
import { Mppx, tempo } from "mppx/server";
import { Mppx as MppxClient, tempo as tempoClient } from "mppx/client";
import { Mppx as MppxSolServer, solana as solanaServer } from "@solana/mpp/server";
import { Mppx as MppxSolClient, solana as solanaClient } from "@solana/mpp/client";
import { evmCharge as evmChargeServer } from "../../src/mpp/evm-server";
import { evmCharge as evmChargeClient } from "../../src/mpp/evm-client";
import { evmChargeWithBridge } from "../../src/mpp/with-bridge";
import { createX402Client, type MppHandler } from "../../src/client";
import { privateKeyToAccount } from "viem/accounts";
import { createKeyPairSignerFromBytes } from "@solana/kit";
import { Keypair, VersionedTransaction } from "@solana/web3.js";
// @ts-ignore — bs58 has no type declarations
import bs58 from "bs58";
import pkg from "ws";

// ---------------------------------------------------------------------------
// Solana fetch patch: force skipPreflight on sendTransaction (same as mpp-solana-server)
// ---------------------------------------------------------------------------
const _origFetch = globalThis.fetch;
globalThis.fetch = async (...args: Parameters<typeof fetch>) => {
  const [url, opts] = args;
  if (opts?.body && typeof opts.body === "string") {
    try {
      const body = JSON.parse(opts.body);
      if (body.method === "sendTransaction" && body.params?.[1]) {
        body.params[1] = { ...body.params[1], skipPreflight: true };
        return _origFetch(url, { ...opts, body: JSON.stringify(body) });
      }
    } catch {}
  }
  return _origFetch(...args);
};

const WebSocketServer = pkg.Server;

// ── Config ──────────────────────────────────────────────────────────────────
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET!;
const SOLANA_RECIPIENT = process.env.SOLANA_RECIPIENT_WALLET || process.env.RECIPIENT_WALLET!;
const SOLANA_KEY = process.env.SOLANA_PRIVATE_KEY;
const SOLANA_RPC = process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
const EVM_KEY = process.env.EVM_PRIVATE_KEY!;
const TEMPO_KEY = process.env.TEMPO_PRIVATE_KEY || EVM_KEY;

if (!EVM_KEY || !RECIPIENT_WALLET) {
  console.error("Missing EVM_PRIVATE_KEY or RECIPIENT_WALLET in .env");
  process.exit(1);
}

const evmAccount = privateKeyToAccount(EVM_KEY as `0x${string}`);
const tempoAccount = privateKeyToAccount(TEMPO_KEY as `0x${string}`);

// Solana signers (optional — skip Solana tests if not configured)
let solanaSigner: any = null;       // @solana/kit signer for MPP
let solanaKeypair: Keypair | null = null; // @solana/web3.js Keypair for x402
if (SOLANA_KEY) {
  const secretBytes = bs58.decode(SOLANA_KEY);
  solanaSigner = await createKeyPairSignerFromBytes(new Uint8Array(secretBytes));
  solanaKeypair = Keypair.fromSecretKey(new Uint8Array(secretBytes));
}

const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";
const BASE_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const SKALE_USDC = "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20";
const SOLANA_USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// ── Results tracking ────────────────────────────────────────────────────────
type Result = { protocol: string; channel: string; chain: string; status: string; detail: string };
const results: Result[] = [];

function record(protocol: string, channel: string, chain: string, status: string, detail = "") {
  results.push({ protocol, channel, chain, status, detail });
  const icon = status === "PASS" ? "✅" : status === "FAIL" ? "❌" : "⚠️";
  console.log(`  ${icon} ${protocol} + ${channel} + ${chain}: ${status}${detail ? ` — ${detail}` : ""}`);
}

// ── Server factory ──────────────────────────────────────────────────────────
interface ServerConfig {
  port: number;
  network: "base" | "skale-base" | "solana";
  mppMethods?: any[];
  mppOverride?: any; // pre-built mpp handler (for Solana wrapper)
  label: string;
  payTo?: string;
  price?: number;
}

async function startServer(config: ServerConfig): Promise<http.Server> {
  let mpp: any;
  if (config.mppOverride) {
    mpp = config.mppOverride;
  } else {
    const mppx = Mppx.create({
      secretKey: MPP_SECRET_KEY,
      methods: config.mppMethods || [],
    });
    mpp = mppx;
  }

  const relai = new Relai({ network: config.network, mpp });

  const protectData = relai.protect({
    payTo: config.payTo || RECIPIENT_WALLET,
    price: config.price || 0.01,
    description: "Test endpoint",
  });

  const handle = (_req: any, res: any) => {
    res.json({
      ok: true,
      paidBy: _req.x402Payer || "unknown",
      transaction: _req.x402Transaction || null,
    });
  };

  const app = express();
  app.use(express.json());
  app.get("/health", (_req, res) => res.json({ status: "ok" }));
  app.get("/api/data", protectData, handle);
  app.post("/api/data", protectData, handle);

  // Relay routes
  const relayRouter = express.Router({ mergeParams: true });
  relayRouter.get("/health", (_req, res) => res.json({ status: "ok" }));
  relayRouter.get("/api/data", protectData, handle);
  relayRouter.post("/api/data", protectData, handle);
  app.use("/relay/:apiId", relayRouter);

  const server = http.createServer(app);

  // WS relay
  const wss = new WebSocketServer({ server, path: "/api/ws/relay" });
  wss.on("connection", (ws: InstanceType<typeof pkg>) => {
    ws.on("message", async (raw: any) => {
      let envelope: any;
      try { envelope = JSON.parse(raw.toString()); } catch { return; }

      const { id, params } = envelope;
      const path = params?.path || "/";
      const method = params?.requestMethod || "GET";
      const headers: Record<string, string> = { ...(params?.requestHeaders || {}) };
      const body = params?.requestBody;

      if (envelope.payment) {
        headers["X-PAYMENT"] = Buffer.from(JSON.stringify(envelope.payment)).toString("base64");
      }

      try {
        const fetchHeaders: Record<string, string> = { ...headers, host: `127.0.0.1:${config.port}` };
        if (body && !fetchHeaders["content-type"] && !fetchHeaders["Content-Type"]) {
          fetchHeaders["Content-Type"] = "application/json";
        }
        const response = await fetch(`http://127.0.0.1:${config.port}${path}`, {
          method,
          headers: fetchHeaders,
          ...(body && method !== "GET" && method !== "HEAD"
            ? { body: typeof body === "string" ? body : JSON.stringify(body) }
            : {}),
        });

        if (response.status === 402) {
          const wwwAuth = response.headers.get("www-authenticate");
          let responseBody: any = null;
          try { responseBody = await response.json(); } catch {}
          const wsError: any = { code: 402, message: "Payment required" };
          if (responseBody?.accepts || responseBody?.x402Version) wsError.paymentRequired = responseBody;
          if (wwwAuth && /^Payment\s+/i.test(wwwAuth.trim())) wsError.mppChallenge = wwwAuth;
          ws.send(JSON.stringify({ id, error: wsError }));
          return;
        }

        let resultBody: any = null;
        try { resultBody = await response.json(); } catch {}
        const pr = response.headers.get("payment-response");
        ws.send(JSON.stringify({
          id,
          result: resultBody,
          ...(pr ? { paymentResponse: JSON.parse(Buffer.from(pr, "base64").toString()) } : {}),
          metadata: { status: response.status },
        }));
      } catch (err: any) {
        ws.send(JSON.stringify({ id, error: { code: 502, message: err.message } }));
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(config.port, () => resolve(server));
  });
}

// ── Client factories ────────────────────────────────────────────────────────
function makeMppTempoClient(): MppHandler {
  return MppxClient.create({
    methods: [tempoClient.charge({ account: tempoAccount })],
    polyfill: false,
  });
}

function makeMppEvmClient(): MppHandler {
  return MppxClient.create({
    methods: [evmChargeClient({ account: evmAccount })],
    polyfill: false,
  });
}

function makeMppSolanaClient(): MppHandler {
  if (!solanaSigner) throw new Error("SOLANA_PRIVATE_KEY not set");
  return MppxSolClient.create({
    methods: [solanaClient.charge({ signer: solanaSigner })],
    polyfill: false,
  });
}

function makeMppBridgeFromBase(): MppHandler {
  return MppxClient.create({
    methods: [evmChargeWithBridge({ evmAccount, sourceChainId: 8453, sourceRpcUrl: "https://mainnet.base.org" })],
    polyfill: false,
  });
}

function makeMppBridgeFromSkale(): MppHandler {
  return MppxClient.create({
    methods: [evmChargeWithBridge({ evmAccount, sourceChainId: 1187947933, sourceRpcUrl: "https://skale-base.skalenodes.com/v1/base" })],
    polyfill: false,
  });
}

function makeMppBridgeFromSolana(): MppHandler {
  if (!solanaKeypair) throw new Error("SOLANA_PRIVATE_KEY not set");
  return MppxClient.create({
    methods: [evmChargeWithBridge({ solanaKeypair, solanaRpcUrl: SOLANA_RPC })],
    polyfill: false,
  });
}

function makeX402HttpClient(mpp?: MppHandler, opts?: { solana?: boolean }) {
  return createX402Client({
    wallets: {
      evm: {
        address: evmAccount.address,
        signTypedData: (data) => evmAccount.signTypedData(data as any),
      },
      ...(opts?.solana && solanaKeypair ? {
        solana: {
          publicKey: solanaKeypair.publicKey,
          signTransaction: async (tx: any) => {
            if (tx instanceof VersionedTransaction) {
              tx.sign([solanaKeypair!]);
              return tx;
            }
            tx.partialSign(solanaKeypair!);
            return tx;
          },
        },
      } : {}),
    },
    ...(mpp ? { mpp } : {}),
    solanaRpcUrl: SOLANA_RPC,
    verbose: false,
  });
}

function makeX402WsClient(mpp?: MppHandler, opts?: { solana?: boolean }) {
  return createX402Client({
    wallets: {
      evm: {
        address: evmAccount.address,
        signTypedData: (data) => evmAccount.signTypedData(data as any),
      },
      ...(opts?.solana && solanaKeypair ? {
        solana: {
          publicKey: solanaKeypair.publicKey,
          signTransaction: async (tx: any) => {
            if (tx instanceof VersionedTransaction) {
              tx.sign([solanaKeypair!]);
              return tx;
            }
            tx.partialSign(solanaKeypair!);
            return tx;
          },
        },
      } : {}),
    },
    ...(mpp ? { mpp } : {}),
    solanaRpcUrl: SOLANA_RPC,
    relayWs: {
      enabled: true,
      webSocketFactory: (url) => new pkg(url) as any,
      preflightTimeoutMs: 10000,
      paymentTimeoutMs: 15000,
      fallbackToHttp: false,
    },
    verbose: false,
  });
}

// ── Test runner ─────────────────────────────────────────────────────────────
async function testFetch(
  protocol: string, channel: string, chain: string,
  client: { fetch: typeof fetch }, url: string,
) {
  try {
    const res = await client.fetch(url, { method: "GET" });
    const body = await res.json() as any;
    if (res.status === 200 && body?.ok) {
      record(protocol, channel, chain, "PASS", `paidBy=${body.paidBy}`);
    } else {
      const errStr = JSON.stringify(body)?.slice(0, 100) || "";
      if (errStr.includes("exceeds balance") || errStr.includes("replacement") || errStr.includes("underpriced")) {
        record(protocol, channel, chain, "NO_USDC", `status=${res.status} (nonce/balance issue)`);
      } else {
        record(protocol, channel, chain, "FAIL", `status=${res.status}`);
      }
    }
  } catch (err: any) {
    const msg = err.message?.slice(0, 80) || String(err);
    if (msg.includes("exceeds balance") || msg.includes("insufficient") || msg.includes("No wallet available")) {
      record(protocol, channel, chain, "NO_USDC", msg);
    } else if (msg.includes("Non-base58") || msg.includes("feePayer") || msg.includes("Missing feePayer")) {
      record(protocol, channel, chain, "NO_FACILITATOR", "needs facilitator feePayer");
    } else {
      record(protocol, channel, chain, "FAIL", msg);
    }
  }
}

// ── Main ────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\nWallet: ${evmAccount.address}\n`);

  // Start servers
  // Port 4410: Base + Tempo MPP
  // Port 4411: SKALE + Tempo MPP
  // Port 4412: Base + EVM charge MPP (Base USDC)
  // Port 4413: SKALE + EVM charge MPP (SKALE USDC)
  console.log("Starting servers...");

  const servers = await Promise.all([
    startServer({
      port: 4410, network: "base", label: "Base + Tempo MPP",
      mppMethods: [tempo.charge({ recipient: RECIPIENT_WALLET, currency: TEMPO_USDC, decimals: 6 })],
    }),
    startServer({
      port: 4411, network: "skale-base", label: "SKALE + Tempo MPP",
      mppMethods: [tempo.charge({ recipient: RECIPIENT_WALLET, currency: TEMPO_USDC, decimals: 6 })],
    }),
    startServer({
      port: 4412, network: "base", label: "Base + EVM charge MPP",
      mppMethods: [evmChargeServer({
        recipient: RECIPIENT_WALLET, tokenAddress: BASE_USDC,
        chainId: 8453, rpcUrl: "https://mainnet.base.org", decimals: 6, network: "base",
      })],
    }),
    startServer({
      port: 4413, network: "skale-base", label: "SKALE + EVM charge MPP",
      mppMethods: [evmChargeServer({
        recipient: RECIPIENT_WALLET, tokenAddress: SKALE_USDC,
        chainId: 1187947933, rpcUrl: "https://skale-base.skalenodes.com/v1/base", decimals: 6, network: "skale-base",
      })],
    }),
  ]);

  // Port 4415: Tempo + EVM charge MPP (bridge destination)
  const mppxEvmTempo = Mppx.create({
    secretKey: MPP_SECRET_KEY,
    methods: [evmChargeServer({
      recipient: RECIPIENT_WALLET, tokenAddress: TEMPO_USDC,
      chainId: 4217, rpcUrl: "https://rpc.tempo.xyz", decimals: 6, network: "base",
    })],
  });
  const tempoCache = new Map<string, ReturnType<typeof mppxEvmTempo.charge>>();
  const wrapTempo = {
    charge(params: Record<string, unknown>) {
      const usdAmount = parseFloat(params.amount as string);
      const baseUnits = Math.round(usdAmount * 10 ** 6).toString();
      if (!tempoCache.has(baseUnits)) {
        tempoCache.set(baseUnits, mppxEvmTempo.charge({ ...params, amount: baseUnits }));
      }
      return tempoCache.get(baseUnits)!;
    },
  };
  servers.push(await startServer({
    port: 4415, network: "base", label: "Tempo EVM (bridge dest)",
    mppOverride: wrapTempo,
    price: 0.05,
  }));

  // Port 4414: Solana + MPP Solana
  if (solanaSigner) {
    const solMppx = MppxSolServer.create({
      secretKey: MPP_SECRET_KEY,
      methods: [solanaServer.charge({
        recipient: SOLANA_RECIPIENT,
        currency: SOLANA_USDC,
        decimals: 6,
        network: "mainnet-beta",
        ...(SOLANA_RPC ? { rpcUrl: SOLANA_RPC } : {}),
      })],
    });
    const DECIMALS = 6;
    const handlerCache = new Map<string, ReturnType<typeof solMppx.charge>>();
    const solWrapper = {
      charge(params: Record<string, unknown>) {
        const usdAmount = parseFloat(params.amount as string);
        const baseUnits = Math.round(usdAmount * 10 ** DECIMALS).toString();
        if (!handlerCache.has(baseUnits)) {
          handlerCache.set(baseUnits, solMppx.charge({ ...params, amount: baseUnits }));
        }
        return handlerCache.get(baseUnits)!;
      },
    };
    servers.push(await startServer({
      port: 4414, network: "solana", label: "Solana + MPP Solana",
      mppOverride: solWrapper,
      payTo: SOLANA_RECIPIENT,
    }));
  }

  console.log(`Servers ready on ports 4410-441${solanaSigner ? '5' : '5'}\n`);

  // Small delay between x402 tests to avoid nonce collisions
  const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

  // ════════════════════════════════════════════════════════════════════════
  // MPP Tempo
  // ════════════════════════════════════════════════════════════════════════
  console.log("── MPP Tempo ──────────────────────────────────────────");

  await testFetch("MPP-Tempo", "HTTP", "Base",
    makeX402HttpClient(makeMppTempoClient()), "http://localhost:4410/api/data");

  await testFetch("MPP-Tempo", "HTTP", "SKALE",
    makeX402HttpClient(makeMppTempoClient()), "http://localhost:4411/api/data");

  await testFetch("MPP-Tempo", "WS", "Base",
    makeX402WsClient(makeMppTempoClient()), "http://localhost:4410/relay/test/api/data");

  await testFetch("MPP-Tempo", "WS", "SKALE",
    makeX402WsClient(makeMppTempoClient()), "http://localhost:4411/relay/test/api/data");

  // ════════════════════════════════════════════════════════════════════════
  // MPP EVM Charge
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── MPP EVM Charge ─────────────────────────────────────");

  await testFetch("MPP-EVM", "HTTP", "Base",
    makeX402HttpClient(makeMppEvmClient()), "http://localhost:4412/api/data");

  await testFetch("MPP-EVM", "HTTP", "SKALE",
    makeX402HttpClient(makeMppEvmClient()), "http://localhost:4413/api/data");

  await testFetch("MPP-EVM", "WS", "Base",
    makeX402WsClient(makeMppEvmClient()), "http://localhost:4412/relay/test/api/data");

  await testFetch("MPP-EVM", "WS", "SKALE",
    makeX402WsClient(makeMppEvmClient()), "http://localhost:4413/relay/test/api/data");

  // ════════════════════════════════════════════════════════════════════════
  // x402 (no MPP — pure x402 payment)
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── x402 ───────────────────────────────────────────────");

  await testFetch("x402", "HTTP", "Base",
    makeX402HttpClient(), "http://localhost:4410/api/data");
  await delay(5000); // avoid nonce collision at facilitator

  await testFetch("x402", "WS", "Base",
    makeX402WsClient(), "http://localhost:4410/relay/test/api/data");
  await delay(5000);

  await testFetch("x402", "HTTP", "SKALE",
    makeX402HttpClient(), "http://localhost:4411/api/data");
  await delay(5000);

  await testFetch("x402", "WS", "SKALE",
    makeX402WsClient(), "http://localhost:4411/relay/test/api/data");

  // ════════════════════════════════════════════════════════════════════════
  // Solana
  // ════════════════════════════════════════════════════════════════════════
  if (solanaSigner) {
    console.log("\n── MPP Solana ─────────────────────────────────────────");

    await testFetch("MPP-Sol", "HTTP", "Solana",
      makeX402HttpClient(makeMppSolanaClient()), "http://localhost:4414/api/data");

    await testFetch("MPP-Sol", "WS", "Solana",
      makeX402WsClient(makeMppSolanaClient()), "http://localhost:4414/relay/test/api/data");

    console.log("\n── x402 Solana ────────────────────────────────────────");
    await delay(5000);

    await testFetch("x402", "HTTP", "Solana",
      makeX402HttpClient(undefined, { solana: true }), "http://localhost:4414/api/data");
    await delay(5000);

    await testFetch("x402", "WS", "Solana",
      makeX402WsClient(undefined, { solana: true }), "http://localhost:4414/relay/test/api/data");
  } else {
    console.log("\n── Solana (SKIPPED — no SOLANA_PRIVATE_KEY) ───────────");
    record("MPP-Sol", "HTTP", "Solana", "SKIP", "no SOLANA_PRIVATE_KEY");
    record("MPP-Sol", "WS", "Solana", "SKIP", "no SOLANA_PRIVATE_KEY");
    record("x402", "HTTP", "Solana", "SKIP", "no SOLANA_PRIVATE_KEY");
    record("x402", "WS", "Solana", "SKIP", "no SOLANA_PRIVATE_KEY");
  }

  // ════════════════════════════════════════════════════════════════════════
  // MPP Bridge (cross-chain)
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n── MPP Bridge ─────────────────────────────────────────");

  await testFetch("MPP-Bridge", "HTTP", "Base→Tempo",
    makeX402HttpClient(makeMppBridgeFromBase()), "http://localhost:4415/api/data");

  await testFetch("MPP-Bridge", "WS", "Base→Tempo",
    makeX402WsClient(makeMppBridgeFromBase()), "http://localhost:4415/relay/test/api/data");

  await testFetch("MPP-Bridge", "HTTP", "SKALE→Tempo",
    makeX402HttpClient(makeMppBridgeFromSkale()), "http://localhost:4415/api/data");

  await testFetch("MPP-Bridge", "WS", "SKALE→Tempo",
    makeX402WsClient(makeMppBridgeFromSkale()), "http://localhost:4415/relay/test/api/data");

  if (solanaKeypair) {
    await testFetch("MPP-Bridge", "HTTP", "Solana→Tempo",
      makeX402HttpClient(makeMppBridgeFromSolana()), "http://localhost:4415/api/data");

    await testFetch("MPP-Bridge", "WS", "Solana→Tempo",
      makeX402WsClient(makeMppBridgeFromSolana()), "http://localhost:4415/relay/test/api/data");
  } else {
    record("MPP-Bridge", "HTTP", "Solana→Tempo", "SKIP", "no SOLANA_PRIVATE_KEY");
    record("MPP-Bridge", "WS", "Solana→Tempo", "SKIP", "no SOLANA_PRIVATE_KEY");
  }

  // ════════════════════════════════════════════════════════════════════════
  // Summary
  // ════════════════════════════════════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  SUMMARY");
  console.log("══════════════════════════════════════════════════════════");

  const maxProto = Math.max(...results.map((r) => r.protocol.length));
  const maxChan = Math.max(...results.map((r) => r.channel.length));
  const maxChain = Math.max(...results.map((r) => r.chain.length));

  for (const r of results) {
    const icon = r.status === "PASS" ? "✅" : r.status === "NO_USDC" ? "💰" : r.status === "SKIP" ? "⏭️" : r.status === "NO_FACILITATOR" ? "🔗" : "❌";
    const line = `  ${icon} ${r.protocol.padEnd(maxProto)} │ ${r.channel.padEnd(maxChan)} │ ${r.chain.padEnd(maxChain)} │ ${r.status}`;
    console.log(line + (r.detail ? `  ${r.detail}` : ""));
  }

  const passed = results.filter((r) => r.status === "PASS").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  const noUsdc = results.filter((r) => r.status === "NO_USDC").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const noFac = results.filter((r) => r.status === "NO_FACILITATOR").length;
  console.log(`\n  Total: ${results.length} | ✅ ${passed} | ❌ ${failed} | 💰 ${noUsdc} (no USDC) | 🔗 ${noFac} (no facilitator) | ⏭️  ${skipped} (skipped)\n`);

  // Cleanup
  for (const s of servers) s.close();
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
