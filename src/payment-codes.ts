/**
 * Payment Code API — BLIK-style x402 payment codes
 *
 * generatePaymentCode() — sign EIP-3009 authorization and register on SKALE L3
 * redeemPaymentCode()   — redeem a code (payee calls this, triggers Base L2 settlement)
 * getPaymentCode()      — check code status
 */

export interface PaymentCodeConfig {
  facilitatorUrl?: string;
}

export interface GeneratePaymentCodeParams {
  /** EIP-3009 signer — must implement signTypedData */
  signer: {
    getAddress(): Promise<string>;
    signTypedData(domain: object, types: object, value: object): Promise<string>;
  };
  /** Payee wallet address */
  to: string;
  /** Amount in USDC micro-units (6 decimals), e.g. 1000 = $0.001 */
  value: string | bigint;
  /** USDC contract address on Base L2 (defaults to Base mainnet USDC) */
  usdcContract?: string;
  /** TTL in seconds (default: 120) */
  ttl?: number;
}

export interface PaymentCode {
  code: string;
  validBefore: number;
  expiresIn: number;
}

export interface RedeemResult {
  success: boolean;
  code: string;
  l3TxHash: string;
  l2TxHash: string;
  explorerUrl: string;
  amount: string;
  from: string;
  to: string;
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
}

const DEFAULT_FACILITATOR = "https://relai.fi/facilitator";
const DEFAULT_USDC_BASE   = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

// EIP-3009 domain + types for USDC on Base
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

function randomBytes32(): string {
  const bytes = new Uint8Array(32);
  if (typeof globalThis.crypto !== "undefined") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node.js fallback
    const { randomBytes } = require("crypto");
    randomBytes(32).copy(Buffer.from(bytes.buffer));
  }
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Generate a BLIK-style x402 payment code backed by EIP-3009.
 *
 * @example
 * const { code } = await generatePaymentCode(config, {
 *   signer: walletClient,
 *   to: "0xMerchant...",
 *   value: "1000",  // $0.001 USDC
 *   ttl: 120,
 * });
 * // code = "X7K9P2AB"
 */
export async function generatePaymentCode(
  config: PaymentCodeConfig,
  params: GeneratePaymentCodeParams
): Promise<PaymentCode> {
  const { signer, to, value, usdcContract, ttl = 120 } = params;
  const facilitatorUrl = config.facilitatorUrl || DEFAULT_FACILITATOR;
  const usdc = usdcContract || DEFAULT_USDC_BASE;

  const from       = await signer.getAddress();
  const now        = Math.floor(Date.now() / 1000);
  const validAfter = 0;
  const validBefore = now + ttl;
  const nonce      = randomBytes32();

  // Sign EIP-3009 authorization
  const domain = {
    name:              "USD Coin",
    version:           "2",
    chainId:           8453, // Base mainnet
    verifyingContract: usdc,
  };

  const message = {
    from,
    to,
    value:       BigInt(value).toString(),
    validAfter,
    validBefore,
    nonce,
  };

  const signature = await signer.signTypedData(domain, EIP3009_TYPES, message);

  // Register on SKALE L3 via server
  const res = await fetch(`${facilitatorUrl}/payment-codes`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to,
      value: BigInt(value).toString(),
      validAfter,
      validBefore,
      nonce,
      signature,
      usdcContract: usdc,
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to register payment code: ${(err as any).error || res.status}`);
  }

  return res.json() as Promise<PaymentCode>;
}

/**
 * Redeem a payment code. Triggers Base L2 settlement via relayer.
 *
 * @example
 * const result = await redeemPaymentCode(config, "X7K9P2AB");
 * // result.l2TxHash = "0x..."
 */
export async function redeemPaymentCode(
  config: PaymentCodeConfig,
  code: string
): Promise<RedeemResult> {
  const facilitatorUrl = config.facilitatorUrl || DEFAULT_FACILITATOR;

  const res = await fetch(`${facilitatorUrl}/payment-codes/${code.toUpperCase()}/redeem`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Failed to redeem payment code: ${(err as any).error || res.status}`);
  }

  return res.json() as Promise<RedeemResult>;
}

/**
 * Get the status of a payment code.
 */
export async function getPaymentCode(
  config: PaymentCodeConfig,
  code: string
): Promise<CodeStatus> {
  const facilitatorUrl = config.facilitatorUrl || DEFAULT_FACILITATOR;

  const res = await fetch(`${facilitatorUrl}/payment-codes/${code.toUpperCase()}`);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Payment code not found: ${(err as any).error || res.status}`);
  }

  return res.json() as Promise<CodeStatus>;
}
