/**
 * End-to-end test: all plugins + MPP Tempo
 *
 * Tests:
 *  1. freeTier — first 3 requests are free, then requires MPP payment
 *  2. MPP Tempo — paid request after free tier exhausted
 *  3. shield — when unhealthy, returns 503 (no payment asked)
 *  4. circuitBreaker — after failures, circuit opens → 503, then resets
 *  5. refund — settlement failure via MPP grants credit, next call is free
 *
 * Usage:
 *   TEMPO_PRIVATE_KEY=0x... npx tsx examples/mpp-plugins-test.ts
 */
import "dotenv/config";
import express from "express";
import Relai from "../../../src/server";
import type { MppServerHandler, MppChargeResult } from "../../../src/server";
import { freeTier, shield, circuitBreaker, refund } from "../../../src/plugins";
import type { FreeTierPlugin } from "../../../src/plugins";
import { Mppx, tempo } from "mppx/server";
import { createX402Client } from "../../../src/client";
import { Mppx as MppxClient, tempo as tempoClient } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const PORT = 4403;
const MPP_SECRET_KEY = "test-secret-key-for-mpp-demo-32ch";
const RECIPIENT_WALLET = process.env.RECIPIENT_WALLET || "0xF6abF8FBDc740786658275Acf7Dc333cFcae5F9b";
const TEMPO_USDC = "0x20C000000000000000000000b9537d11c60E8b50";

const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY;
if (!PRIVATE_KEY) {
  console.error("Usage: TEMPO_PRIVATE_KEY=0x... npx tsx examples/mpp-plugins-test.ts");
  process.exit(1);
}

// ── Test state ────────────────────────────────────────────────────────────────
let healthy = true;
let mppShouldFail = false; // toggle to make MPP charge fail (simulates settlement failure)
let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail?: string) {
  if (condition) {
    console.log(`  ✓ ${name}`);
    passed++;
  } else {
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
    failed++;
  }
}

// ── Server setup ──────────────────────────────────────────────────────────────

// Real mppx handler
const realMppx = Mppx.create({
  secretKey: MPP_SECRET_KEY,
  methods: [
    tempo.charge({ recipient: RECIPIENT_WALLET, currency: TEMPO_USDC, decimals: 6 }),
  ],
});

// Wrappable mppx that can simulate failures
// When mppShouldFail=true, charge() returns success=false (like a real settlement failure)
const mppxWrapper: MppServerHandler = {
  charge(params: Record<string, unknown>) {
    const realHandler = realMppx.charge(params);
    return async (request: Request): Promise<MppChargeResult> => {
      const result = await realHandler(request);
      if (mppShouldFail && result.status === 200) {
        // Simulate: the charge was accepted but we return a failure
        // This is what happens when a settlement fails server-side
        console.log("    [mppx-wrapper] Simulating settlement failure after charge");
        return { status: 200, withReceipt: result.withReceipt, receipt: { ...result.receipt, status: "failed" } };
      }
      return result;
    };
  },
};

const freeTierPlugin = freeTier({
  perBuyerLimit: 3,
  resetPeriod: "none",
}) as FreeTierPlugin;

const shieldPlugin = shield({
  healthCheck: () => healthy,
  cacheTtlMs: 0,
});

const cbPlugin = circuitBreaker({
  failureThreshold: 2,
  resetTimeMs: 500,
});

const refundEvents: any[] = [];
const refundPlugin = refund({
  mode: "credit",
  refundOnSettlementFailure: true,
  onRefund: (event) => {
    refundEvents.push(event);
    console.log(`    [refund] credit for IP=${event.payer}, reason=${event.reason}, path=${event.path}`);
  },
});

const relai = new Relai({
  network: "base",
  mpp: mppxWrapper,
  plugins: [freeTierPlugin, shieldPlugin, cbPlugin, refundPlugin],
});

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok" }));

app.get(
  "/api/data",
  relai.protect({
    payTo: RECIPIENT_WALLET,
    price: 0.01,
    description: "Plugin test endpoint",
    onPaymentSettled: (_req, result) => {
      console.log(`    [settle] success=${result.success}, payer=${result.payer}`);
    },
  }),
  (_req, res) => {
    res.json({
      data: "premium content",
      free: (_req as any).x402Free || false,
      plugin: (_req as any).x402Plugin || null,
      paidBy: (_req as any).x402Payer || null,
      refundCredit: (_req as any).pluginMeta?.refundCredit || false,
    });
  },
);

// ── Client setup ──────────────────────────────────────────────────────────────
const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const mppClient = MppxClient.create({
  methods: [tempoClient.charge({ account })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    console.log(`    [mpp-client] Challenge: method=${challenge.method}, amount=${challenge.request?.amount}`);
    const cred = await createCredential();
    console.log(`    [mpp-client] Credential signed`);
    return cred;
  },
});

const client = createX402Client({ mpp: mppClient, verbose: false });

const BASE = `http://localhost:${PORT}`;

// ── Tests ─────────────────────────────────────────────────────────────────────
async function runTests() {

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 1: Free Tier (3 free calls, no payment) ═══");
  console.log("  → freeTier plugin intercepts before 402, serves for free");
  // ═══════════════════════════════════════════════════════════════════════
  for (let i = 1; i <= 3; i++) {
    const res = await fetch(`${BASE}/api/data`);
    const body = await res.json() as any;
    assert(
      `Free call ${i}/3 → status=${res.status}, free=${body.free}`,
      res.status === 200 && body.free === true,
      `status=${res.status}, free=${body.free}`,
    );
    const remaining = res.headers.get("x-free-calls-remaining");
    const mode = res.headers.get("x-free-tier-mode");
    assert(
      `  X-Free-Calls-Remaining: ${remaining}, mode: ${mode}`,
      remaining === String(3 - i) && mode === "local",
      `remaining=${remaining}, mode=${mode}`,
    );
  }

  // 4th call — free tier exhausted, no wallet → 402
  console.log("  → 4th call: free tier exhausted, no payment header");
  const res4 = await fetch(`${BASE}/api/data`);
  assert(
    `4th call → 402 (free tier exhausted)`,
    res4.status === 402,
    `status=${res4.status}`,
  );
  // Check WWW-Authenticate MPP challenge is in the 402
  const wwwAuth = res4.headers.get("www-authenticate");
  assert(
    `  402 includes WWW-Authenticate MPP challenge`,
    !!wwwAuth && wwwAuth.startsWith("Payment "),
    `www-authenticate=${wwwAuth?.slice(0, 50)}`,
  );

  const usage = freeTierPlugin.getUsageData();
  assert(
    `  freeTier local usage: globalCount=${usage?.globalCount}`,
    usage !== null && usage.globalCount === 3,
    `globalCount=${usage?.globalCount}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 2: MPP Tempo payment (free tier exhausted → client auto-pays) ═══");
  console.log("  → client detects 402 + WWW-Authenticate, signs Tempo tx, retries");
  // ═══════════════════════════════════════════════════════════════════════
  const resMpp = await client.fetch(`${BASE}/api/data`);
  const bodyMpp = await resMpp.json() as any;
  assert(
    `MPP Tempo → status=${resMpp.status}`,
    resMpp.status === 200,
    `status=${resMpp.status}`,
  );
  assert(
    `  paidBy=${bodyMpp.paidBy}`,
    bodyMpp.paidBy === "mpp",
    `paidBy=${bodyMpp.paidBy}`,
  );
  const receipt = resMpp.headers.get("payment-receipt");
  assert(
    `  Payment-Receipt header: ${receipt ? receipt.slice(0, 30) + "..." : "MISSING"}`,
    !!receipt,
  );

  // Do a second MPP payment to confirm it's repeatable
  console.log("  → 2nd MPP payment (confirming repeatability)");
  const resMpp2 = await client.fetch(`${BASE}/api/data`);
  assert(
    `2nd MPP → status=${resMpp2.status}`,
    resMpp2.status === 200,
    `status=${resMpp2.status}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 3: Shield (service unhealthy → 503 before payment) ═══");
  console.log("  → shield rejects request with 503, buyer never asked to pay");
  // ═══════════════════════════════════════════════════════════════════════
  healthy = false;

  const resUnhealthy = await fetch(`${BASE}/api/data`);
  const bodyUnhealthy = await resUnhealthy.json() as any;
  assert(
    `Unhealthy → status=${resUnhealthy.status}`,
    resUnhealthy.status === 503,
    `status=${resUnhealthy.status}`,
  );
  assert(
    `  plugin=${bodyUnhealthy.plugin}`,
    bodyUnhealthy.plugin === "shield",
    `plugin=${bodyUnhealthy.plugin}`,
  );
  const shieldHeader = resUnhealthy.headers.get("x-shield-status");
  const retryAfter = resUnhealthy.headers.get("retry-after");
  assert(
    `  X-Shield-Status=${shieldHeader}, Retry-After=${retryAfter}`,
    shieldHeader === "unhealthy" && !!retryAfter,
  );

  // Even with MPP client, shield blocks before MPP challenge
  console.log("  → MPP client also gets 503 (shield blocks before challenge)");
  const resUnhealthyMpp = await client.fetch(`${BASE}/api/data`);
  assert(
    `MPP client + unhealthy → status=${resUnhealthyMpp.status}`,
    resUnhealthyMpp.status === 503,
    `status=${resUnhealthyMpp.status}`,
  );

  // Restore health
  healthy = true;
  console.log("  → health restored");
  const resHealthy = await fetch(`${BASE}/api/data`);
  assert(
    `Healthy again → status=${resHealthy.status} (402, not 503)`,
    resHealthy.status === 402,
    `status=${resHealthy.status}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 4: Circuit Breaker (failures → open → half-open → closed) ═══");
  console.log("  → simulating 2 settlement failures to trip the circuit");
  // ═══════════════════════════════════════════════════════════════════════
  // In x402 standard, afterSettled is called by the middleware after facilitator /settle.
  // The circuit breaker tracks these outcomes. We simulate failures as the middleware would.
  const cbCtx = { network: "base" as const, price: 0.01, path: "/api/data", method: "GET" };
  const fakeReq = { headers: {}, path: "/api/data", method: "GET", ip: "127.0.0.1" };
  await cbPlugin.afterSettled!(fakeReq, { success: false, error: "facilitator timeout" } as any, cbCtx);
  console.log("    [cb] failure 1 recorded");
  await cbPlugin.afterSettled!(fakeReq, { success: false, error: "facilitator timeout" } as any, cbCtx);
  console.log("    [cb] failure 2 recorded → circuit should be open");

  const resCbOpen = await fetch(`${BASE}/api/data`);
  const bodyCbOpen = await resCbOpen.json() as any;
  const cbState = resCbOpen.headers.get("x-circuit-state");
  const cbFailures = resCbOpen.headers.get("x-circuit-failures");
  assert(
    `Circuit open → status=${resCbOpen.status}, X-Circuit-State=${cbState}, failures=${cbFailures}`,
    resCbOpen.status === 503 && cbState === "open",
    `status=${resCbOpen.status}, state=${cbState}`,
  );
  assert(
    `  plugin=${bodyCbOpen.plugin}`,
    bodyCbOpen.plugin === "circuit-breaker",
  );

  // Wait for resetTimeMs (500ms) → half-open
  console.log("  → waiting 600ms for circuit reset...");
  await new Promise((r) => setTimeout(r, 600));

  const resHalfOpen = await fetch(`${BASE}/api/data`);
  // In half-open, circuit allows request through (no reject) → falls through to 402.
  // Note: X-Circuit-State header is only set on the response when the plugin rejects (open state).
  // When it allows through (half-open/closed), the header is set on the PluginResult but
  // server.ts only applies headers on skip/reject, not on passthrough. This is by design.
  assert(
    `After reset → status=${resHalfOpen.status} (402 = circuit let it through)`,
    resHalfOpen.status === 402,
    `status=${resHalfOpen.status}`,
  );

  // Successes in half-open → closed
  console.log("  → recording 2 successes to close circuit");
  await cbPlugin.afterSettled!(fakeReq, { success: true, transaction: "tx1", payer: "0x1" } as any, cbCtx);
  await cbPlugin.afterSettled!(fakeReq, { success: true, transaction: "tx2", payer: "0x1" } as any, cbCtx);

  // Verify circuit is closed by checking it doesn't reject
  const resClosed = await fetch(`${BASE}/api/data`);
  assert(
    `Circuit closed → status=${resClosed.status} (402, not 503)`,
    resClosed.status === 402,
    `status=${resClosed.status}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══ TEST 5: Refund (settlement failure → credit on next call) ═══");
  console.log("  → In x402/MPP, refund plugin tracks settlement failures by buyer IP.");
  console.log("  → If settlement fails, buyer gets a free credit on next request.");
  console.log("  → This is a credit system, NOT an on-chain refund.");
  // ═══════════════════════════════════════════════════════════════════════

  // The refund plugin keys credits by IP (in a real flow, req.ip from same client).
  // We simulate what the Relai middleware does internally: call afterSettled with success:false.
  // This happens when the facilitator /settle fails or when MPP charge fails server-side.
  //
  // Express sees localhost connections as ::ffff:127.0.0.1 (IPv4-mapped IPv6).
  // The refund plugin resolves buyer ID from: x-buyer-id header > authorization > req.ip > socket.remoteAddress.
  // We must use the same IP that Express will see on the next HTTP request.
  const buyerIp = "::ffff:127.0.0.1";
  const refundReq = {
    headers: {},
    path: "/api/data",
    method: "GET",
    ip: buyerIp,
    socket: { remoteAddress: buyerIp },
  };

  console.log(`  → Simulating settlement failure for buyer IP=${buyerIp}`);
  refundEvents.length = 0;
  await refundPlugin.afterSettled!(
    refundReq,
    { success: false, payer: "0xBuyerWallet", transaction: "tx-failed-settle" } as any,
    cbCtx,
  );

  assert(
    `onRefund callback fired`,
    refundEvents.length === 1 && refundEvents[0].reason === "settlement_failure",
    `events=${refundEvents.length}, reason=${refundEvents[0]?.reason}`,
  );
  assert(
    `  payer=${refundEvents[0]?.payer}, tx=${refundEvents[0]?.transactionId}`,
    refundEvents[0]?.payer === "0xBuyerWallet" && refundEvents[0]?.transactionId === "tx-failed-settle",
  );

  // Next request from same IP → refund credit applied (skip payment)
  console.log(`  → Next request from same IP — credit should be consumed`);
  const resRefund = await fetch(`${BASE}/api/data`);
  const bodyRefund = await resRefund.json() as any;
  const creditHeader = resRefund.headers.get("x-refund-credit");
  const creditsRemaining = resRefund.headers.get("x-refund-credits-remaining");
  assert(
    `Credit applied → status=${resRefund.status}, X-Refund-Credit=${creditHeader}`,
    resRefund.status === 200 && creditHeader === "applied",
    `status=${resRefund.status}, credit=${creditHeader}`,
  );
  assert(
    `  X-Refund-Credits-Remaining=${creditsRemaining}`,
    creditsRemaining === "0",
    `remaining=${creditsRemaining}`,
  );
  assert(
    `  body.refundCredit=${bodyRefund.refundCredit}`,
    bodyRefund.refundCredit === true,
  );

  // Next request — no more credits → 402
  console.log(`  → Next request — no more credits`);
  const resNoCredit = await fetch(`${BASE}/api/data`);
  assert(
    `No credits left → status=${resNoCredit.status} (402)`,
    resNoCredit.status === 402,
    `status=${resNoCredit.status}`,
  );

  // ═══════════════════════════════════════════════════════════════════════
  console.log("\n═══ RESULTS ═══");
  console.log(`  ${passed} passed, ${failed} failed, ${passed + failed} total`);
  console.log(failed === 0 ? "\n  ALL TESTS PASSED ✓\n" : "\n  SOME TESTS FAILED ✗\n");
}

// ── Run ───────────────────────────────────────────────────────────────────────
const server = app.listen(PORT, async () => {
  console.log(`Server on http://localhost:${PORT}`);
  console.log(`Account: ${account.address}`);
  console.log(`PayTo:   ${RECIPIENT_WALLET}`);
  try {
    await runTests();
  } catch (err) {
    console.error("Test error:", err);
    failed++;
  } finally {
    server.close();
    process.exit(failed > 0 ? 1 : 0);
  }
});
