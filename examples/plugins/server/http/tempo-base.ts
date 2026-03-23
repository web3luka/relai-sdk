/**
 * Plugin demo server — freeTier + shield + circuitBreaker + refund
 * with dual-protocol (x402 Base + MPP Tempo) and WS relay support.
 *
 * Exposes:
 *   - HTTP endpoints for direct access
 *   - WS relay at /api/ws/relay for WebSocket clients
 *   - /admin/health toggle to simulate unhealthy state (shield)
 *   - /admin/cb-fail to simulate settlement failure (circuitBreaker)
 *
 * Usage:
 *   npx tsx examples/plugins/server.ts
 *
 * Then:
 *   npx tsx examples/plugins/client-mpp-http.ts
 *   npx tsx examples/plugins/client-x402-http.ts
 *   npx tsx examples/plugins/client-mpp-ws.ts
 *   npx tsx examples/plugins/client-x402-ws.ts
 *   npx tsx examples/plugins/test.ts              # runs all plugin tests
 */
import "dotenv/config";
import http from "http";
import express from "express";
import Relai from "../../../../src/server";
import { freeTier, shield, circuitBreaker, refund } from "../../../../src/plugins";
import type { FreeTierPlugin } from "../../../../src/plugins";
import { Mppx, tempo } from "mppx/server";
import pkg from "ws";

const WebSocketServer = pkg.Server;

const PORT = parseInt(process.env.PORT || "4430", 10);
const MPP_SECRET_KEY = process.env.MPP_SECRET_KEY || "test-secret-key-for-mpp-demo-32ch";
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET!;
const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";

if (!RECIPIENT_WALLET) {
  console.error("RECIPIENT_WALLET required in .env");
  process.exit(1);
}

// ── State (toggleable via /admin endpoints) ─────────────────────────────────
let healthy = true;

// ── MPP Tempo ───────────────────────────────────────────────────────────────
const mppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [tempo.charge({ recipient: RECIPIENT_WALLET, currency: TEMPO_USDC, decimals: 6 })],
});

// ── Plugins ─────────────────────────────────────────────────────────────────
const freeTierPlugin = freeTier({ perBuyerLimit: 3, resetPeriod: "none" }) as FreeTierPlugin;
const shieldPlugin = shield({ healthCheck: () => healthy, cacheTtlMs: 0 });
const cbPlugin = circuitBreaker({ failureThreshold: 2, resetTimeMs: 2000 });
const refundPlugin = refund({ mode: "credit", refundOnSettlementFailure: true });

// ── Relai: x402 Base + MPP Tempo + all plugins ─────────────────────────────
const relai = new Relai({
  network: "base",
  mpp: mppx,
  plugins: [freeTierPlugin, shieldPlugin, cbPlugin, refundPlugin],
});

const protect = relai.protect({
  payTo: RECIPIENT_WALLET,
  price: 0.001,
  description: "Plugin demo endpoint",
});

function handleData(_req: any, res: any) {
  res.json({
    data: "premium content",
    free: _req.x402Free || false,
    paidVia: _req.x402Transaction ? "x402" : _req.x402Payer === "mpp" ? "mpp" : "free",
    paidBy: _req.x402Payer || null,
    refundCredit: _req.pluginMeta?.refundCredit || false,
  });
}

// ── Express ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", healthy }));
app.get("/api/data", protect, handleData);
app.post("/api/data", protect, handleData);

// Admin endpoints for controlling test state
app.post("/admin/health/:state", (req, res) => {
  healthy = req.params.state === "true";
  res.json({ healthy });
});

app.post("/admin/cb-fail", async (_req, res) => {
  const ctx = { network: "base" as const, price: 0.001, path: "/api/data", method: "GET" };
  const fakeReq = { headers: {}, path: "/api/data", method: "GET", ip: "127.0.0.1" };
  await cbPlugin.afterSettled!(fakeReq, { success: false, error: "simulated" } as any, ctx);
  res.json({ ok: true, message: "failure recorded" });
});

app.post("/admin/cb-success", async (_req, res) => {
  const ctx = { network: "base" as const, price: 0.001, path: "/api/data", method: "GET" };
  const fakeReq = { headers: {}, path: "/api/data", method: "GET", ip: "127.0.0.1" };
  await cbPlugin.afterSettled!(fakeReq, { success: true, transaction: "tx", payer: "0x1" } as any, ctx);
  res.json({ ok: true, message: "success recorded" });
});

app.post("/admin/refund-credit", async (req, res) => {
  const buyerIp = "::ffff:127.0.0.1";
  const ctx = { network: "base" as const, price: 0.001, path: "/api/data", method: "GET" };
  await refundPlugin.afterSettled!(
    { headers: {}, path: "/api/data", method: "GET", ip: buyerIp, socket: { remoteAddress: buyerIp } },
    { success: false, payer: "0xBuyer", transaction: "tx-failed" } as any,
    ctx,
  );
  res.json({ ok: true, message: "refund credit added" });
});

app.get("/admin/free-tier", (_req, res) => {
  res.json(freeTierPlugin.getUsageData());
});

// Relay routes
const relayRouter = express.Router({ mergeParams: true });
relayRouter.get("/health", (_req, res) => res.json({ status: "ok", healthy }));
relayRouter.get("/api/data", protect, handleData);
relayRouter.post("/api/data", protect, handleData);
app.use("/relay/:apiId", relayRouter);

// ── HTTP + WS server ────────────────────────────────────────────────────────
const server = http.createServer(app);

const wss = new WebSocketServer({ server, path: "/api/ws/relay" });
wss.on("connection", (ws: InstanceType<typeof pkg>) => {
  ws.on("message", async (raw: any) => {
    let envelope: any;
    try { envelope = JSON.parse(raw.toString()); } catch { return; }

    const { id, params } = envelope;
    const path = params?.path || "/";
    const method = params?.requestMethod || "GET";
    const headers: Record<string, string> = { ...(params?.requestHeaders || {}) };

    if (envelope.payment) {
      headers["X-PAYMENT"] = Buffer.from(JSON.stringify(envelope.payment)).toString("base64");
    }

    try {
      const fetchHeaders: Record<string, string> = { ...headers, host: `127.0.0.1:${PORT}` };
      if (!fetchHeaders["content-type"] && !fetchHeaders["Content-Type"]) {
        fetchHeaders["Content-Type"] = "application/json";
      }
      const response = await fetch(`http://127.0.0.1:${PORT}${path}`, { method, headers: fetchHeaders });

      if (response.status === 402) {
        const wwwAuth = response.headers.get("www-authenticate");
        let body: any = null;
        try { body = await response.json(); } catch {}
        const wsError: any = { code: 402, message: "Payment required" };
        if (body?.accepts || body?.x402Version) wsError.paymentRequired = body;
        if (wwwAuth && /^Payment\s+/i.test(wwwAuth.trim())) wsError.mppChallenge = wwwAuth;
        ws.send(JSON.stringify({ id, error: wsError }));
        return;
      }

      // Forward non-402 responses (200, 503, etc.)
      let body: any = null;
      try { body = await response.json(); } catch {}
      const pr = response.headers.get("payment-response");
      ws.send(JSON.stringify({
        id,
        result: body,
        ...(pr ? { paymentResponse: JSON.parse(Buffer.from(pr, "base64").toString()) } : {}),
        metadata: {
          status: response.status,
          // Forward plugin headers so WS clients can see them
          headers: {
            "x-free-calls-remaining": response.headers.get("x-free-calls-remaining"),
            "x-free-tier-mode": response.headers.get("x-free-tier-mode"),
            "x-shield-status": response.headers.get("x-shield-status"),
            "x-circuit-state": response.headers.get("x-circuit-state"),
            "x-refund-credit": response.headers.get("x-refund-credit"),
          },
        },
      }));
    } catch (err: any) {
      ws.send(JSON.stringify({ id, error: { code: 502, message: err.message } }));
    }
  });
});

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║  Plugin Demo Server (HTTP + WS)                          ║
║  http://localhost:${PORT}  ws://localhost:${PORT}/api/ws/relay  ║
║                                                          ║
║  Plugins: freeTier(3) + shield + circuitBreaker + refund ║
║  Payment: x402 Base + MPP Tempo ($0.001)                 ║
║                                                          ║
║  GET /api/data         — protected endpoint              ║
║  POST /admin/health/:s — toggle shield (true/false)      ║
║  POST /admin/cb-fail   — simulate CB failure             ║
║  POST /admin/cb-success— simulate CB success             ║
║  POST /admin/refund-credit — add refund credit           ║
╚══════════════════════════════════════════════════════════╝
`);
});

// Export for test script
export { server, PORT, freeTierPlugin, cbPlugin, refundPlugin, healthy };
