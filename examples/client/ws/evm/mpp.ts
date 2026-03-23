/**
 * WS relay client — MPP EVM payment via WebSocket.
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/client/ws/evm/mpp.ts [relay-url]
 *
 * Start relay first: npx tsx examples/server/ws/relay.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { Mppx } from "mppx/client";
import { evmCharge } from "../../../../src/mpp/evm-client";
import { privateKeyToAccount } from "viem/accounts";
import WebSocket from "ws";

const RELAY_URL = process.argv[2] || "http://localhost:4405/relay/test-api/api/data";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY!;
if (!PRIVATE_KEY) { console.error("EVM_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const mppx = Mppx.create({
  methods: [evmCharge({ account })],
  polyfill: false,
});

const client = createX402Client({
  wallets: { evm: { address: account.address, signTypedData: (d) => account.signTypedData(d as any) } },
  mpp: mppx,
  relayWs: { enabled: true, webSocketFactory: (url) => new WebSocket(url) as any, fallbackToHttp: true },
  verbose: true,
});

const res = await client.fetch(RELAY_URL, { method: "GET" });
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
