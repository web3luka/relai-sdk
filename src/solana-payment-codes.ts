/**
 * Solana Payment Codes — trustless BLIK-style codes via Anchor on-chain escrow
 *
 * Trustless model (PDA vault, no custodian needed):
 *   1. generateSolanaPaymentCode() — builds create_vault Anchor instruction,
 *      buyer signs, relayer co-signs as feePayer, USDC moves to on-chain PDA vault
 *   2. getSolanaPaymentCode()      — reads on-chain vault state
 *   3. redeemSolanaPaymentCode()   — backend calls redeem_vault (permissionless)
 *   4. cancelSolanaPaymentCode()   — buyer signs cancel_vault, relayer co-signs + broadcasts
 *
 * Comparison to EVM payment codes:
 *   EVM   — EIP-3009 pre-authorisation (lazy, USDC never moves until settlement)
 *   Solana — Anchor PDA vault (USDC locked on-chain, no custodian holds it)
 */

import type { PaymentRequestConfig } from "./payment-requests.js";

const DEFAULT_FACILITATOR = "https://relai.fi/facilitator";

// ── Types ─────────────────────────────────────────────────────────────────────

export interface SolanaCodeConfig extends PaymentRequestConfig {}

export interface GenerateSolanaPaymentCodeParams {
  /** Amount in USDC micro-units (6 decimals), e.g. 1_000_000 = $1.00 */
  amount: number | bigint;
  /** Solana network (default: auto-detected from relayer-info) */
  network?: "solana" | "solana-devnet";
  /** Solana RPC URL (default: public mainnet/devnet endpoint) */
  solanaRpcUrl?: string;
  /** Code TTL in seconds (min 60, max 604800 = 7 days, default 86400 = 24 h) */
  ttlSeconds?: number;
}

export interface SolanaPaymentCode {
  /** 8-char alphanumeric code, e.g. "X7K9P2AB" */
  code: string;
  /** Unix timestamp when the code expires */
  validUntil: number;
  /** Amount in µUSDC (6 decimals) */
  amount: string;
  /** Solana network */
  network: string;
  /** Solscan explorer link for the funding transaction */
  explorerUrl: string;
}

export interface SolanaCodeStatus {
  code: string;
  amount: string;
  /** Buyer's Solana address (who funded the code) */
  from: string | null;
  network: string;
  /** "funded" | "redeemed" | "cancelled" | "expired" | "not-found" */
  status: string;
  redeemable: boolean;
  /** On-chain vault PDA address */
  vaultPda: string;
  createdAt: number | null;
  validUntil: number | null;
  fundingTxHash: string | null;
}

export interface SolanaCodeRedeemResult {
  success: boolean;
  code: string;
  redeemTxHash: string;
  explorerUrl: string;
  amount: string;
  payee: string;
  network: string;
}

export interface SolanaCodeCancelResult {
  success: boolean;
  code: string;
  cancelTxHash: string;
  explorerUrl: string;
  network: string;
}

// ── SolanaWalletAdapter (re-used from payment-requests) ───────────────────────

export interface SolanaWalletAdapter {
  publicKey: { toString(): string } | null;
  signTransaction<T>(transaction: T): Promise<T>;
}

// ── Internal helpers ──────────────────────────────────────────────────────────

/** Generate a random 8-char BLIK-style code (cross-env: Node + browser). */
function generateCode(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(8);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    // Node.js — dynamic import to avoid breaking browser bundles
    const { randomBytes } = require('crypto') as typeof import('crypto');
    randomBytes(8).copy(Buffer.from(bytes.buffer));
  }
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[bytes[i] % chars.length];
  return code;
}

/** Compute Anchor instruction discriminator: sha256("global:<name>").slice(0, 8) */
async function anchorDisc(name: string): Promise<Uint8Array> {
  const preimage = new TextEncoder().encode(`global:${name}`);
  if (typeof globalThis !== 'undefined' && globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', preimage);
    return new Uint8Array(hash).slice(0, 8);
  }
  // Node.js fallback
  const { createHash } = require('crypto') as typeof import('crypto');
  return new Uint8Array(createHash('sha256').update(preimage).digest()).slice(0, 8);
}

/** Build a create_vault or cancel_vault instruction data buffer. */
async function buildInstructionData(
  name: 'create_vault' | 'cancel_vault',
  codeBytes: Uint8Array,
  extra?: { amount: bigint; validUntil: bigint },
): Promise<Buffer> {
  const disc = await anchorDisc(name);
  if (name === 'create_vault' && extra) {
    // disc(8) + code_bytes(8) + amount u64 LE(8) + valid_until i64 LE(8) = 32
    const buf = Buffer.alloc(32);
    Buffer.from(disc).copy(buf, 0);
    Buffer.from(codeBytes).copy(buf, 8);
    buf.writeBigUInt64LE(extra.amount, 16);
    buf.writeBigInt64LE(extra.validUntil, 24);
    return buf;
  }
  // disc(8) + code_bytes(8) = 16
  const buf = Buffer.alloc(16);
  Buffer.from(disc).copy(buf, 0);
  Buffer.from(codeBytes).copy(buf, 8);
  return buf;
}

// ── generateSolanaPaymentCode ──────────────────────────────────────────────────

/**
 * Generate a trustless BLIK-style Solana payment code.
 *
 * Builds an Anchor `create_vault` instruction: USDC moves from buyer ATA
 * into an on-chain PDA vault.  The relayer co-signs only as feePayer;
 * it cannot access the vault — only the redeem/cancel instructions can.
 *
 * @example Agent pre-funds a payment code on Solana Devnet:
 * ```ts
 * const { code } = await generateSolanaPaymentCode(config, wallet, {
 *   amount:  5_000_000,     // $5.00 USDC
 *   network: 'solana-devnet',
 * });
 * console.log('Share this code:', code); // "ABCD1234"
 * ```
 */
export async function generateSolanaPaymentCode(
  config: SolanaCodeConfig,
  wallet: SolanaWalletAdapter,
  params: GenerateSolanaPaymentCodeParams,
): Promise<SolanaPaymentCode> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const { solanaRpcUrl, ttlSeconds = 86400 } = params;
  const amount = BigInt(params.amount);
  if (amount <= 0n) throw new Error('amount must be positive');
  if (!wallet.publicKey) throw new Error('Solana wallet not connected');

  // 1. Fetch relayer info — need relayer address (feePayer) + program ID
  const infoRes = await fetch(`${facilitatorUrl}/solana-payment-codes/relayer-info`);
  if (!infoRes.ok) throw new Error('Failed to fetch Solana relayer info');
  const relayerInfo = await infoRes.json() as any;

  const network: 'solana' | 'solana-devnet' =
    params.network ?? relayerInfo.defaultNetwork ?? 'solana';
  const relayerAddr: string = relayerInfo.address;
  const programId: string   = relayerInfo.programId;
  const usdcMint: string    =
    relayerInfo.networks?.[network]?.usdc ??
    (network === 'solana-devnet'
      ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  // 2. Generate random code + derive vault PDA
  const code      = generateCode();
  const codeBytes = new TextEncoder().encode(code); // 8 ASCII bytes

  const {
    Connection, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction,
  } = await import('@solana/web3.js');
  const {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  } = await import('@solana/spl-token');

  const rpcUrl = solanaRpcUrl ??
    (network === 'solana-devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
  const connection = new Connection(rpcUrl, 'confirmed');

  const programPK  = new PublicKey(programId);
  const mintPK     = new PublicKey(usdcMint);
  const buyerPK    = new PublicKey(wallet.publicKey.toString());
  const relayerPK  = new PublicKey(relayerAddr);

  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), Buffer.from(codeBytes)],
    programPK,
  );

  const vaultAta = getAssociatedTokenAddressSync(mintPK, vaultPda, true,    TOKEN_PROGRAM_ID);
  const buyerAta = getAssociatedTokenAddressSync(mintPK, buyerPK,  false,   TOKEN_PROGRAM_ID);
  const systemProgram = new PublicKey('11111111111111111111111111111111');

  const validUntil = BigInt(Math.floor(Date.now() / 1000) + Math.min(Math.max(ttlSeconds, 60), 604800));

  // 3. Build create_vault instruction
  const ixData = await buildInstructionData('create_vault', codeBytes, { amount, validUntil });

  const createVaultIx = new TransactionInstruction({
    programId: programPK,
    keys: [
      { pubkey: buyerPK,                    isSigner: true,  isWritable: true  }, // buyer
      { pubkey: vaultPda,                   isSigner: false, isWritable: true  }, // vault PDA (init)
      { pubkey: vaultAta,                   isSigner: false, isWritable: true  }, // vault ATA (init)
      { pubkey: buyerAta,                   isSigner: false, isWritable: true  }, // buyer ATA
      { pubkey: mintPK,                     isSigner: false, isWritable: false }, // usdc_mint
      { pubkey: TOKEN_PROGRAM_ID,           isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: systemProgram,              isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey:        relayerPK,  // relayer pays gas only
    recentBlockhash: blockhash,
    instructions:    [createVaultIx],
  }).compileToV0Message();

  const tx     = new VersionedTransaction(message);
  const signed = await wallet.signTransaction(tx);
  const serialized = Buffer.from((signed as any).serialize()).toString('base64');

  // 4. POST to backend — relayer co-signs as feePayer + broadcasts
  const body: Record<string, unknown> = {
    transaction: serialized,
    code,
    amount:      amount.toString(),
    network,
    ttlSeconds,
  };

  const res = await fetch(`${facilitatorUrl}/solana-payment-codes`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.error ?? `generateSolanaPaymentCode failed: ${res.status}`);
  }

  return res.json() as Promise<SolanaPaymentCode>;
}

// ── getSolanaPaymentCode ───────────────────────────────────────────────────────

/**
 * Get the current status of a Solana payment code.
 */
export async function getSolanaPaymentCode(
  config: SolanaCodeConfig,
  code: string,
): Promise<SolanaCodeStatus> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const res = await fetch(
    `${facilitatorUrl}/solana-payment-codes/${code.trim().toUpperCase()}`,
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.error ?? `getSolanaPaymentCode failed: ${res.status}`);
  }
  return res.json() as Promise<SolanaCodeStatus>;
}

// ── redeemSolanaPaymentCode ────────────────────────────────────────────────────

/**
 * Redeem a Solana payment code — transfer USDC from relayer's escrow to `payee`.
 * `payee` is a base58 Solana address.
 *
 * @example Merchant redeems a code they received:
 * ```ts
 * const result = await redeemSolanaPaymentCode(config, 'ABCD1234', merchantSolanaAddress);
 * console.log('Redeemed! tx:', result.explorerUrl);
 * ```
 */
export async function redeemSolanaPaymentCode(
  config: SolanaCodeConfig,
  code: string,
  payee: string,
): Promise<SolanaCodeRedeemResult> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;
  const res = await fetch(
    `${facilitatorUrl}/solana-payment-codes/${code.trim().toUpperCase()}/redeem`,
    {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ payee }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.error ?? `redeemSolanaPaymentCode failed: ${res.status}`);
  }
  return res.json() as Promise<SolanaCodeRedeemResult>;
}

// ── cancelSolanaPaymentCode ────────────────────────────────────────────────────

/**
 * Cancel a Solana payment code — returns USDC from the PDA vault back to the buyer.
 *
 * The buyer must sign the `cancel_vault` transaction (only the original buyer can cancel).
 * The relayer co-signs as feePayer so the buyer doesn't need SOL for gas.
 *
 * @param wallet - The buyer's Solana wallet (must be the original code creator)
 */
export async function cancelSolanaPaymentCode(
  config: SolanaCodeConfig,
  code: string,
  wallet: SolanaWalletAdapter,
  options: { solanaRpcUrl?: string; network?: 'solana' | 'solana-devnet' } = {},
): Promise<SolanaCodeCancelResult> {
  const facilitatorUrl = config.facilitatorUrl ?? DEFAULT_FACILITATOR;
  if (!wallet.publicKey) throw new Error('Solana wallet not connected');

  const codeUpper = code.trim().toUpperCase();

  // 1. Fetch relayer info
  const infoRes = await fetch(`${facilitatorUrl}/solana-payment-codes/relayer-info`);
  if (!infoRes.ok) throw new Error('Failed to fetch Solana relayer info');
  const relayerInfo = await infoRes.json() as any;

  const network: 'solana' | 'solana-devnet' =
    options.network ?? relayerInfo.defaultNetwork ?? 'solana';
  const relayerAddr: string = relayerInfo.address;
  const programId: string   = relayerInfo.programId;
  const usdcMint: string    =
    relayerInfo.networks?.[network]?.usdc ??
    (network === 'solana-devnet'
      ? '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU'
      : 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');

  const {
    Connection, PublicKey, TransactionMessage, VersionedTransaction, TransactionInstruction,
  } = await import('@solana/web3.js');
  const {
    getAssociatedTokenAddressSync,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
  } = await import('@solana/spl-token');

  const rpcUrl = options.solanaRpcUrl ??
    (network === 'solana-devnet' ? 'https://api.devnet.solana.com' : 'https://api.mainnet-beta.solana.com');
  const connection = new Connection(rpcUrl, 'confirmed');

  const programPK = new PublicKey(programId);
  const mintPK    = new PublicKey(usdcMint);
  const buyerPK   = new PublicKey(wallet.publicKey.toString());
  const relayerPK = new PublicKey(relayerAddr);

  const codeBytes = new TextEncoder().encode(codeUpper);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from('vault'), Buffer.from(codeBytes)],
    programPK,
  );

  const vaultAta = getAssociatedTokenAddressSync(mintPK, vaultPda, true,  TOKEN_PROGRAM_ID);
  const buyerAta = getAssociatedTokenAddressSync(mintPK, buyerPK,  false, TOKEN_PROGRAM_ID);
  const systemProgram = new PublicKey('11111111111111111111111111111111');

  // 2. Build cancel_vault instruction
  const ixData = await buildInstructionData('cancel_vault', codeBytes);

  const cancelIx = new TransactionInstruction({
    programId: programPK,
    keys: [
      { pubkey: buyerPK,                     isSigner: true,  isWritable: true  }, // buyer (must sign)
      { pubkey: vaultPda,                    isSigner: false, isWritable: true  }, // vault PDA
      { pubkey: vaultAta,                    isSigner: false, isWritable: true  }, // vault ATA
      { pubkey: buyerAta,                    isSigner: false, isWritable: true  }, // buyer ATA
      { pubkey: mintPK,                      isSigner: false, isWritable: false },
      { pubkey: TOKEN_PROGRAM_ID,            isSigner: false, isWritable: false },
      { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: systemProgram,               isSigner: false, isWritable: false },
    ],
    data: ixData,
  });

  const { blockhash } = await connection.getLatestBlockhash('confirmed');
  const message = new TransactionMessage({
    payerKey:        relayerPK,
    recentBlockhash: blockhash,
    instructions:    [cancelIx],
  }).compileToV0Message();

  const tx     = new VersionedTransaction(message);
  const signed = await wallet.signTransaction(tx);
  const serialized = Buffer.from((signed as any).serialize()).toString('base64');

  // 3. POST to backend — relayer co-signs as feePayer + broadcasts
  const res = await fetch(
    `${facilitatorUrl}/solana-payment-codes/${codeUpper}/cancel`,
    {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ transaction: serialized, network }),
    },
  );
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as any;
    throw new Error(err.error ?? `cancelSolanaPaymentCode failed: ${res.status}`);
  }
  return res.json() as Promise<SolanaCodeCancelResult>;
}
