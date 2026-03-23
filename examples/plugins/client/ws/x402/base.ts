/**
 * Plugin demo — x402 Base client over WebSocket relay.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/plugins/client-x402-ws.ts [relay-url]
 */
import "dotenv/config";
import { createX402Client } from "../../../../../src/client";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

const RELAY_URL = process.argv[2] || "http://localhost:4430/relay/test/api/data";
const KEY = process.env.EVM_PRIVATE_KEY;
if (!KEY) { console.error("EVM_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(KEY as `0x${string}`);
const client = createX402Client({
  wallets: { evm: { address: account.address, signTypedData: (d) => account.signTypedData(d as any) } },
  relayWs: { enabled: true, webSocketFactory: (url) => new WebSocket(url) as any, fallbackToHttp: false },
  verbose: true,
});

console.log(`x402 WS → ${RELAY_URL}`);
const res = await client.fetch(RELAY_URL);
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
