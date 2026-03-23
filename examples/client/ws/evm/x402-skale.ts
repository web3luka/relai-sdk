/**
 * WS relay client — x402 EVM payment on SKALE via WebSocket.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/client/ws/evm/x402-skale.ts [relay-url]
 *
 * Start relay first: npx tsx examples/server/ws/relay.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

const RELAY_URL = process.argv[2] || "http://localhost:4405/relay/test-api/api/data";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY!;
if (!PRIVATE_KEY) { console.error("EVM_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const client = createX402Client({
  wallets: { evm: { address: account.address, signTypedData: (d) => account.signTypedData(d as any) } },
  relayWs: { enabled: true, webSocketFactory: (url) => new WebSocket(url) as any, fallbackToHttp: false },
  verbose: true,
});

const res = await client.fetch(RELAY_URL, { method: "GET" });
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
