/**
 * WS relay client — MPP Solana payment via WebSocket.
 *
 * Usage:
 *   SOLANA_PRIVATE_KEY=base58... npx tsx examples/client/ws/solana/mpp.ts [relay-url]
 *
 * Start relay first: npx tsx examples/server/ws/relay.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { Mppx, solana } from "@solana/mpp/client";
import { createKeyPairSignerFromBytes } from "@solana/kit";
// @ts-ignore
import bs58 from "bs58";
import WebSocket from "ws";

const RELAY_URL = process.argv[2] || "http://localhost:4414/relay/test-api/api/data";
const PRIVATE_KEY = process.env.SOLANA_PRIVATE_KEY!;
if (!PRIVATE_KEY) { console.error("SOLANA_PRIVATE_KEY required"); process.exit(1); }

const signer = await createKeyPairSignerFromBytes(new Uint8Array(bs58.decode(PRIVATE_KEY)));

const mppx = Mppx.create({
  methods: [solana.charge({ signer })],
  polyfill: false,
});

const client = createX402Client({
  mpp: mppx,
  relayWs: { enabled: true, webSocketFactory: (url) => new WebSocket(url) as any, fallbackToHttp: true },
  verbose: true,
});

const res = await client.fetch(RELAY_URL, { method: "GET" });
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
