#!/usr/bin/env node
/**
 * End-to-end test: @relai-fi/x402 SDK with MPP Tempo payment.
 *
 * Usage:
 *   TEMPO_PRIVATE_KEY=0x... node scripts/test-mpp-tempo.mjs [relay-url]
 */
import { createX402Client } from "../src/client.ts";
import { Mppx, tempo } from "mppx/client";
import { privateKeyToAccount } from "viem/accounts";

const RELAY_URL = process.argv[2] || "https://int-api.relai.fi/relay/1773907726146/a2a/discover";
const PRIVATE_KEY = process.env.TEMPO_PRIVATE_KEY;

if (!PRIVATE_KEY) {
  console.error("Usage: TEMPO_PRIVATE_KEY=0x... node scripts/test-mpp-tempo.mjs [relay-url]");
  process.exit(1);
}

const account = privateKeyToAccount(PRIVATE_KEY);
console.log(`Account:   ${account.address}`);
console.log(`Relay URL: ${RELAY_URL}\n`);

// Create mppx client for Tempo
const mppx = Mppx.create({
  methods: [tempo.charge({ account })],
  polyfill: false,
  onChallenge: async (challenge, { createCredential }) => {
    console.log(`  [MPP] Challenge: method=${challenge.method} amount=${challenge.request?.amount} recipient=${challenge.request?.recipient}`);
    console.log(`  [MPP] Signing tx...`);
    const cred = await createCredential();
    console.log(`  [MPP] Credential created.`);
    return cred;
  },
});

// Create x402 client with mpp handler
const client = createX402Client({
  mpp: mppx,
  verbose: true,
});

console.log("Making request via x402 client with MPP...\n");

try {
  const res = await client.fetch(RELAY_URL);
  console.log(`\nStatus: ${res.status}`);

  const receipt = res.headers.get("payment-receipt");
  if (receipt) console.log(`Payment-Receipt: ${receipt.slice(0, 80)}...`);

  const body = await res.text();
  console.log(`Body: ${body.slice(0, 200)}`);
  console.log(res.status === 200 ? "\nSUCCESS" : `\nStatus: ${res.status}`);
} catch (err) {
  console.error(`ERROR: ${err.message}`);
}
