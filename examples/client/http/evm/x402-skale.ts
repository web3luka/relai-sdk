/**
 * x402 client — EVM payment on SKALE (gas-free).
 *
 * Usage:
 *   EVM_PRIVATE_KEY=0x... npx tsx examples/client/http/evm/x402-skale.ts [url]
 */
import "dotenv/config";
import { createX402Client } from "../../../../src/client";
import { privateKeyToAccount } from "viem/accounts";

const TARGET_URL = process.argv[2] || "http://localhost:4405/api/data";
const PRIVATE_KEY = process.env.EVM_PRIVATE_KEY!;
if (!PRIVATE_KEY) { console.error("EVM_PRIVATE_KEY required"); process.exit(1); }

const account = privateKeyToAccount(PRIVATE_KEY as `0x${string}`);

const client = createX402Client({
  wallets: { evm: { address: account.address, signTypedData: (d) => account.signTypedData(d as any) } },
  verbose: true,
});

const res = await client.fetch(TARGET_URL, { method: "GET" });
console.log(`Status: ${res.status}`);
console.log(`Body:`, await res.json());
