/**
 * Dual-channel client — pays via MPP (Tempo).
 *
 * Hits the dual-channel server. The server returns 402 with both x402 and MPP
 * challenges. This client has an MPP handler → it picks up the WWW-Authenticate
 * challenge and pays via Tempo, ignoring x402.
 *
 * Usage:
 *   npx tsx examples/dualchannel/client-mpp.ts [server-url]
 *
 * Start server first: npx tsx examples/dualchannel/server.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.argv[2] || "http://localhost:4420";
const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("TEMPO_PRIVATE_KEY or EVM_PRIVATE_KEY required in .env");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Server:  ${SERVER_URL}`);
console.log(`Payment: MPP Tempo\n`);

// ── MPP Tempo client ────────────────────────────────────────────────────────
const mppx = Mppx.create({
  methods: [tempo.charge({ account })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    console.log(`  [MPP] Challenge: ${challenge.method}/${challenge.intent}`);
    console.log(`  [MPP] Signing on Tempo...`);
    const cred = await createCredential();
    console.log(`  [MPP] Done.`);
    return cred;
  },
});

// ── x402 client with MPP + EVM fallback ─────────────────────────────────────
const evmKey = process.env.EVM_PRIVATE_KEY;
const evmAccount = evmKey ? privateKeyToAccount(evmKey as `0x${string}`) : null;

const client = createX402Client({
  ...(evmAccount ? {
    wallets: { evm: { address: evmAccount.address, signTypedData: (d: any) => evmAccount.signTypedData(d) } },
  } : {}),
  mpp: mppx,
  verbose: true,
});

// ── Test ─────────────────────────────────────────────────────────────────────
console.log("═══ GET /api/data — paying via MPP Tempo ═══");
try {
  const res = await client.fetch(`${SERVER_URL}/api/data`);
  console.log(`\nStatus: ${res.status}`);
  const body = await res.json();
  console.log(`Body:`, body);
  const via = (body as any).paidVia;
  console.log(res.status === 200 ? `\n✅ SUCCESS — paid via ${via}${via === "x402" ? " (Tempo insufficient → x402 fallback)" : ""}` : "\n❌ UNEXPECTED");
} catch (err: any) {
  console.error(`\n❌ Error: ${err.message}`);
}
