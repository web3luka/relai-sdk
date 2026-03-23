/**
 * Plugin demo — MPP Tempo client over HTTP.
 *
 * Usage:
 *   npx tsx examples/plugins/client-mpp-http.ts [server-url]
 */
import "dotenv/config";
import { createX402Client } from "../../../../../src/client";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const BASE = process.argv[2] || "http://localhost:4430";
const KEY = process.env.TEMPO_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;
if (!KEY) { console.error("TEMPO_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(KEY as `0x${string}`);
const mppx = Mppx.create({ methods: [tempo.charge({ account })], polyfill: false });
const client = createX402Client({ mpp: mppx, verbose: true });

console.log(`MPP HTTP → ${BASE}/api/data`);
const res = await client.fetch(`${BASE}/api/data`);
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
