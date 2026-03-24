/**
 * TESTNET E2E — MPP bridge: Tempo Moderato → SKALE Base Sepolia
 *
 * Chains:
 *   Source: Tempo Moderato (eip155:42431) — pathUSD 0x20c000...
 *   Target: SKALE Base Sepolia (eip155:324705682) — USDC 0x2e08028E...
 *
 * Uses server-side bridge/charge (server provides static testnet bridge config).
 * No auto-discovery from production API — fully testnet-safe.
 *
 * Expected: will fail with "unsupported_source_chain" until the bridge API
 * adds Tempo Moderato testnet support. The source payment and settle call
 * are correctly targeting testnet chains.
 *
 * Prerequisites:
 *   - pathUSD on Tempo Moderato: cast rpc tempo_fundAddress <ADDR> --rpc-url https://rpc.moderato.tempo.xyz
 *
 * Start server: npx tsx examples/bridge/testnet/server-skale-sepolia.ts
 * Run client:   EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/testnet/mpp-tempo-moderato-to-skale-sepolia.ts
 */
import "dotenv/config";
import { Mppx } from "mppx/client";
import { bridgeCharge } from "../../../src/mpp/bridge-client";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("EVM_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const SERVER_URL = process.argv[2] || "http://localhost:4420";

console.log(`Account:  ${account.address}`);
console.log(`Source:   Tempo Moderato (eip155:42431)`);
console.log(`Target:   SKALE Base Sepolia (eip155:324705682)`);
console.log(`Server:   ${SERVER_URL}\n`);

const mppx = Mppx.create({
  methods: [
    bridgeCharge({
      evmAccount: account,
      preferredSourceChainId: 42431,
      rpcUrls: { "eip155:42431": "https://rpc.moderato.tempo.xyz" },
    }),
  ],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    const req = challenge.request as any;
    console.log(`  [MPP] ${challenge.method}/${challenge.intent}`);
    console.log(`    Source chains: ${req?.methodDetails?.supportedSourceChains?.join(", ")}`);
    console.log(`    Settle: ${req?.methodDetails?.settleEndpoint}`);
    const cred = await createCredential();
    console.log(`    Done.`);
    return cred;
  },
});

console.log("=== Tempo Moderato -> SKALE Base Sepolia (testnet) ===");
try {
  const res = await mppx.fetch(`${SERVER_URL}/api/data`);
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "\nSUCCESS" : `\nFAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}
