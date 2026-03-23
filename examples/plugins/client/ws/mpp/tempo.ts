/**
 * Plugin demo — MPP Tempo client over WebSocket relay.
 *
 * Usage:
 *   npx tsx examples/plugins/client-mpp-ws.ts [relay-url]
 */
import "dotenv/config";
import { createX402Client } from "../../../../../src/client";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

const RELAY_URL = process.argv[2] || "http://localhost:4430/relay/test/api/data";
const KEY = process.env.TEMPO_PRIVATE_KEY || process.env.EVM_PRIVATE_KEY;
if (!KEY) { console.error("TEMPO_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(KEY as `0x${string}`);
const mppx = Mppx.create({ methods: [tempo.charge({ account })], polyfill: false });
const client = createX402Client({
  mpp: mppx,
  relayWs: { enabled: true, webSocketFactory: (url) => new WebSocket(url) as any, fallbackToHttp: true },
  verbose: true,
});

console.log(`MPP WS → ${RELAY_URL}`);
const res = await client.fetch(RELAY_URL);
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
