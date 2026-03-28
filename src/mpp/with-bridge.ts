/**
 * MPP client method with transparent cross-chain bridge.
 *
 * Registers as `evm/charge` — the server does NOT need to expose a bridge method.
 * When the client can't pay directly (different chain), it bridges transparently
 * via the RelAI bridge and presents the target-chain tx as a normal direct payment.
 *
 * The server's standard `evmCharge()` verify() validates the on-chain tx normally
 * — it never knows a bridge was involved.
 *
 * Usage:
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { evmChargeWithBridge } from '@relai-fi/x402/mpp/with-bridge'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const account = privateKeyToAccount('0x...')
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     evmChargeWithBridge({
 *       evmAccount: account,
 *       sourceChainId: 4217,       // Tempo — the chain your wallet is on
 *       sourceRpcUrl: 'https://rpc.tempo.xyz',
 *     }),
 *   ],
 *   polyfill: false,
 * })
 *
 * // Works with any server that exposes evm/charge on any chain (SKALE, Base, etc.)
 * const res = await mppx.fetch('https://api.example.com/paid-endpoint')
 * ```
 */
import { Method, Credential } from 'mppx'
import {
  createWalletClient,
  http,
  encodeFunctionData,
  type Account,
  type Chain,
} from 'viem'
import { charge as EvmChargeMethod } from './evm-method.js'
import {
  getBridgeInfo,
  settleBridge,
  selectSourceChain,
  DEFAULT_EVM_RPC,
} from '../bridge.js'

// ERC-20 transfer ABI
const ERC20_TRANSFER_ABI = [
  {
    name: 'transfer',
    type: 'function',
    inputs: [
      { name: 'to', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
] as const

export interface EvmChargeWithBridgeConfig {
  /** viem Account (from privateKeyToAccount or similar) */
  evmAccount?: Account
  /** The EVM chain ID where this account lives (e.g., 4217 for Tempo, 8453 for Base) */
  sourceChainId?: number
  /** RPC URL for the source chain (required for bridge payments) */
  sourceRpcUrl?: string
  /** Solana keypair for Solana source chain payments */
  solanaKeypair?: {
    publicKey: { toBase58(): string }
    secretKey: Uint8Array
  }
  /** Solana RPC URL (default: https://api.mainnet-beta.solana.com) */
  solanaRpcUrl?: string
  /** Override RPC URLs per chain: { "eip155:4217": "https://..." } */
  rpcUrls?: Record<string, string>
  /** RelAI API base URL for bridge auto-discovery (default: https://api.relai.fi) */
  bridgeBaseUrl?: string
}

export function evmChargeWithBridge(config: EvmChargeWithBridgeConfig) {
  const { evmAccount, solanaKeypair, solanaRpcUrl, sourceChainId, sourceRpcUrl, rpcUrls, bridgeBaseUrl } = config

  if (!evmAccount && !solanaKeypair) {
    throw new Error('[relai:withBridge] At least one of evmAccount or solanaKeypair is required')
  }

  const sourceCaip2 = sourceChainId ? `eip155:${sourceChainId}` : undefined

  // Merge source RPC into lookup
  const allRpcUrls: Record<string, string> = {
    ...DEFAULT_EVM_RPC,
    ...rpcUrls,
    ...(sourceRpcUrl && sourceCaip2 ? { [sourceCaip2]: sourceRpcUrl } : {}),
  }

  return Method.toClient(EvmChargeMethod, {
    async createCredential({ challenge }) {
      const request = challenge.request as {
        amount: string
        currency: string
        recipient: string
        methodDetails: {
          chainId: number
          network?: string
          rpcUrl?: string
          decimals?: number
          reference: string
        }
      }

      const { amount: rawAmount, currency: tokenAddress, recipient, methodDetails } = request
      const targetChainId = methodDetails.chainId
      const decimals = methodDetails.decimals ?? 6

      // Normalize amount: may be USD decimal ("0.050000") or already atomic ("50000")
      let amount: string
      try {
        BigInt(rawAmount)
        amount = rawAmount
      } catch {
        amount = String(Math.round(parseFloat(rawAmount) * 10 ** decimals))
      }

      // Override amount with normalized atomic value
      const normalizedRequest = { ...request, amount }

      // ── Direct payment (same chain, EVM only) ─────────────────────
      if (evmAccount && sourceChainId && targetChainId === sourceChainId) {
        return directPayment(challenge, normalizedRequest)
      }

      // ── Bridge payment (cross-chain) ───────────────────────────────
      return bridgedPayment(challenge, normalizedRequest)
    },
  })

  // ─── Direct payment (same as evm-client.ts) ─────────────────────────

  async function directPayment(challenge: any, request: any): Promise<string> {
    if (!evmAccount) {
      throw new Error('[relai:withBridge] evmAccount required for direct EVM payment')
    }

    const { amount, currency: tokenAddress, recipient, methodDetails } = request
    const { chainId, rpcUrl: challengeRpcUrl } = methodDetails
    const rpcUrl = allRpcUrls[`eip155:${chainId}`] || challengeRpcUrl

    if (!rpcUrl) {
      throw new Error(`[relai:withBridge] No RPC URL for target chain eip155:${chainId}`)
    }

    const chain: Chain = {
      id: chainId,
      name: methodDetails.network || `eip155:${chainId}`,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    }

    const walletClient = createWalletClient({
      account: evmAccount,
      chain,
      transport: http(rpcUrl),
    })

    const txHash = await walletClient.sendTransaction({
      to: tokenAddress as `0x${string}`,
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [recipient as `0x${string}`, BigInt(amount)],
      }),
    })

    const confirmed = await waitForEvmReceipt(rpcUrl, txHash)
    if (!confirmed) {
      throw new Error('[relai:withBridge] Direct payment transaction not confirmed')
    }

    return Credential.serialize({
      challenge,
      payload: { type: 'hash', hash: txHash },
      source: `did:pkh:eip155:${sourceChainId}:${evmAccount.address}`,
    })
  }

  // ─── Bridged payment ────────────────────────────────────────────────

  async function bridgedPayment(challenge: any, request: any): Promise<string> {
    const { amount, currency: tokenAddress, recipient, methodDetails } = request
    const targetChainId = methodDetails.chainId

    // 1. Auto-discover bridge info
    const info = await getBridgeInfo(bridgeBaseUrl)

    // Filter out target chain (no self-bridge)
    const targetCaip2 = `eip155:${targetChainId}`
    const availableChains = info.supportedSourceChains.filter((c) => c !== targetCaip2)

    // 2. Select source chain
    const source = selectSourceChain(availableChains, !!evmAccount, !!solanaKeypair, sourceChainId)
    if (!source) {
      throw new Error(
        `[relai:withBridge] No supported source chain for bridge. ` +
        `Available wallets: ${[evmAccount ? sourceCaip2 : null, solanaKeypair ? 'solana' : null].filter(Boolean).join(', ')}, ` +
        `supported: ${availableChains.join(', ')}`,
      )
    }

    const bridgePayTo = info.payTo[source.chain]
    if (!bridgePayTo) {
      throw new Error(`[relai:withBridge] No bridge payTo address for ${source.chain}`)
    }

    // 3. Find source asset
    //    Assets are ordered to match supportedSourceChains by index.
    const sourceChainIndex = info.supportedSourceChains.indexOf(source.chain)
    const sourceAsset =
      (sourceChainIndex >= 0 && info.supportedSourceAssets?.[sourceChainIndex]) ||
      ''
    if (!sourceAsset) {
      throw new Error(`[relai:withBridge] No source asset found for ${source.chain} in bridge info`)
    }

    // The bridge deducts its fee from targetAccept.amount:
    //   netNeeded = amount - (amount * feeBps / 10000)
    // We must gross up the amount so that after fee deduction, the merchant
    // receives at least the requested amount:
    //   grossAmount = ceil(requestedAmount * 10000 / (10000 - feeBps))
    const requestedAmount = BigInt(amount)
    const grossAmount = info.feeBps > 0
      ? (requestedAmount * 10000n + (10000n - BigInt(info.feeBps)) - 1n) / (10000n - BigInt(info.feeBps))
      : requestedAmount

    // The source payment must cover the grossAmount (which the bridge will verify)
    const sourceAmount = grossAmount

    // 5. Execute source chain payment + sign settle message
    let sourceTxHash: string
    let senderAddress: string
    let senderSignature: string

    const settleTargetAccept = {
      scheme: 'exact' as const,
      network: targetCaip2,
      asset: tokenAddress,
      payTo: recipient,
      amount: String(grossAmount),
    }

    if (source.type === 'evm') {
      if (!evmAccount) {
        throw new Error('[relai:withBridge] evmAccount required for EVM source payment')
      }

      // EVM source payment
      const sourceRpc = allRpcUrls[source.chain]
      if (!sourceRpc) {
        throw new Error(
          `[relai:withBridge] No RPC URL for source chain ${source.chain} — ` +
          `provide sourceRpcUrl or rpcUrls in config`,
        )
      }

      const sourceChainIdNum = parseInt(source.chain.replace('eip155:', ''), 10)
      const chain: Chain = {
        id: sourceChainIdNum,
        name: source.chain,
        nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
        rpcUrls: { default: { http: [sourceRpc] } },
      }

      const walletClient = createWalletClient({
        account: evmAccount,
        chain,
        transport: http(sourceRpc),
      })

      sourceTxHash = await walletClient.sendTransaction({
        to: sourceAsset as `0x${string}`,
        data: encodeFunctionData({
          abi: ERC20_TRANSFER_ABI,
          functionName: 'transfer',
          args: [bridgePayTo as `0x${string}`, sourceAmount],
        }),
      })

      const sourceConfirmed = await waitForEvmReceipt(sourceRpc, sourceTxHash)
      if (!sourceConfirmed) {
        throw new Error('[relai:withBridge] Source EVM transaction not confirmed')
      }

      // EVM signature
      const settleMessage = sourceTxHash + JSON.stringify(settleTargetAccept)
      senderAddress = evmAccount.address
      senderSignature = await evmAccount.signMessage!({ message: settleMessage })
    } else {
      // Solana source payment
      if (!solanaKeypair) {
        throw new Error('[relai:withBridge] solanaKeypair required for Solana source payment')
      }

      sourceTxHash = await executeSolanaSourcePayment({
        chain: source.chain,
        tokenMint: sourceAsset,
        bridgePayTo,
        amount: sourceAmount,
        feePayerSvm: info.feePayerSvm ?? undefined,
      })

      // Solana ed25519 signature
      const { Keypair } = await import('@solana/web3.js')
      const naclModule = await import('tweetnacl')
      const nacl = (naclModule as any).default ?? naclModule
      const kp = Keypair.fromSecretKey(solanaKeypair.secretKey)
      senderAddress = kp.publicKey.toBase58()
      const settleMessage = sourceTxHash + JSON.stringify(settleTargetAccept)
      const messageBytes = new TextEncoder().encode(settleMessage)
      const sig = nacl.sign.detached(messageBytes, kp.secretKey)
      const bs58 = await import('bs58')
      senderSignature = bs58.default.encode(sig)
    }

    // 6. Call bridge settle
    const settleData = await settleBridge(info.settleEndpoint, {
      sourceTxHash,
      senderAddress,
      senderSignature,
      sourceChain: source.chain,
      targetAccept: settleTargetAccept,
    })

    // The bridge settle returns either:
    // - A real targetTxId (Solana target or direct execution)
    // - targetTxId="pending" + xPayment (EVM target: pre-signed EIP-3009 authorization)
    //   In this case, we must execute the xPayment via the facilitator to get the real tx hash.
    let targetTxHash = settleData.targetTxId

    if ((!targetTxHash || targetTxHash === 'pending') && settleData.xPayment) {
      // Decode xPayment — it's a standard x402 PaymentPayload (EIP-3009 or SPL transfer)
      // signed by the bridge wallet. We must POST it to the facilitator to execute on-chain.
      const paymentPayload = JSON.parse(
        Buffer.from(settleData.xPayment, 'base64').toString(),
      ) as { facilitatorUrl?: string; accepted?: any; network?: string; [key: string]: any }

      const facilitatorUrl = (
        paymentPayload.facilitatorUrl || info.paymentFacilitator || 'https://facilitator.x402.fi'
      ).replace(/\/$/, '')

      // Build paymentRequirements from the xPayment payload.
      // The amount must match the authorization value (net after bridge fee),
      // NOT the accepted.amount (gross before fee).
      const accepted = paymentPayload.accepted || {}
      const authValue = paymentPayload.payload?.authorization?.value
      const paymentRequirements = {
        network: accepted.network || paymentPayload.network || settleTargetAccept.network,
        asset: accepted.asset || settleTargetAccept.asset,
        payTo: accepted.payTo || settleTargetAccept.payTo,
        amount: authValue || accepted.amount || settleTargetAccept.amount,
      }

      const facilitatorRes = await fetch(`${facilitatorUrl}/settle`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
      })

      if (!facilitatorRes.ok) {
        const err = (await facilitatorRes.json().catch(() => ({}))) as any
        throw new Error(
          `[relai:withBridge] Facilitator settle failed: ${err.error || err.errorReason || facilitatorRes.status}`,
        )
      }

      const facilitatorData = (await facilitatorRes.json()) as {
        transaction?: string
        txHash?: string
        success?: boolean
        errorReason?: string
        error?: string
      }
      if (facilitatorData.success === false) {
        throw new Error(
          `[relai:withBridge] Facilitator settle failed: ${facilitatorData.errorReason || facilitatorData.error || 'unknown'}`,
        )
      }
      targetTxHash = facilitatorData.transaction || facilitatorData.txHash
    }

    if (!targetTxHash || targetTxHash === 'pending') {
      throw new Error('[relai:withBridge] Bridge settle did not return targetTxId')
    }

    // 7. Return credential in evm/charge format
    //    The server's evmCharge verify() checks payload.hash on the target chain.
    //    It sees a real on-chain ERC-20 transfer — no idea bridging happened.
    return Credential.serialize({
      challenge,
      payload: { type: 'hash', hash: targetTxHash },
      source: `did:pkh:${source.chain}:${senderAddress}`,
    })
  }

  // ─── Solana source payment ──────────────────────────────────────────

  async function executeSolanaSourcePayment(opts: {
    chain: string
    tokenMint: string
    bridgePayTo: string
    amount: bigint
    feePayerSvm?: string
  }): Promise<string> {
    if (!solanaKeypair) {
      throw new Error('[relai:withBridge] solanaKeypair required for Solana source payment')
    }

    const { Connection, PublicKey, Keypair, TransactionMessage, VersionedTransaction } =
      await import('@solana/web3.js')
    const { getAssociatedTokenAddress, createTransferCheckedInstruction, getMint, TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } =
      await import('@solana/spl-token')

    const rpcUrl = solanaRpcUrl || 'https://api.mainnet-beta.solana.com'
    const connection = new Connection(rpcUrl, 'confirmed')

    const userKeypair = Keypair.fromSecretKey(solanaKeypair.secretKey)
    const userPubkey = userKeypair.publicKey
    const destinationPubkey = new PublicKey(opts.bridgePayTo)
    const mintPubkey = new PublicKey(opts.tokenMint)

    // Determine token program
    const mintInfo = await getMint(connection, mintPubkey)
    const programId = (mintInfo as any).owner?.toBase58?.() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TOKEN_2022_PROGRAM_ID
      : TOKEN_PROGRAM_ID

    const sourceAta = await getAssociatedTokenAddress(mintPubkey, userPubkey, true, programId)
    const destinationAta = await getAssociatedTokenAddress(mintPubkey, destinationPubkey, true, programId)

    const transferIx = createTransferCheckedInstruction(
      sourceAta,
      mintPubkey,
      destinationAta,
      userPubkey,
      opts.amount,
      mintInfo.decimals,
      [],
      programId,
    )

    // MPP mode: client broadcasts directly, so user must be fee payer
    // (feePayerSvm is only for x402 flow where bridge co-signs before broadcast)
    const payerPubkey = userPubkey

    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }).compileToV0Message()

    const transaction = new VersionedTransaction(message)
    transaction.sign([userKeypair])

    let signature: string
    try {
      signature = await connection.sendTransaction(transaction, {
        skipPreflight: false,
        preflightCommitment: 'confirmed',
      })
    } catch (sendErr: any) {
      const logs = sendErr?.logs || sendErr?.transactionMessage?.logs || []
      console.error(`[relai:withBridge] Solana sendTransaction failed:`, sendErr.message)
      if (logs.length) console.error(`[relai:withBridge] Simulation logs:`, logs.join('\n'))
      throw sendErr
    }

    const confirmation = await connection.confirmTransaction(signature, 'confirmed')
    if (confirmation.value.err) {
      throw new Error(`[relai:withBridge] Solana source transaction failed: ${JSON.stringify(confirmation.value.err)}`)
    }

    return signature
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────

async function waitForEvmReceipt(rpcUrl: string, txHash: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    })
    const data = (await res.json()) as { result?: { status: string } }
    if (data.result) {
      return data.result.status === '0x1'
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  return false
}
