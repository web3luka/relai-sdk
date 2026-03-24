/**
 * Payment Code API — BLIK-style x402 payment codes
 *
 * createPrivateKeySigner()    — create a signer from a raw private key (for agents/bots)
 * generatePaymentCode()       — sign EIP-3009 authorization and register on SKALE L3
 * generatePaymentCodesBatch() — register up to 20 codes in one call (agent budget)
 * redeemPaymentCode()         — redeem a code (payee calls this, triggers Base L2 settlement)
 * getPaymentCode()            — check code status
 * cancelPaymentCode()         — cancel/revoke a code before redemption
 */

import { ethers } from "ethers";

// ── Network configs ───────────────────────────────────────────────────────────

export type PaymentCodeNetwork =
  | "base"
  | "base-sepolia"
  | "skale-base"
  | "skale-base-sepolia";

export interface NetworkConfig {
  chainId: number;
  usdc: string;
  /** EIP-712 domain name of the USDC contract on this network */
  domainName: string;
  rpc: string;
  settlementNetwork: string;
}

export const NETWORK_CONFIGS: Record<PaymentCodeNetwork, NetworkConfig> = {
  "base": {
    chainId:           8453,
    usdc:              "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    domainName:        "USD Coin",
    rpc:               "https://mainnet.base.org",
    settlementNetwork: "base",
  },
  "base-sepolia": {
    chainId:           84532,
    usdc:              "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    domainName:        "USDC",
    rpc:               "https://sepolia.base.org",
    settlementNetwork: "base-sepolia",
  },
  "skale-base-sepolia": {
    chainId:           324705682,
    usdc:              "0x2e08028E3C4c2356572E096d8EF835cD5C6030bD",
    domainName:        "Bridged USDC (SKALE Bridge)",
    rpc:               "https://base-sepolia-testnet.skalenodes.com/v1/jubilant-horrible-ancha",
    settlementNetwork: "skale-base-sepolia",
  },
  "skale-base": {
    chainId:           1482601649,
    usdc:              "0x85889c8c714505E0c94b30fcfcF64fE3Ac8FCb20",
    domainName:        "Bridged USDC",
    rpc:               "https://skale-base.skalenodes.com/v1/base",
    settlementNetwork: "skale-base",
  },
};

// ── EIP-3009 types ────────────────────────────────────────────────────────────

const EIP3009_TYPES = {
  TransferWithAuthorization: [
    { name: "from",        type: "address" },
    { name: "to",          type: "address" },
    { name: "value",       type: "uint256" },
    { name: "validAfter",  type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce",       type: "bytes32" },
  ],
};

// ── Signer interface ──────────────────────────────────────────────────────────

export interface PaymentCodeSigner {
  getAddress(): Promise<string>;
  signTypedData(domain: object, types: object, value: object): Promise<string>;
}

/**
 * Create an EIP-712 signer from a raw private key.
 * Intended for agents/bots running server-side with a custodial wallet.
 *
 * @example
 * const signer = createPrivateKeySigner(process.env.AGENT_PRIVATE_KEY!);
 * const { code } = await generatePaymentCode(config, { signer, value: 1_000_000n });
 */
export function createPrivateKeySigner(privateKey: string): PaymentCodeSigner {
  const wallet = new ethers.Wallet(privateKey);
  return {
    getAddress: () => Promise.resolve(wallet.address),
    signTypedData: (domain, types, value) =>
      wallet.signTypedData(domain as any, types as any, value),
  };
}

// ── Config / params / result types ───────────────────────────────────────────

export interface PaymentCodeConfig {
  /** RelAI facilitator base URL (default: https://relai.fi/facilitator) */
  facilitatorUrl?: string;
}

export interface GeneratePaymentCodeParams {
  /** EIP-3009 signer — use createPrivateKeySigner() for agents */
  signer: PaymentCodeSigner;
  /** Settlement network (default: "base-sepolia") */
  network?: PaymentCodeNetwork;
  /** Amount in USDC micro-units (6 decimals), e.g. 1_000_000 = $1.00 */
  value: string | bigint;
  /** TTL in seconds (default: 86400 = 24 h) */
  ttl?: number;
  /** Optional message shown to the recipient when they claim */
  description?: string;
  /**
   * Lock the code to a specific payee address — only that address can redeem it.
   * Useful for agent-to-agent payments or scheduled disbursements.
   */
  payee?: string;
  /** Override the USDC contract address */
  usdcContract?: string;
}

export interface BatchCodeItem {
  /** Amount in USDC micro-units */
  value: string | bigint;
  /** TTL in seconds (default: 86400) */
  ttl?: number;
}

export interface GeneratePaymentCodesBatchParams {
  signer: PaymentCodeSigner;
  /** Settlement network (default: "base-sepolia") */
  network?: PaymentCodeNetwork;
  /** Up to 20 codes to register */
  codes: BatchCodeItem[];
  /** Lock all codes to a specific payee */
  payee?: string;
  /** Override the USDC contract address */
  usdcContract?: string;
  /** RelAI auth token (required — batch endpoint is authenticated) */
  authToken: string;
}

export interface PaymentCode {
  code: string;
  validBefore: number;
  expiresIn: number;
  relayerAddress: string;
  settlementNetwork: string;
  locked: boolean;
  description?: string | null;
}

export interface BatchPaymentCodesResult {
  registered: number;
  codes: Pick<PaymentCode, "code" | "validBefore" | "expiresIn" | "locked">[];
  failed: { index: number; error: string }[];
  relayerAddress: string;
  settlementNetwork: string;
}

export interface RedeemResult {
  success: boolean;
  code: string;
  l3TxHash: string;
  l2TxHash: string;
  explorerUrl: string;
  settlementNetwork: string;
  private: boolean;
  amount: string;
  from: string;
  payee: string;
  /** Amount returned as change (µUSDC), present when invoiceAmount < code value */
  change?: string;
  /** How the change was returned: 'code' = new payment code, 'wallet' = sent to from address */
  changeMode?: 'code' | 'wallet';
  /** New payment code for the change amount (present when changeMode === 'code') */
  changeCode?: string;
}

export interface CodeStatus {
  code: string;
  from: string;
  to: string;
  value: string;
  validBefore: number;
  redeemed: boolean;
  expired: boolean;
  redeemable: boolean;
  settlementNetwork: string | null;
  description: string | null;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const DEFAULT_FACILITATOR = "https://relai.fi/facilitator";

function randomBytes32(): string {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto !== "undefined") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node.js fallback
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomBytes } = require("crypto");
    randomBytes(32).copy(Buffer.from(bytes.buffer));
  }
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

async function fetchToAddress(
  facilitatorUrl: string,
  network: PaymentCodeNetwork,
): Promise<string> {
  const res = await fetch(`${facilitatorUrl}/payment-codes/relayer?network=${network}`);
  if (!res.ok) throw new Error("Failed to fetch relayer address from facilitator");
  const data = await res.json() as { toAddress: string };
  if (!data.toAddress) throw new Error("Facilitator returned no toAddress");
  return data.toAddress;
}

async function signEip3009(
  signer: PaymentCodeSigner,
  net: NetworkConfig,
  from: string,
  toAddress: string,
  value: string,
  validAfter: number,
  validBefore: number,
  nonce: string,
  usdcOverride?: string,
): Promise<string> {
  const domain = {
    name:              net.domainName,
    version:           "2",
    chainId:           net.chainId,
    verifyingContract: usdcOverride ?? net.usdc,
  };
  return signer.signTypedData(domain, EIP3009_TYPES, {
    from, to: toAddress, value, validAfter, validBefore, nonce,
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Generate a BLIK-style x402 payment code backed by an EIP-3009 authorization.
 * The facilitator registers it on SKALE L3 — no gas cost for the payer.
 * The `to` address (settler/relayer) is fetched automatically from the facilitator.
 *
 * @example Agent usage (Node.js / server-side):
 * ```ts
 * import { createPrivateKeySigner, generatePaymentCode } from '@relai-fi/x402';
 *
 * const signer = createPrivateKeySigner(process.env.AGENT_PRIVATE_KEY!);
 * const { code } = await generatePaymentCode(
 *   { facilitatorUrl: 'https://relai.fi/facilitator' },
 *   { signer, value: 1_000_000n, ttl: 3600, description: 'coffee' },
 * );
 * // code = "X7K9P2AB" — share with the payee, e.g. via SMS / email / QR
 * ```
 */
export async function generatePaymentCode(
  config: PaymentCodeConfig,
  params: GeneratePaymentCodeParams,
): Promise<PaymentCode> {
  const {
    signer, value, ttl = 86400, description, payee,
    usdcContract, network = "base-sepolia",
  } = params;
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const net  = NETWORK_CONFIGS[network];
  if (!net)  throw new Error(`Unsupported network: ${network}`);

  const from        = await signer.getAddress();
  const now         = Math.floor(Date.now() / 1000);
  const validBefore = now + ttl;
  const nonce       = randomBytes32();
  const usdc        = usdcContract ?? net.usdc;
  const toAddress   = await fetchToAddress(facilitatorUrl, network);

  const signature = await signEip3009(
    signer, net, from, toAddress,
    BigInt(value).toString(), 0, validBefore, nonce, usdc,
  );

  const res = await fetch(`${facilitatorUrl}/payment-codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      value:             BigInt(value).toString(),
      validAfter:        0,
      validBefore,
      nonce,
      signature,
      usdcContract:      usdc,
      settlementNetwork: net.settlementNetwork,
      ...(description ? { description } : {}),
      ...(payee       ? { payee }       : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Failed to register payment code: ${err.error ?? res.status}`);
  }

  return res.json() as Promise<PaymentCode>;
}

/**
 * Generate multiple payment codes in one call — agent budget allocation pattern.
 * Each code is independently signed. Max 20 codes per call.
 * Requires a valid RelAI `authToken`.
 *
 * @example
 * ```ts
 * const { codes } = await generatePaymentCodesBatch(config, {
 *   signer,
 *   authToken: process.env.RELAI_API_KEY!,
 *   codes: Array(10).fill({ value: 1_000_000n, ttl: 3600 }),  // 10 × $1.00
 * });
 * // codes[0].code = "X7K9P2AB", codes[1].code = "B3R5N7QA", …
 * ```
 */
export async function generatePaymentCodesBatch(
  config: PaymentCodeConfig,
  params: GeneratePaymentCodesBatchParams,
): Promise<BatchPaymentCodesResult> {
  const {
    signer, codes, payee, usdcContract,
    network = "base-sepolia", authToken,
  } = params;
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const net = NETWORK_CONFIGS[network];
  if (!net)            throw new Error(`Unsupported network: ${network}`);
  if (codes.length > 20) throw new Error("Maximum 20 codes per batch");

  const from      = await signer.getAddress();
  const usdc      = usdcContract ?? net.usdc;
  const now       = Math.floor(Date.now() / 1000);
  const toAddress = await fetchToAddress(facilitatorUrl, network);

  const signedCodes = await Promise.all(
    codes.map(async (item) => {
      const validBefore = now + (item.ttl ?? 86400);
      const nonce       = randomBytes32();
      const value       = BigInt(item.value).toString();
      const signature   = await signEip3009(
        signer, net, from, toAddress, value, 0, validBefore, nonce, usdc,
      );
      return { value, validAfter: 0, validBefore, nonce, signature };
    }),
  );

  const res = await fetch(`${facilitatorUrl}/payment-codes/batch`, {
    method: "POST",
    headers: {
      "Content-Type":  "application/json",
      "Authorization": `Bearer ${authToken}`,
    },
    body: JSON.stringify({
      from,
      settlementNetwork: net.settlementNetwork,
      usdcContract:      usdc,
      ...(payee ? { payee } : {}),
      codes: signedCodes,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Batch registration failed: ${err.error ?? res.status}`);
  }

  return res.json() as Promise<BatchPaymentCodesResult>;
}

/**
 * Redeem a payment code. Triggers USDC settlement on Base L2 or SKALE.
 * No wallet connection needed on the payee side — just provide a destination address.
 *
 * @example
 * ```ts
 * const result = await redeemPaymentCode(config, "X7K9P2AB", "0xYourWallet...");
 * console.log(result.explorerUrl); // https://sepolia.basescan.org/tx/0x...
 * ```
 */
export async function redeemPaymentCode(
  config: PaymentCodeConfig,
  code: string,
  /** Address to receive the USDC (required unless code was registered with a locked payee) */
  payee?: string,
): Promise<RedeemResult> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;

  const res = await fetch(
    `${facilitatorUrl}/payment-codes/${code.trim().toUpperCase()}/redeem`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify(payee ? { payee } : {}),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.error ?? `Redeem failed: ${res.status}`);
  }

  return res.json() as Promise<RedeemResult>;
}

/**
 * Get the current status of a payment code.
 */
export async function getPaymentCode(
  config: PaymentCodeConfig,
  code: string,
): Promise<CodeStatus> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;

  const res = await fetch(
    `${facilitatorUrl}/payment-codes/${code.trim().toUpperCase()}`,
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Payment code not found: ${err.error ?? res.status}`);
  }

  return res.json() as Promise<CodeStatus>;
}

/**
 * Cancel a payment code before it is redeemed.
 * Soft-cancels immediately (relayer will refuse to settle);
 * also attempts a hard-cancel on SKALE L3 to mark it used on-chain.
 */
export async function cancelPaymentCode(
  config: PaymentCodeConfig,
  code: string,
): Promise<{ success: boolean; l3TxHash: string | null }> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;

  const res = await fetch(
    `${facilitatorUrl}/payment-codes/${code.trim().toUpperCase()}`,
    { method: "DELETE" },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Cancel failed: ${err.error ?? res.status}`);
  }

  return res.json();
}
