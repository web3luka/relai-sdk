/**
 * CLIENT-SIDE BRIDGE — MPP client on Tempo paying a Base server
 *
 * The server only exposes evm/charge on Base — it has NO bridge config.
 * The client uses evmChargeWithBridge() to bridge transparently.
 *
 * Start the server first:
 *   npx tsx examples/bridge/client-side/server-base.ts
 *
 * Then run this client:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/client-side/client-tempo-to-base.ts
 */
import "dotenv/config";
import { createX402Client } from "../../../src/client";
import { Mppx } from "mppx/client";
import { evmChargeWithBridge } from "../../../src/mpp/with-bridge";
import { privateKeyToAccount } from "viem/accounts";

const SERVER_URL = process.argv[2] || "http://localhost:4412";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/client-side/client-tempo-to-base.ts");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
console.log(`Account: ${account.address}`);
console.log(`Source:  Tempo (eip155:4217)`);
console.log(`Target:  Base server (${SERVER_URL})\n`);

const mppx = Mppx.create({
  methods: [
    evmChargeWithBridge({
      evmAccount: account,
      sourceChainId: 4217,
      sourceRpcUrl: "https://rpc.tempo.xyz",
    }),
  ],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    const req = challenge.request as any;
    console.log(`  [MPP] Challenge: ${challenge.method}/${challenge.intent}`);
    console.log(`  [MPP] Amount: ${req?.amount}, Recipient: ${req?.recipient?.slice(0, 10)}...`);
    console.log(`  [MPP] Bridging from Tempo...`);
    const cred = await createCredential();
    console.log(`  [MPP] Done.`);
    return cred;
  },
});

const client = createX402Client({ mpp: mppx, verbose: true });

console.log("=== Test 1: Health check ===");
try {
  const res = await client.fetch(`${SERVER_URL}/health`);
  console.log(`Status: ${res.status}`, await res.json());
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}

console.log("\n=== Test 2: Paid endpoint (Tempo -> Base) ===");
try {
  const res = await client.fetch(`${SERVER_URL}/api/data`);
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "\nSUCCESS" : `\nFAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}
