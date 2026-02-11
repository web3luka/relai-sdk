// src/client.ts
import {
  Connection,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import {
  getAssociatedTokenAddress,
  createTransferCheckedInstruction,
  getMint,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import type { SolanaWallet, EvmWallet, WalletSet } from './types';
import {
  RELAI_FACILITATOR_URL,
  NETWORK_CAIP2,
  CHAIN_IDS,
  isSolana,
  isEvm,
  normalizeNetwork,
  type RelaiNetwork,
} from './types';

// ============================================================================
// Types
// ============================================================================

export interface X402ClientConfig {
  /** Multi-chain wallets (Solana + EVM) */
  wallets?: WalletSet;
  /** Single Solana wallet (legacy shortcut) */
  wallet?: SolanaWallet;
  /** Custom facilitator URL, default: RelAI facilitator */
  facilitatorUrl?: string;
  /** Preferred network when multiple options available */
  preferredNetwork?: RelaiNetwork;
  /** Custom Solana RPC URL */
  solanaRpcUrl?: string;
  /** Custom EVM RPC URLs per network (e.g. { 'skale-base': 'https://...' }) */
  evmRpcUrls?: Record<string, string>;
  /** Maximum payment amount in atomic units */
  maxAmountAtomic?: string;
  /** Enable verbose logging */
  verbose?: boolean;
}

export interface X402Client {
  /** Fetch with automatic x402 payment handling */
  fetch(input: string | URL | Request, init?: RequestInit): Promise<Response>;
}

/**
 * Create an x402 client for automatic payment handling.
 * Supports all RelAI facilitator networks: Solana, Base, Avalanche, SKALE Base.
 * Auto-detects the correct chain from the 402 response and picks the right
 * signing method (Solana SPL transfer, EVM EIP-3009 transferWithAuthorization).
 *
 * @example
 * ```typescript
 * import { createX402Client } from '@relai-fi/x402';
 *
 * const client = createX402Client({
 *   wallets: { solana: solanaWallet, evm: evmWalletClient },
 * });
 *
 * // Automatically handles 402 on any RelAI-supported network
 * const response = await client.fetch('https://api.example.com/protected');
 * ```
 */
// Networks that use EIP-2612 permit instead of EIP-3009 transferWithAuthorization (currently none)
const PERMIT_NETWORKS = new Set<string>([]);

// Default EVM RPC URLs
const DEFAULT_EVM_RPC_URLS: Record<string, string> = {
  'skale-base': 'https://skale-base.skalenodes.com/v1/base',
  'base': 'https://mainnet.base.org',
  'avalanche': 'https://api.avax.network/ext/bc/C/rpc',
};

export function createX402Client(config: X402ClientConfig): X402Client {
  const {
    wallets = {},
    wallet: legacyWallet,
    facilitatorUrl = RELAI_FACILITATOR_URL,
    preferredNetwork,
    solanaRpcUrl = 'https://api.mainnet-beta.solana.com',
    evmRpcUrls = {},
    maxAmountAtomic,
    verbose = false,
  } = config;

  const log = verbose ? console.log.bind(console, '[relai-x402]') : () => {};

  // Merge legacy wallet into wallet set
  const effectiveWallets: WalletSet = { ...wallets };
  if (legacyWallet && !effectiveWallets.solana) {
    effectiveWallets.solana = legacyWallet;
  }

  const hasSolanaWallet = Boolean(
    effectiveWallets.solana?.publicKey && effectiveWallets.solana?.signTransaction
  );
  if (hasSolanaWallet) log('Solana wallet ready');

  // -----------------------------------------------------------------------
  // Select a payment option from the 402 response's `accepts` array
  // -----------------------------------------------------------------------
  function selectAccept(accepts: any[]): { accept: any; chain: 'solana' | 'evm' } | null {
    // 1) Preferred network first
    if (preferredNetwork) {
      const caip2 = NETWORK_CAIP2[preferredNetwork];
      for (const a of accepts) {
        const net = a.network || '';
        if (net === preferredNetwork || net === caip2) {
          const chain = isSolana(net) ? 'solana' as const : 'evm' as const;
          if ((chain === 'solana' && hasSolanaWallet) || (chain === 'evm' && effectiveWallets.evm)) {
            return { accept: a, chain };
          }
        }
      }
    }

    // 2) First option we have a wallet for
    for (const a of accepts) {
      const net = a.network || '';
      if (isSolana(net) && hasSolanaWallet) return { accept: a, chain: 'solana' };
      if (isEvm(net) && effectiveWallets.evm) return { accept: a, chain: 'evm' };
    }

    return null;
  }

  // -----------------------------------------------------------------------
  // JSON-RPC helper (for reading EVM contract state without ethers)
  // -----------------------------------------------------------------------
  async function evmRpcCall(rpcUrl: string, to: string, data: string): Promise<string> {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'eth_call',
        params: [{ to, data }, 'latest'],
        id: 1,
      }),
    });
    const json = await res.json();
    if (json.error) throw new Error(`RPC error: ${json.error.message}`);
    return json.result;
  }

  function getEvmRpcUrl(network: string): string {
    return evmRpcUrls[network] || DEFAULT_EVM_RPC_URLS[network] || '';
  }

  // -----------------------------------------------------------------------
  // Build EVM payment — EIP-2612 permit (for SKALE Base)
  // -----------------------------------------------------------------------
  async function buildEvmPermitPayment(
    accept: any,
    requirements: any,
    url: string,
  ): Promise<string> {
    const evmWallet = effectiveWallets.evm!;
    const extra = accept.extra || {};

    const rawNetwork = accept.network || '';
    const network = normalizeNetwork(rawNetwork);
    const chainId = network ? CHAIN_IDS[network] : parseInt(rawNetwork.split(':')[1] || '8453');
    const paymentAmount = accept.amount || accept.maxAmountRequired;
    const spender = extra.feePayer || accept.payTo;
    const usdcAddress = accept.asset;

    const rpcUrl = getEvmRpcUrl(network || rawNetwork);
    if (!rpcUrl) throw new Error(`[relai-x402] No EVM RPC URL for network ${network || rawNetwork}`);

    log('Building EIP-2612 permit on chain', chainId);

    // Read nonce from USDC contract: nonces(address) = 0x7ecebe00
    const paddedAddress = evmWallet.address.toLowerCase().replace('0x', '').padStart(64, '0');
    const nonceHex = await evmRpcCall(rpcUrl, usdcAddress, '0x7ecebe00' + paddedAddress);
    const nonce = nonceHex ? parseInt(nonceHex, 16) : 0;
    if (isNaN(nonce)) throw new Error(`[relai-x402] Failed to read permit nonce from ${usdcAddress} on ${rpcUrl}`);
    log('  Permit nonce:', nonce);

    // Read token name: name() = 0x06fdde03
    const nameHex = await evmRpcCall(rpcUrl, usdcAddress, '0x06fdde03');
    // Decode ABI-encoded string
    let tokenName = 'USD Coin';
    try {
      const offset = parseInt(nameHex.slice(2, 66), 16) * 2;
      const length = parseInt(nameHex.slice(2 + offset, 2 + offset + 64), 16);
      const hex = nameHex.slice(2 + offset + 64, 2 + offset + 64 + length * 2);
      tokenName = decodeURIComponent(hex.replace(/[0-9a-f]{2}/g, '%$&'));
    } catch {
      tokenName = extra.name || 'USD Coin';
    }
    log('  Token name:', tokenName);

    const deadline = Math.floor(Date.now() / 1000) + 600; // 10 min

    const domain = {
      name: tokenName,
      version: extra.version || '2',
      chainId,
      verifyingContract: usdcAddress,
    };

    const types = {
      Permit: [
        { name: 'owner', type: 'address' },
        { name: 'spender', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'nonce', type: 'uint256' },
        { name: 'deadline', type: 'uint256' },
      ],
    };

    const message = {
      owner: evmWallet.address,
      spender,
      value: paymentAmount,
      nonce: String(nonce),
      deadline: String(deadline),
    };

    log('Signing EIP-2612 permit:', message);

    const signature = await evmWallet.signTypedData({
      domain,
      types,
      message,
      primaryType: 'Permit',
    });

    // Split signature into v, r, s
    const sigHex = (signature as string).replace('0x', '');
    const r = '0x' + sigHex.slice(0, 64);
    const s = '0x' + sigHex.slice(64, 128);
    const v = parseInt(sigHex.slice(128, 130), 16);

    log('  Permit signed: v=%d r=%s s=%s', v, r, s);

    // Build x402 v2 payment payload (SKALE format)
    const paymentPayload = {
      x402Version: 2,
      scheme: 'exact',
      network: network || rawNetwork,
      payload: {
        userAddress: evmWallet.address,
        permit: { deadline: String(deadline), v, r, s },
        amount: paymentAmount,
      },
    };

    return btoa(JSON.stringify(paymentPayload));
  }

  // -----------------------------------------------------------------------
  // Build EVM payment (EIP-3009 transferWithAuthorization)
  // -----------------------------------------------------------------------
  async function buildEvmPayment(
    accept: any,
    requirements: any,
    url: string,
  ): Promise<string> {
    const evmWallet = effectiveWallets.evm!;
    const extra = accept.extra || {};

    const rawNetwork = accept.network || '';
    const network = normalizeNetwork(rawNetwork);
    const chainId = network ? CHAIN_IDS[network] : parseInt(rawNetwork.split(':')[1] || '8453');

    const paymentAmount = accept.amount || accept.maxAmountRequired;

    // EIP-3009 transferWithAuthorization typed data
    const domain = {
      name: extra.name || 'USD Coin',
      version: extra.version || '2',
      chainId,
      verifyingContract: accept.asset,
    };

    const validAfter = 0;
    const validBefore = Math.floor(Date.now() / 1000) + 3600;
    const nonce = '0x' + [...crypto.getRandomValues(new Uint8Array(32))]
      .map(b => b.toString(16).padStart(2, '0')).join('');

    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' },
      ],
    };

    const spender = extra.feePayer || accept.payTo;

    const message = {
      from: evmWallet.address,
      to: spender,
      value: paymentAmount,
      validAfter: String(validAfter),
      validBefore: String(validBefore),
      nonce,
    };

    log('Signing EIP-3009 transferWithAuthorization on chain', chainId);

    const signature = await evmWallet.signTypedData({
      domain,
      types,
      message,
      primaryType: 'TransferWithAuthorization',
    });

    // Build x402 v2 payment payload
    const paymentPayload = {
      x402Version: 2,
      resource: requirements.resource || { url },
      accepted: accept,
      payload: {
        authorization: message,
        signature,
      },
      facilitatorUrl,
    };

    return btoa(JSON.stringify(paymentPayload));
  }

  // -----------------------------------------------------------------------
  // Build Solana payment (SPL transfer with fee payer sponsorship)
  // -----------------------------------------------------------------------
  async function buildSolanaPayment(
    accept: any,
    requirements: any,
    url: string,
  ): Promise<string> {
    const solWallet = effectiveWallets.solana!;
    const extra = accept.extra || {};

    if (!extra.feePayer) {
      throw new Error('[relai-x402] Missing feePayer in Solana payment requirements');
    }

    const connection = new Connection(solanaRpcUrl, 'confirmed');
    const userPubkey = new PublicKey(solWallet.publicKey!.toString());
    const merchantPubkey = new PublicKey(accept.payTo);
    const feePayerPubkey = new PublicKey(extra.feePayer);
    const mintPubkey = new PublicKey(accept.asset);
    const paymentAmount = BigInt(accept.amount || accept.maxAmountRequired);

    log('Building Solana SPL transfer');
    log('  User:', userPubkey.toBase58());
    log('  Merchant:', merchantPubkey.toBase58());
    log('  FeePayer:', feePayerPubkey.toBase58());
    log('  Mint:', mintPubkey.toBase58());
    log('  Amount:', paymentAmount.toString());

    // Determine token program (TOKEN_PROGRAM_ID vs TOKEN_2022)
    const mintInfo = await getMint(connection, mintPubkey);
    const programId = mintInfo.address.equals(mintPubkey)
      ? (mintInfo as any).owner?.toBase58?.() === TOKEN_2022_PROGRAM_ID.toBase58()
        ? TOKEN_2022_PROGRAM_ID
        : TOKEN_PROGRAM_ID
      : TOKEN_PROGRAM_ID;

    // Get ATAs
    const sourceAta = await getAssociatedTokenAddress(
      mintPubkey, userPubkey, false, programId,
    );
    const destinationAta = await getAssociatedTokenAddress(
      mintPubkey, merchantPubkey, true, programId,
    );

    log('  Source ATA:', sourceAta.toBase58());
    log('  Dest ATA:', destinationAta.toBase58());

    // Build transfer instruction
    const transferIx = createTransferCheckedInstruction(
      sourceAta,
      mintPubkey,
      destinationAta,
      userPubkey,
      paymentAmount,
      mintInfo.decimals,
      [],
      programId,
    );

    // Build versioned transaction with feePayer
    const { blockhash } = await connection.getLatestBlockhash('confirmed');
    const message = new TransactionMessage({
      payerKey: feePayerPubkey,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }).compileToV0Message();

    const transaction = new VersionedTransaction(message);

    // User signs (feePayer signs on backend/facilitator side)
    const signedTx = await solWallet.signTransaction!(transaction) as VersionedTransaction;
    log('Transaction signed by user');

    // Serialize to base64
    const serializedTx = Buffer.from(signedTx.serialize()).toString('base64');

    // Build x402 v2 payment payload
    const paymentPayload = {
      x402Version: 2,
      resource: requirements.resource || { url },
      accepted: accept,
      payload: {
        transaction: serializedTx,
      },
    };

    return btoa(JSON.stringify(paymentPayload));
  }

  // -----------------------------------------------------------------------
  // Main fetch
  // -----------------------------------------------------------------------
  async function x402Fetch(
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    log('Request:', url);

    const response = await fetch(input, init);
    if (response.status !== 402) return response;

    log('Got 402 Payment Required');

    let requirements: any;
    try {
      requirements = await response.clone().json();
    } catch {
      throw new Error('[relai-x402] Failed to parse 402 response body');
    }

    const accepts = requirements.accepts || [];
    if (!accepts.length) throw new Error('[relai-x402] No payment options in 402 response');

    const selected = selectAccept(accepts);
    if (!selected) {
      const networks = accepts.map((a: any) => a.network).join(', ');
      throw new Error(`[relai-x402] No wallet available for networks: ${networks}`);
    }

    const { accept, chain } = selected;
    const amount = accept.amount || accept.maxAmountRequired;
    log(`Selected: ${chain} / ${accept.network} / amount=${amount}`);

    // Amount guard
    if (maxAmountAtomic && BigInt(amount) > BigInt(maxAmountAtomic)) {
      throw new Error(`[relai-x402] Amount ${amount} exceeds max ${maxAmountAtomic}`);
    }

    // Solana — build SPL transfer natively (no x402-solana dependency)
    if (chain === 'solana' && hasSolanaWallet) {
      const paymentHeader = await buildSolanaPayment(accept, requirements, url);
      log('Retrying with X-PAYMENT header (Solana)');
      return fetch(input, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          'X-PAYMENT': paymentHeader,
        },
      });
    }

    // EVM — build payment header and retry
    if (chain === 'evm') {
      const evmNetwork = normalizeNetwork(accept.network || '');
      const usePermit = evmNetwork && PERMIT_NETWORKS.has(evmNetwork);
      const paymentHeader = usePermit
        ? await buildEvmPermitPayment(accept, requirements, url)
        : await buildEvmPayment(accept, requirements, url);
      log('Retrying with X-PAYMENT header');
      return fetch(input, {
        ...init,
        headers: {
          ...(init?.headers || {}),
          'X-PAYMENT': paymentHeader,
        },
      });
    }

    throw new Error('[relai-x402] Unexpected state — no payment handler matched');
  }

  return { fetch: x402Fetch };
}

export default createX402Client;
