/**
 * Payment Request API — Merchant-initiated x402 payment codes
 *
 * Flow (reverse of payment-codes):
 *   1. Merchant calls createPayRequest() → gets a short code
 *   2. Merchant shares the code with the buyer (QR, link, message)
 *   3. Buyer calls getPayRequest() → sees amount, merchant, description
 *   4. Buyer calls payPayRequest() with their signer → USDC sent directly to merchant
 *
 * createPayRequest()  — merchant creates a payment request (no signature needed)
 * getPayRequest()     — buyer reads request details (amount, merchant, description)
 * payPayRequest()     — buyer signs EIP-3009 and submits payment
 */

import { NETWORK_CONFIGS, redeemPaymentCode, getPaymentCode, type PaymentCodeNetwork, type PaymentCodeSigner, type RedeemResult } from "./payment-codes.js";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface PaymentRequestConfig {
  /** RelAI facilitator base URL (default: https://relai.fi/facilitator) */
  facilitatorUrl?: string;
}

export interface CreatePayRequestParams {
  /** Merchant wallet address — receives the USDC */
  to: string;
  /** Amount in USDC micro-units (6 decimals), e.g. 1_000_000 = $1.00 */
  amount: number | bigint;
  /** Settlement network (default: "base-sepolia") */
  network?: PaymentCodeNetwork;
  /** Payment description shown to the buyer, e.g. "Coffee ☕" */
  description?: string;
  /** Code TTL in seconds (min 60, max 86400, default 3600) */
  ttlSeconds?: number;
}

export interface PayRequest {
  /** 8-character alphanumeric code, e.g. "X7K9P2AB" */
  code: string;
  /** Unix timestamp when the request expires */
  validUntil: number;
  /** Address the buyer must use as EIP-3009 `to` (settler/relayer, NOT merchant directly) */
  toAddress: string;
  /** USDC contract on the settlement network */
  usdcContract: string;
}

export interface PayRequestInfo {
  code: string;
  /** Merchant wallet address */
  to: string;
  /** EIP-3009 `to` address (settler/relayer) */
  toAddress: string;
  amount: number;
  network: string;
  usdcContract: string;
  description: string | null;
  validUntil: number;
  expiresIn: number;
  status: "pending" | "processing" | "paid";
  payable: boolean;
}

export interface PayRequestResult {
  success: boolean;
  code: string;
  payTxHash: string | null;
  explorerUrl?: string;
  network?: string;
  private?: boolean;
  amount?: string;
  /** Merchant address that received the USDC */
  to?: string;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

const DEFAULT_FACILITATOR = "https://relai.fi/facilitator";

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
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { randomBytes } = require("crypto");
    randomBytes(32).copy(Buffer.from(bytes.buffer));
  }
  return "0x" + Array.from(bytes).map(b => b.toString(16).padStart(2, "0")).join("");
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Create a payment request — merchant/seller side.
 * No signing required. Returns a short code to share with the buyer.
 *
 * @example Merchant/agent creates a $5 invoice:
 * ```ts
 * const req = await createPayRequest(config, {
 *   to:          '0xMerchantWallet...',
 *   amount:      5_000_000,   // $5.00 USDC
 *   network:     'base-sepolia',
 *   description: 'Order #1234 — 2× coffee',
 *   ttlSeconds:  900,         // 15 minutes
 * });
 * // req.code = "X7K9P2AB" — share via QR / link / message
 * // link: https://relai.fi/pay#X7K9P2AB
 * ```
 */
export async function createPayRequest(
  config: PaymentRequestConfig,
  params: CreatePayRequestParams,
): Promise<PayRequest> {
  const {
    to, amount, network = "base-sepolia",
    description, ttlSeconds,
  } = params;
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;

  const res = await fetch(`${facilitatorUrl}/payment-requests`, {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify({
      to,
      amount:     Number(amount),
      network,
      ...(description ? { description } : {}),
      ...(ttlSeconds  ? { ttlSeconds }  : {}),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Failed to create payment request: ${err.error ?? res.status}`);
  }

  return res.json() as Promise<PayRequest>;
}

/**
 * Get the status and details of a payment request — buyer side.
 *
 * @example
 * ```ts
 * const info = await getPayRequest(config, 'X7K9P2AB');
 * console.log(`Pay $${info.amount / 1e6} to ${info.to}`);
 * console.log('Description:', info.description);
 * console.log('Payable:', info.payable);
 * ```
 */
export async function getPayRequest(
  config: PaymentRequestConfig,
  code: string,
): Promise<PayRequestInfo> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;

  const res = await fetch(
    `${facilitatorUrl}/payment-requests/${code.trim().toUpperCase()}`,
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(`Payment request not found: ${err.error ?? res.status}`);
  }

  return res.json() as Promise<PayRequestInfo>;
}

/**
 * Pay a payment request — buyer side.
 * Signs an EIP-3009 authorization and submits it to the facilitator,
 * which executes the on-chain transfer to the merchant.
 *
 * @example Buyer pays using a private key (agent):
 * ```ts
 * import { createPrivateKeySigner } from '@relai-fi/x402';
 *
 * const signer = createPrivateKeySigner(process.env.BUYER_PRIVATE_KEY!);
 * const result = await payPayRequest(config, 'X7K9P2AB', signer);
 * console.log('Paid! Explorer:', result.explorerUrl);
 * ```
 */
export async function payPayRequest(
  config: PaymentRequestConfig,
  code: string,
  signer: PaymentCodeSigner,
): Promise<PayRequestResult> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;

  // 1. Fetch request info
  const info = await getPayRequest(config, code);
  if (!info.payable) {
    throw new Error(
      info.status === "paid"
        ? "Payment request already paid"
        : "Payment request expired or not payable",
    );
  }

  // 2. Resolve network config for EIP-712 domain
  const netKey = info.network as PaymentCodeNetwork;
  const net    = NETWORK_CONFIGS[netKey];
  if (!net) throw new Error(`Unknown network from payment request: ${info.network}`);

  const from        = await signer.getAddress();
  const now         = Math.floor(Date.now() / 1000);
  const validBefore = Math.min(now + 300, info.validUntil); // 5 min or request expiry
  const nonce       = randomBytes32();

  // 3. Sign EIP-3009 TransferWithAuthorization
  const domain = {
    name:              net.domainName,
    version:           "2",
    chainId:           net.chainId,
    verifyingContract: info.usdcContract,
  };

  const signature = await signer.signTypedData(domain, EIP3009_TYPES, {
    from,
    to:          info.toAddress,   // settler/relayer — NOT the merchant directly
    value:       String(info.amount),
    validAfter:  0,
    validBefore,
    nonce,
  });

  // 4. Submit to facilitator — server executes settler.settle(buyer → merchant)
  const res = await fetch(
    `${facilitatorUrl}/payment-requests/${code.trim().toUpperCase()}/pay`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ from, validAfter: 0, validBefore, nonce, signature }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.error ?? `Payment failed: ${res.status}`);
  }

  return res.json() as Promise<PayRequestResult>;
}

/**
 * Pay a merchant's payment request using a pre-generated payment code.
 * The buyer already holds a BLIK-style code (created via generatePaymentCode) —
 * instead of signing on the spot, they redeem that code and USDC goes to the merchant.
 *
 * The payment code must have enough value to cover the request amount.
 * If the code was created without a locked payee, the merchant address is set at redemption time.
 *
 * @example
 * ```ts
 * // Merchant shares their invoice code: "SHOP1234"
 * // Buyer has a pre-generated payment code: "MYBLIK78"
 * const result = await payPayRequestWithCode(config, 'SHOP1234', 'MYBLIK78');
 * console.log('Paid! Explorer:', result.explorerUrl);
 * ```
 */
export interface PayPayRequestWithCodeOptions {
  /**
   * How to return the change when the payment code value exceeds the invoice amount.
   * - `'code'` (default) — relayer pays the merchant, then generates a new payment
   *    code for the remainder and returns it as `result.changeCode`. Works even when
   *    the buyer has no wallet (pure code-based flow).
   * - `'wallet'` — uses `settler.settleExact()` on-chain: merchant receives exact
   *    invoice amount, surplus is returned atomically to the buyer's wallet (`from`).
   *    Requires the payment code was created with `to = settler` (atomic mode).
   *
   * Set `allowOverpayment: false` to throw instead of handling the difference.
   */
  returnChange?: 'code' | 'wallet';
  /**
   * If false, throws when code value ≠ invoice amount (strict match).
   * Default: true — difference is handled per `returnChange`.
   */
  allowOverpayment?: boolean;
}

export async function payPayRequestWithCode(
  config: PaymentRequestConfig,
  /** The merchant's payment request code */
  requestCode: string,
  /** The buyer's pre-generated BLIK-style payment code */
  paymentCode: string,
  options: PayPayRequestWithCodeOptions = {},
): Promise<RedeemResult> {
  const { allowOverpayment = true, returnChange = 'code' } = options;

  // 1. Fetch request info to get the merchant address
  const info = await getPayRequest(config, requestCode);
  if (!info.payable) {
    throw new Error(
      info.status === "paid"
        ? "Payment request already paid"
        : "Payment request expired or not payable",
    );
  }

  // 2. Verify the payment code status and amount
  const codeStatus = await getPaymentCode(config, paymentCode);
  if (!codeStatus.redeemable) {
    throw new Error(
      codeStatus.redeemed
        ? "Payment code already redeemed"
        : "Payment code expired or not redeemable",
    );
  }

  const codeValue   = BigInt(codeStatus.value);
  const reqAmount   = BigInt(info.amount);

  if (codeValue < reqAmount) {
    throw new Error(
      `Payment code value (${ Number(codeValue) / 1e6 } USDC) is less than ` +
      `the request amount (${ Number(reqAmount) / 1e6 } USDC)`,
    );
  }

  if (!allowOverpayment && codeValue > reqAmount) {
    throw new Error(
      `Payment code value (${ Number(codeValue) / 1e6 } USDC) exceeds ` +
      `the request amount (${ Number(reqAmount) / 1e6 } USDC). ` +
      `Generate a code for the exact amount, or pass { allowOverpayment: true }.`,
    );
  }

  // 3. Redeem the payment code directing USDC to the merchant.
  //    When code value > invoiceAmount:
  //      returnChange='code'   → backend pays merchant, generates a new change code
  //      returnChange='wallet' → backend calls settler.settleExact(), change to buyer wallet
  const facilitatorUrl = config.facilitatorUrl ?? "https://relai.fi/facilitator";
  const usePartial = codeValue > reqAmount;

  const res = await fetch(
    `${facilitatorUrl}/payment-codes/${paymentCode.trim().toUpperCase()}/redeem`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({
        payee:              info.to,
        ...(usePartial ? { invoiceAmount: info.amount.toString() } : {}),
        ...(usePartial ? { returnChangeAsCode: returnChange === 'code' } : {}),
      }),
    },
  );

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.error ?? `Redeem failed: ${res.status}`);
  }

  return res.json() as Promise<RedeemResult>;
}
