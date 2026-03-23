/**
 * Dual-channel client — pays via x402 (Base EVM).
 *
 * Hits the dual-channel server. The server returns 402 with both x402 and MPP
 * challenges. This client has NO MPP handler → it ignores the WWW-Authenticate
 * and pays via x402 on Base (EIP-3009 transferWithAuthorization).
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/dualchannel/client-x402.ts [server-url]
 *
 * Start server first: npx tsx examples/dualchannel/server.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.argv[2] || "http://localhost:4420";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("EVM_PRIVATE_KEY required in .env");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Server:  ${SERVER_URL}`);
console.log(`Payment: x402 on Base\n`);

// ── x402 client — EVM wallet only, NO MPP ───────────────────────────────────
const client = createX402Client({
  wallets: {
    evm: {
      address: account.address,
      signTypedData: (data) => account.signTypedData(data as any),
    },
  },
  verbose: true,
});

// ── Test ─────────────────────────────────────────────────────────────────────
console.log("═══ GET /api/data — paying via x402 Base ═══");
try {
  const res = await client.fetch(`${SERVER_URL}/api/data`);
  console.log(`\nStatus: ${res.status}`);
  const body = await res.json();
  console.log(`Body:`, body);
  console.log(res.status === 200 && (body as any).paidVia === "x402" ? "\n✅ SUCCESS — paid via x402" : "\n❌ UNEXPECTED");
} catch (err: any) {
  console.error(`\n❌ Error: ${err.message}`);
}
