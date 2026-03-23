/**
 * Plugin demo — x402 Base client over HTTP.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/plugins/client-x402-http.ts [server-url]
 */
import "dotenv/config";
import { createX402Client } from "../../../../../src/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] || "http://localhost:4430";
const KEY = process.env.EVM_PRIVATE_KEY;
if (!KEY) { console.error("EVM_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(KEY as `0x${string}`);
const client = createX402Client({
  wallets: { evm: { address: account.address, signTypedData: (d) => account.signTypedData(d as any) } },
  verbose: true,
});

console.log(`x402 HTTP → ${BASE}/api/data`);
const res = await client.fetch(`${BASE}/api/data`);
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
