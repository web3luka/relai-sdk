/**
 * Crossmint smart wallet integration for RelAI x402.
 *
 * Auto-handles 402 Payment Required responses using a Crossmint
 * API-key smart wallet on Solana. Zero private keys needed —
 * Crossmint signs and broadcasts, RelAI facilitator verifies on-chain.
 *
 * @example
 * ```ts
 * import { createCrossmintX402Fetch } from "@relai-fi/x402/crossmint";
 * import { Connection } from "@solana/web3.js";
 *
 * const fetch402 = createCrossmintX402Fetch({
 *   apiKey: process.env.CROSSMINT_API_KEY!,
 *   wallet: process.env.CROSSMINT_WALLET!,
 *   connection: new Connection(process.env.RPC_URL!),
 * });
 *
 * const resp = await fetch402("https://api.example.com/protected");
 * console.log(await resp.json()); // paid content
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
}

// ── Internals ───────────────────────────────────────────────────────

const DEFAULT_API_BASE = "https://www.crossmint.com/api/2025-06-09";

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

/** Extract Solana signature from Crossmint's full serialized tx (base58). */
function extractSignature(onChainTx: string): string | null {
  if (!onChainTx) return null;
  if (onChainTx.length <= 100) return onChainTx; // Already a bare signature
  try {
    // Decode base58 → deserialize VersionedTransaction → first signature
    const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    const BASE_MAP = new Uint8Array(256).fill(255);
    for (let i = 0; i < ALPHABET.length; i++) BASE_MAP[ALPHABET.charCodeAt(i)] = i;
    const bytes: number[] = [0];
    for (const ch of onChainTx) {
      const carry_init = BASE_MAP[ch.charCodeAt(0)];
      if (carry_init === 255) return null;
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
    for (const ch of onChainTx) {
      if (ch === ALPHABET[0]) bytes.push(0);
      else break;
    }
    const decoded = new Uint8Array(bytes.reverse());
    const vtx = VersionedTransaction.deserialize(decoded);
    if (vtx.signatures?.[0]) return toBase58(vtx.signatures[0]);
  } catch {
    // Not a valid serialized tx
  }
  return null;
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Create a fetch wrapper that auto-handles x402 `402 Payment Required`
 * responses using a Crossmint smart wallet on Solana.
 *
 * The returned function has the same signature as `fetch()`.
 * On a 402 response it will:
 * 1. Parse payment requirements
 * 2. Build a Solana SPL transfer instruction
 * 3. Submit to Crossmint API (which signs + broadcasts)
 * 4. Poll for on-chain confirmation
 * 5. Retry the original request with an `X-PAYMENT` header
 */
export function createCrossmintX402Fetch(config: CrossmintX402Config) {
  const { apiKey, wallet, connection } = config;
  const apiBase = config.crossmintApiBase || DEFAULT_API_BASE;
  const maxPolls = config.maxPollAttempts ?? 30;
  const pollMs = config.pollIntervalMs ?? 2000;
  const userPubkey = new PublicKey(wallet);

  return async function fetch402(
    url: string,
    init?: RequestInit,
  ): Promise<Response> {
    // 1. Initial request
    const firstResp = await fetch(url, {
      ...init,
      headers: { Accept: "application/json", ...init?.headers },
    });
    if (firstResp.status !== 402) return firstResp;

    // 2. Parse payment requirements
    const requirements = (await firstResp.json()) as any;
    const accept = requirements.accepts?.[0];
    if (!accept) throw new Error("[x402/crossmint] No payment requirements in 402 response");

    // 3. Build SPL transfer instruction
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

    const unsignedTx = new VersionedTransaction(msg);
    const serializedBase58 = toBase58(unsignedTx.serialize());

    // 4. Send to Crossmint (signs + broadcasts)
    const txResp = await fetch(
      `${apiBase}/wallets/${encodeURIComponent(wallet)}/transactions`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
        body: JSON.stringify({ params: { transaction: serializedBase58 } }),
      },
    );
    const txData = (await txResp.json()) as any;
    if (!txResp.ok || !txData.id) {
      throw new Error(`[x402/crossmint] Crossmint API error: ${JSON.stringify(txData)}`);
    }

    // 5. Poll for on-chain signature
    let sig: string | null =
      txData.onChain?.txId || extractSignature(txData.onChain?.transaction) || null;

    for (let i = 0; i < maxPolls && !sig; i++) {
      await new Promise((r) => setTimeout(r, pollMs));
      const poll = await fetch(
        `${apiBase}/wallets/${encodeURIComponent(wallet)}/transactions/${txData.id}`,
        { headers: { "X-API-KEY": apiKey } },
      );
      const p = (await poll.json()) as any;
      if (p.status === "failed") {
        throw new Error(`[x402/crossmint] Crossmint tx failed: ${p.error?.message || "unknown"}`);
      }
      sig = p.onChain?.txId || extractSignature(p.onChain?.transaction) || null;
    }
    if (!sig) {
      throw new Error("[x402/crossmint] Timed out waiting for Crossmint tx confirmation");
    }

    // 6. Build X-PAYMENT header with pre-broadcast txId
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
    const xPayment = Buffer.from(JSON.stringify(payload)).toString("base64");

    // 7. Retry with payment
    return fetch(url, {
      ...init,
      headers: { Accept: "application/json", "X-PAYMENT": xPayment, ...init?.headers },
    });
  };
}
