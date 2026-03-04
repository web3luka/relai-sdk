/**
 * Crossmint smart wallet integration for RelAI x402.
 *
 * Two modes:
 *
 * **API-key mode** — zero private keys, Crossmint signs + broadcasts:
 * ```ts
 * import { createCrossmintX402Fetch } from "@relai-fi/x402/crossmint";
 *
 * const fetch402 = createCrossmintX402Fetch({
 *   apiKey: process.env.CROSSMINT_API_KEY!,
 *   wallet: process.env.CROSSMINT_WALLET!,
 *   connection: new Connection(process.env.RPC_URL!),
 * });
 * const resp = await fetch402("https://api.example.com/protected");
 * ```
 *
 * **Delegated mode** — external signer approves each transaction:
 * ```ts
 * import { createCrossmintDelegatedX402Fetch } from "@relai-fi/x402/crossmint";
 *
 * const fetch402 = createCrossmintDelegatedX402Fetch({
 *   apiKey: process.env.CROSSMINT_API_KEY!,
 *   wallet: process.env.CROSSMINT_WALLET!,
 *   signerSecretKey: myKeypairBytes, // 64-byte Ed25519
 *   connection: new Connection(process.env.RPC_URL!),
 * });
 * const resp = await fetch402("https://api.example.com/protected");
 * ```
 *
 * @module
 */
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  TransactionMessage,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

import nacl from "tweetnacl";

// ── Types ───────────────────────────────────────────────────────────

export interface CrossmintX402Config {
  /** Crossmint server-side API key (`sk_production_...` or `sk_staging_...`) */
  apiKey: string;

  /** Crossmint smart wallet address (Solana public key) */
  wallet: string;

  /** Solana RPC connection */
  connection: Connection;

  /** Override Crossmint API base URL (default: `https://www.crossmint.com/api/2025-06-09`) */
  crossmintApiBase?: string;

  /** Max polling attempts for tx confirmation (default: 30) */
  maxPollAttempts?: number;

  /** Polling interval in ms (default: 2000) */
  pollIntervalMs?: number;

  /** Called after successful on-chain payment with the Solana tx signature */
  onPayment?: (txHash: string) => void;
}

export interface CrossmintDelegatedX402Config extends CrossmintX402Config {
  /**
   * Ed25519 secret key for the external signer (64 bytes).
   * The corresponding public key must be registered as an external signer
   * on the Crossmint smart wallet.
   */
  signerSecretKey: Uint8Array;

  /** Crossmint environment: "staging" or "production" (default: auto-detect from apiKey) */
  environment?: "staging" | "production";
}

// ── Internals ───────────────────────────────────────────────────────

const DEFAULT_API_BASE = "https://www.crossmint.com/api/2025-06-09";
const STAGING_API_BASE = "https://staging.crossmint.com/api/2025-06-09";

/** Auto-detect Crossmint API base from API key prefix. */
function detectApiBase(apiKey: string): string {
  if (apiKey.startsWith("sk_staging")) return STAGING_API_BASE;
  return DEFAULT_API_BASE;
}

/** Encode bytes to base58 without external dependency. */
function toBase58(bytes: Uint8Array): string {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const digits = [0];
  for (const byte of bytes) {
    let carry = byte;
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = "";
  for (const byte of bytes) {
    if (byte === 0) str += ALPHABET[0];
    else break;
  }
  for (let i = digits.length - 1; i >= 0; i--) {
    str += ALPHABET[digits[i]];
  }
  return str;
}

/** Decode base58 string to bytes. */
function fromBase58(str: string): Uint8Array {
  const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const BASE_MAP = new Uint8Array(256).fill(255);
  for (let i = 0; i < ALPHABET.length; i++) BASE_MAP[ALPHABET.charCodeAt(i)] = i;
  const bytes: number[] = [0];
  for (const ch of str) {
    const carry_init = BASE_MAP[ch.charCodeAt(0)];
    if (carry_init === 255) throw new Error(`Invalid base58 character: ${ch}`);
    let carry = carry_init;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58;
      bytes[j] = carry & 0xff;
      carry >>= 8;
    }
    while (carry > 0) {
      bytes.push(carry & 0xff);
      carry >>= 8;
    }
  }
  for (const ch of str) {
    if (ch === ALPHABET[0]) bytes.push(0);
    else break;
  }
  return new Uint8Array(bytes.reverse());
}

/** Extract Solana signature from Crossmint's full serialized tx (base58). */
function extractSignature(onChainTx: string): string | null {
  if (!onChainTx) return null;
  if (onChainTx.length <= 100) return onChainTx; // Already a bare signature
  try {
    const decoded = fromBase58(onChainTx);
    const vtx = VersionedTransaction.deserialize(decoded);
    if (vtx.signatures?.[0]) return toBase58(vtx.signatures[0]);
  } catch {
    // Not a valid serialized tx
  }
  return null;
}

/** Make a Crossmint API call. */
async function crossmintApi(
  baseUrl: string, apiKey: string, endpoint: string,
  body?: unknown, method: "GET" | "POST" = "POST",
): Promise<any> {
  const url = `${baseUrl}/wallets/${endpoint}`;
  const opts: RequestInit = {
    method,
    headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
  };
  if (method === "POST" && body) opts.body = JSON.stringify(body);
  const resp = await fetch(url, opts);
  const json = await resp.json();
  if (!resp.ok) throw new Error(`[x402/crossmint] API ${resp.status}: ${JSON.stringify(json)}`);
  return json;
}

/** Sign a message with Ed25519. Message can be base58-encoded or UTF-8 string. */
function signMessage(message: string, secretKey: Uint8Array): string {
  let messageBytes: Uint8Array;
  try {
    messageBytes = fromBase58(message);
  } catch {
    messageBytes = new TextEncoder().encode(message);
  }
  const signature = nacl.sign.detached(messageBytes, secretKey);
  return toBase58(signature);
}

/** Derive public key address from a 64-byte secret key. */
function deriveSignerAddress(secretKey: Uint8Array): string {
  const publicKey = secretKey.length === 64
    ? secretKey.slice(32)
    : nacl.sign.keyPair.fromSeed(secretKey).publicKey;
  return toBase58(publicKey);
}

/** Poll Crossmint for on-chain txId. Returns signature or null. */
async function pollForSignature(
  apiBase: string, apiKey: string, wallet: string,
  txId: string, maxPolls: number, pollMs: number,
  initialData?: any,
): Promise<string | null> {
  let sig = initialData?.onChain?.txId
    || extractSignature(initialData?.onChain?.transaction) || null;

  for (let i = 0; i < maxPolls && !sig; i++) {
    await new Promise((r) => setTimeout(r, pollMs));
    const p = await crossmintApi(apiBase, apiKey,
      `${encodeURIComponent(wallet)}/transactions/${txId}`, undefined, "GET");
    if (p.status === "failed") {
      throw new Error(`[x402/crossmint] Crossmint tx failed: ${p.error?.message || "unknown"}`);
    }
    sig = p.onChain?.txId || extractSignature(p.onChain?.transaction) || null;
  }
  return sig;
}

/** Build X-PAYMENT header from unsigned tx + on-chain signature + payment requirements. */
function buildXPaymentHeader(unsignedTx: VersionedTransaction, sig: string, accept: any): string {
  const payload = {
    x402Version: 2,
    scheme: "exact",
    network: accept.network,
    payload: {
      transaction: Buffer.from(unsignedTx.serialize()).toString("base64"),
      txId: sig,
    },
    accepted: {
      scheme: accept.scheme,
      network: accept.network,
      amount: accept.amount,
      asset: accept.asset,
      payTo: accept.payTo,
    },
  };
  return Buffer.from(JSON.stringify(payload)).toString("base64");
}

/** Build unsigned SPL transfer tx from 402 payment requirements. */
async function buildTransferTx(
  connection: Connection, userPubkey: PublicKey, accept: any,
): Promise<VersionedTransaction> {
  const mintPubkey = new PublicKey(accept.asset);
  const merchantPubkey = new PublicKey(accept.payTo);
  const mintAccountInfo = await connection.getAccountInfo(mintPubkey);
  const programId = mintAccountInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;

  const mintInfo = await getMint(connection, mintPubkey, "confirmed", programId);
  const amount = BigInt(accept.amount);

  const sourceAta = await getAssociatedTokenAddress(mintPubkey, userPubkey, true, programId);
  const destAta = await getAssociatedTokenAddress(mintPubkey, merchantPubkey, true, programId);

  const ix = createTransferCheckedInstruction(
    sourceAta, mintPubkey, destAta, userPubkey,
    amount, mintInfo.decimals, [], programId,
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");
  const msg = new TransactionMessage({
    payerKey: userPubkey,
    recentBlockhash: blockhash,
    instructions: [ix],
  }).compileToV0Message();

  return new VersionedTransaction(msg);
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * **API-key mode.** Create a fetch wrapper that auto-handles x402 `402`
 * responses using a Crossmint smart wallet on Solana.
 *
 * Crossmint signs and broadcasts — no private key needed.
 * The returned function has the same signature as `fetch()`.
 */
export function createCrossmintX402Fetch(config: CrossmintX402Config) {
  const { apiKey, wallet, connection } = config;
  const apiBase = config.crossmintApiBase || detectApiBase(apiKey);
  const maxPolls = config.maxPollAttempts ?? 30;
  const pollMs = config.pollIntervalMs ?? 2000;
  const userPubkey = new PublicKey(wallet);

  return async function fetch402(url: string, init?: RequestInit): Promise<Response> {
    // 1. Initial request
    const firstResp = await fetch(url, {
      ...init, headers: { Accept: "application/json", ...init?.headers },
    });
    if (firstResp.status !== 402) return firstResp;

    // 2. Parse 402
    const requirements = (await firstResp.json()) as any;
    const accept = requirements.accepts?.[0];
    if (!accept) throw new Error("[x402/crossmint] No payment requirements in 402 response");

    // 3. Build transfer tx
    const unsignedTx = await buildTransferTx(connection, userPubkey, accept);

    // 4. Submit to Crossmint (signs + broadcasts)
    const txData = await crossmintApi(apiBase, apiKey,
      `${encodeURIComponent(wallet)}/transactions`,
      { params: { transaction: toBase58(unsignedTx.serialize()) } });

    // 5. Poll for on-chain signature
    const sig = await pollForSignature(apiBase, apiKey, wallet, txData.id, maxPolls, pollMs, txData);
    if (!sig) throw new Error("[x402/crossmint] Timed out waiting for tx confirmation");

    config.onPayment?.(sig);

    // 6. Retry with X-PAYMENT
    const xPayment = buildXPaymentHeader(unsignedTx, sig, accept);
    return fetch(url, {
      ...init, headers: { Accept: "application/json", "X-PAYMENT": xPayment, ...init?.headers },
    });
  };
}

/**
 * **Delegated mode.** Create a fetch wrapper that auto-handles x402 `402`
 * responses using a Crossmint smart wallet with external signer approval.
 *
 * Each transaction requires cryptographic approval from `signerSecretKey`
 * before Crossmint broadcasts. This provides an extra security layer —
 * even with the API key, transactions cannot execute without the signer.
 *
 * The external signer must be registered on the Crossmint smart wallet
 * via the Crossmint console or API.
 */
export function createCrossmintDelegatedX402Fetch(config: CrossmintDelegatedX402Config) {
  const { apiKey, wallet, connection, signerSecretKey } = config;
  const apiBase = config.crossmintApiBase || detectApiBase(apiKey);
  const maxPolls = config.maxPollAttempts ?? 30;
  const pollMs = config.pollIntervalMs ?? 2000;
  const userPubkey = new PublicKey(wallet);
  const signerAddress = deriveSignerAddress(signerSecretKey);

  return async function fetch402(url: string, init?: RequestInit): Promise<Response> {
    // 1. Initial request
    const firstResp = await fetch(url, {
      ...init, headers: { Accept: "application/json", ...init?.headers },
    });
    if (firstResp.status !== 402) return firstResp;

    // 2. Parse 402
    const requirements = (await firstResp.json()) as any;
    const accept = requirements.accepts?.[0];
    if (!accept) throw new Error("[x402/crossmint] No payment requirements in 402 response");

    // 3. Build transfer tx
    const unsignedTx = await buildTransferTx(connection, userPubkey, accept);

    // 4. Submit to Crossmint with external signer
    const createResp = await crossmintApi(apiBase, apiKey,
      `${encodeURIComponent(wallet)}/transactions`,
      {
        params: {
          transaction: toBase58(unsignedTx.serialize()),
          signer: {
            type: "external-wallet",
            locator: `external-wallet:${signerAddress}`,
          },
        },
      });

    const transactionId = createResp.id;
    const pendingApproval = createResp.approvals?.pending?.[0];

    if (!transactionId || !pendingApproval) {
      throw new Error(
        `[x402/crossmint] No pending approval returned. ` +
        `Ensure external signer ${signerAddress} is registered on wallet ${wallet}. ` +
        `Response: ${JSON.stringify(createResp)}`
      );
    }

    // 5. Sign the approval message
    const pendingSigner = pendingApproval.signer?.address
      ?? pendingApproval.signer?.locator?.split(":")[1]
      ?? signerAddress;

    const approvalSig = signMessage(pendingApproval.message, signerSecretKey);

    // 6. Submit approval
    const approvalResp = await crossmintApi(apiBase, apiKey,
      `${encodeURIComponent(wallet)}/transactions/${encodeURIComponent(transactionId)}/approvals`,
      {
        approvals: [{
          signer: `external-wallet:${pendingSigner}`,
          signature: approvalSig,
        }],
      });

    // 7. Poll for on-chain signature
    const sig = await pollForSignature(
      apiBase, apiKey, wallet, transactionId, maxPolls, pollMs, approvalResp);
    if (!sig) throw new Error("[x402/crossmint] Timed out waiting for tx confirmation");

    config.onPayment?.(sig);

    // 8. Retry with X-PAYMENT
    const xPayment = buildXPaymentHeader(unsignedTx, sig, accept);
    return fetch(url, {
      ...init, headers: { Accept: "application/json", "X-PAYMENT": xPayment, ...init?.headers },
    });
  };
}
