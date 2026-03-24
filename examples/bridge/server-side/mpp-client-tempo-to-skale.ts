/**
 * SERVER-SIDE BRIDGE — MPP client using bridge/charge (Tempo → SKALE)
 *
 * The server exposes bridge/charge alongside evm/charge. This client
 * registers a bridgeCharge handler that picks bridge/charge because
 * it can't pay directly on SKALE.
 *
 * Flow:
 *   1. Server sends two challenges: evm/charge (SKALE) + bridge/charge
 *   2. Client can't match evm/charge (no SKALE wallet)
 *   3. Client picks bridge/charge, pays on Tempo, bridge settles on SKALE
 *   4. Server verifies the target tx on SKALE via bridge/charge verify()
 *
 * Start the server first:
 *   npx tsx examples/bridge/server-side/server-skale.ts
 *
 * Then run this client:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/server-side/client-tempo-to-skale.ts
 */
import "dotenv/config";
import { Mppx } from "mppx/client";
import { bridgeCharge } from "../../../src/mpp/bridge-client";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.argv[2] || "http://localhost:4413";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/server-side/client-tempo-to-skale.ts");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Source:  Tempo (pays via bridge/charge)`);
console.log(`Target:  SKALE server (${SERVER_URL})\n`);

const mppx = Mppx.create({
  methods: [
    bridgeCharge({
      evmAccount: account,
      rpcUrls: { "eip155:4217": "https://rpc.tempo.xyz" },
    }),
  ],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    const req = challenge.request as any;
    console.log(`  [MPP] Challenge: ${challenge.method}/${challenge.intent}`);
    if (challenge.method === "bridge") {
      console.log(`    Source chains: ${req?.methodDetails?.supportedSourceChains?.join(", ")}`);
    }
    console.log(`    Executing...`);
    const cred = await createCredential();
    console.log(`    Done.`);
    return cred;
  },
});

const mppFetch = mppx.fetch.bind(mppx);

console.log("=== Test 1: Health check ===");
try {
  const res = await fetch(`${SERVER_URL}/health`);
  console.log(`Status: ${res.status}`, await res.json());
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n=== Test 2: Paid endpoint (Tempo -> SKALE via bridge/charge) ===");
try {
  const res = await mppFetch(`${SERVER_URL}/api/data`);
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "\nSUCCESS" : `\nFAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}
