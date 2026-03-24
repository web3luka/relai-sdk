/**
 * TESTNET E2E — MPP bridge: SKALE Base Sepolia → Solana Devnet
 *
 * Chains:
 *   Source: SKALE Base Sepolia (eip155:324705682) — USDC 0x2e08028E...
 *   Target: Solana Devnet — USDC 4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU
 *
 * This is a SUPPORTED testnet bridge direction in 402-everywhere.
 * Uses server-side bridge/charge since target is Solana (not EVM).
 *
 * Expected: will fail with insufficient funds if no USDC on SKALE Base Sepolia.
 *
 * Prerequisites:
 *   - sFUEL on SKALE Sepolia: https://www.sfuelstation.com/
 *   - USDC on SKALE Sepolia: deploy or bridge test tokens
 *
 * Start server: npx tsx examples/bridge/testnet/server-solana-devnet.ts
 * Run client:   EVM_PRIVATE_KEY=0x... npx tsx examples/bridge/testnet/mpp-skale-sepolia-to-solana-devnet.ts
 */
import "dotenv/config";
import { Mppx } from "mppx/client";
import { bridgeCharge } from "../../../src/mpp/bridge-client";
import { privateKeyToAccount } from "viem/accounts";

const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY;
if (!PRIVATE_KEY) { console.error("EVM_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);
const SERVER_URL = process.argv[2] || "http://localhost:4422";

console.log(`Account:  ${account.address}`);
console.log(`Source:   SKALE Base Sepolia (eip155:324705682)`);
console.log(`Target:   Solana Devnet`);
console.log(`Server:   ${SERVER_URL}\n`);

const mppx = Mppx.create({
  methods: [
    bridgeCharge({
      evmAccount: account,
      preferredSourceChainId: 324705682,
      rpcUrls: {
        "eip155:324705682": "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha",
      },
    }),
  ],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    const req = challenge.request as any;
    console.log(`  [MPP] ${challenge.method}/${challenge.intent}`);
    console.log(`    Source chains: ${req?.methodDetails?.supportedSourceChains?.join(", ")}`);
    const cred = await createCredential();
    console.log(`    Done.`);
    return cred;
  },
});

console.log("=== SKALE Base Sepolia -> Solana Devnet (testnet) ===");
try {
  const res = await mppx.fetch(`${SERVER_URL}/api/data`);
  console.log(`Status: ${res.status}`);
  console.log(`Body:`, await res.json());
  console.log(res.status === 200 ? "\nSUCCESS" : `\nFAILED (${res.status})`);
} catch (err: any) {
  console.error(`Error: ${err.message}`);
}
