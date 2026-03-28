/**
 * WebSocket + HTTP relay server for x402 payments (no MPP).
 *
 * This server acts as a local relay that:
 *   - Serves HTTP routes protected by x402 via the RelAI facilitator
 *   - Provides a WS relay at /api/ws/relay that proxies to the same HTTP routes
 *
 * The WS relay protocol:
 *   1. Client connects to ws://localhost:<port>/api/ws/relay
 *   2. Client sends { id, method: "relay.call", params: { path, requestMethod, ... } }
 *   3. Server proxies to its own HTTP backend, forwards 402/200 responses via WS
 *   4. Client signs x402 payment, retries with payment in envelope
 *
 * Usage:
 *   npx tsx examples/server/ws/x402-relay.ts
 *
 * Then test with:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/client/ws/evm/x402-base.ts ws://localhost:4415
 *   SOLANA_PRIVATE_KEY=... npx tsx examples/client/ws/solana/x402.ts ws://localhost:4415
 */
import "dotenv/config";
import http from "http";
import express from "express";
import Relai from "../../../src/server";
import pkg from "ws";

const WebSocketServer = pkg.Server;
type WS = InstanceType<typeof pkg>;

const PORT = parseInt(process.env.PORT || "4415", 10);
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET || "0xB855bb7D5dd48Ef84D9cDbb9BAc59a680C080D3d";

// ── Create Relai instance (x402 only — no MPP) ─────────────────────────────
const relai = new Relai({ network: "base" });

// ── Express app (the "backend" behind the relay) ────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Protected endpoint — $0.01 via x402
const protectData = relai.protect({
  payTo: RECIPIENT_WALLET,
  price: 0.01,
  description: "Premium data endpoint",
  onPaymentRequired: (_req, info) => {
    console.log(`[HTTP] 402 returned: $${info.price} on ${info.network}`);
  },
  onPaymentSettled: (_req, result) => {
    console.log(`[HTTP] Payment settled: tx=${result.transaction}, payer=${result.payer}`);
  },
});

function handleData(_req: any, res: any) {
  res.json({
    message: "Premium content — paid via x402!",
    timestamp: new Date().toISOString(),
    paidBy: _req.x402Payer || "unknown",
    transaction: _req.x402Transaction || null,
  });
}

// Shared router for all protected + free routes
const apiRouter = express.Router();

apiRouter.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});
apiRouter.get("/api/data", protectData, handleData);
apiRouter.post("/api/data", protectData, handleData);
apiRouter.get("/v1/{*path}", protectData, handleData);
apiRouter.post("/v1/{*path}", protectData, handleData);

// Direct HTTP access
app.use("/", apiRouter);

// Relay HTTP access: /relay/:apiId/* → same routes
app.use("/relay/:apiId", apiRouter);

// ── HTTP server ─────────────────────────────────────────────────────────────
const server = http.createServer(app);

// ── WebSocket relay ─────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server, path: "/api/ws/relay" });

wss.on("connection", (ws: WS) => {
  console.log("[WS] Client connected");

  ws.on("message", async (raw: any) => {
    let envelope: any;
    try {
      envelope = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ error: { code: 400, message: "Invalid JSON" } }));
      return;
    }

    const { id, params } = envelope;
    const path = params?.path || "/";
    const method = params?.requestMethod || "GET";
    const headers: Record<string, string> = params?.requestHeaders || {};
    const body = params?.requestBody;

    // If client sent x402 payment, add it as X-PAYMENT header
    if (envelope.payment) {
      const paymentB64 = Buffer.from(JSON.stringify(envelope.payment)).toString("base64");
      headers["X-PAYMENT"] = paymentB64;
    }

    console.log(
      `[WS] relay.call path=${path} method=${method}` +
        (envelope.payment ? " [x402 payment]" : ""),
    );

    // Proxy to internal HTTP backend
    try {
      const internalUrl = `http://127.0.0.1:${PORT}${path}`;
      const fetchHeaders: Record<string, string> = { ...headers };
      fetchHeaders["host"] = `127.0.0.1:${PORT}`;

      const fetchInit: RequestInit = {
        method,
        headers: fetchHeaders,
        ...(body && method !== "GET" && method !== "HEAD"
          ? { body: typeof body === "string" ? body : JSON.stringify(body) }
          : {}),
      };

      if (body && !fetchHeaders["content-type"] && !fetchHeaders["Content-Type"]) {
        fetchHeaders["Content-Type"] = "application/json";
      }

      const response = await fetch(internalUrl, fetchInit);

      if (response.status === 402) {
        // Parse the 402 response and forward as WS error
        let responseBody: any = null;
        try {
          responseBody = await response.json();
        } catch {}

        const wsError: any = {
          code: 402,
          message: "Payment required",
        };

        // Forward x402 requirements
        if (responseBody?.accepts || responseBody?.x402Version) {
          wsError.paymentRequired = responseBody;
        }

        console.log(`[WS] → 402` + (wsError.paymentRequired ? " [x402 requirements]" : ""));

        ws.send(JSON.stringify({ id, error: wsError }));
        return;
      }

      // Forward success response
      let resultBody: any = null;
      try {
        resultBody = await response.json();
      } catch {}

      const paymentResponseHeader = response.headers.get("payment-response");

      console.log(`[WS] → ${response.status}`);

      ws.send(
        JSON.stringify({
          id,
          result: resultBody,
          ...(paymentResponseHeader
            ? { paymentResponse: JSON.parse(Buffer.from(paymentResponseHeader, "base64").toString()) }
            : {}),
          metadata: { status: response.status },
        }),
      );
    } catch (err: any) {
      console.error(`[WS] Proxy error: ${err.message}`);
      ws.send(
        JSON.stringify({
          id,
          error: { code: 502, message: `Relay proxy error: ${err.message}` },
        }),
      );
    }
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
  });
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  WS + HTTP Relay Server (x402 only)                      ║
║  Listening on http://localhost:${PORT}                      ║
║  WebSocket:  ws://localhost:${PORT}/api/ws/relay             ║
║                                                          ║
║  HTTP endpoints (direct):                                ║
║    GET  /health        - Free                            ║
║    GET  /api/data      - $0.01 (x402 via facilitator)    ║
║    POST /v1/*          - $0.01 (x402 via facilitator)    ║
║                                                          ║
║  Relay (HTTP or WS):                                     ║
║    /relay/<apiId>/v1/data                                ║
║    /relay/<apiId>/health                                 ║
║                                                          ║
║  Network:   Base (eip155:8453)                           ║
║  Recipient: ${RECIPIENT_WALLET.slice(0, 10)}...${RECIPIENT_WALLET.slice(-4)}          ║
╚══════════════════════════════════════════════════════════╝
`);
});
