/**
 * Bridge MPP client — executes cross-chain payments via the RelAI bridge.
 *
 * When the client doesn't have a wallet on the merchant's target chain,
 * it pays on a supported source chain and the bridge settles on the target.
 *
 * Usage:
 * ```ts
 * import { Mppx } from 'mppx/client'
 * import { bridgeCharge } from '@relai-fi/x402/mpp/bridge-client'
 * import { evmCharge } from '@relai-fi/x402/mpp/evm-client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     evmCharge({ account: skaleAccount }),      // direct if wallet matches
 *     bridgeCharge({ evmAccount: baseAccount }), // bridge from Base otherwise
 *   ],
 *   polyfill: false,
 * })
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
import { charge as BridgeChargeMethod } from './bridge-method.js'

// ERC-20 transfer ABI (same as evm-client.ts)
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

export interface BridgeChargeClientConfig {
  /** viem Account for EVM source chain payments */
  evmAccount?: Account
  /** Solana keypair for Solana source chain payments */
  solanaKeypair?: {
    publicKey: { toBase58(): string }
    secretKey: Uint8Array
  }
  /** Preferred EVM source chain ID — tried first before other EVM chains */
  preferredSourceChainId?: number
  /** Override RPC URLs per source chain (CAIP-2 key): { "eip155:8453": "https://..." } */
  rpcUrls?: Record<string, string>
  /** Override Solana RPC URL (default: https://api.mainnet-beta.solana.com) */
  solanaRpcUrl?: string
}

// Known EVM RPC URLs by CAIP-2 chain ID (fallback if not in challenge or config)
const DEFAULT_EVM_RPC: Record<string, string> = {
  'eip155:8453': 'https://mainnet.base.org',
  'eip155:137': 'https://polygon-rpc.com',
  'eip155:1': 'https://eth.llamarpc.com',
  'eip155:42161': 'https://arb1.arbitrum.io/rpc',
  'eip155:1187947933': 'https://skale-base.skalenodes.com/v1/base',
  'eip155:4217': 'https://rpc.tempo.xyz',
}

export function bridgeCharge(config: BridgeChargeClientConfig) {
  const { evmAccount, solanaKeypair, preferredSourceChainId, rpcUrls, solanaRpcUrl } = config

  return Method.toClient(BridgeChargeMethod, {
    async createCredential({ challenge }) {
      const request = challenge.request as {
        amount: string
        currency: string
        recipient: string
        methodDetails: {
          targetChainId: number
          targetNetwork?: string
          targetRpcUrl?: string
          targetDecimals?: number
          settleEndpoint: string
          supportedSourceChains: string[]
          supportedSourceAssets?: string[]
          payToMap: Record<string, string>
          feePayerSvm?: string
          feeBps?: number
          paymentFacilitator?: string
          reference: string
        }
      }

      const { amount, currency, recipient, methodDetails } = request
      const {
        settleEndpoint,
        supportedSourceChains,
        supportedSourceAssets,
        payToMap,
        feePayerSvm,
        feeBps,
        paymentFacilitator,
        reference,
        targetChainId,
        targetNetwork,
      } = methodDetails

      // Select source chain based on available wallets
      const source = selectSourceChain(supportedSourceChains, supportedSourceAssets || [])
      if (!source) {
        throw new Error(
          `[relai:bridge-mpp] No wallet matches supported source chains: ${supportedSourceChains.join(', ')}`,
        )
      }

      const bridgePayTo = payToMap[source.chain]
      if (!bridgePayTo) {
        throw new Error(`[relai:bridge-mpp] No bridge payTo address for source chain ${source.chain}`)
      }

      // The bridge deducts its fee from targetAccept.amount:
      //   netNeeded = amount - (amount * feeBps / 10000)
      // We must gross up so that after fee, the merchant receives the full amount.
      const requestedAmount = BigInt(amount)
      const grossAmount = feeBps && feeBps > 0
        ? (requestedAmount * 10000n + (10000n - BigInt(feeBps)) - 1n) / (10000n - BigInt(feeBps))
        : requestedAmount
      const sourceAmount = grossAmount

      // Execute source payment
      let sourceTxHash: string

      if (source.type === 'evm') {
        sourceTxHash = await executeEvmSourcePayment({
          chain: source.chain,
          tokenAddress: source.asset,
          bridgePayTo,
          amount: sourceAmount,
        })
      } else {
        sourceTxHash = await executeSolanaSourcePayment({
          chain: source.chain,
          tokenMint: source.asset,
          bridgePayTo,
          amount: sourceAmount,
          feePayerSvm,
        })
      }

      // Call bridge settle endpoint with wallet signature
      // The client signs (sourceTxHash + JSON(targetAccept)) to prove ownership
      // of the wallet that sent the source tx. No shared secret needed.
      // Use targetNetwork from challenge if available (supports Solana targets),
      // otherwise construct from chainId (EVM targets)
      const settleTargetAccept = {
        scheme: 'exact' as const,
        network: targetNetwork || `eip155:${targetChainId}`,
        asset: currency,
        payTo: recipient,
        amount: String(grossAmount),
      }
      const settleMessage = sourceTxHash + JSON.stringify(settleTargetAccept)

      let senderAddress: string
      let senderSignature: string

      if (source.type === 'evm') {
        senderAddress = evmAccount!.address
        senderSignature = await evmAccount!.signMessage!({ message: settleMessage })
      } else {
        // Solana: sign with ed25519 keypair, encode as base58
        const { Keypair } = await import('@solana/web3.js')
        const nacl = await import('tweetnacl')
        const kp = Keypair.fromSecretKey(solanaKeypair!.secretKey)
        senderAddress = kp.publicKey.toBase58()
        const messageBytes = new TextEncoder().encode(settleMessage)
        const sig = nacl.sign.detached(messageBytes, kp.secretKey)
        const bs58 = await import('bs58')
        senderSignature = bs58.default.encode(sig)
      }

      const settleRes = await fetch(settleEndpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sourceTxHash,
          senderAddress,
          senderSignature,
          sourceChain: source.chain,
          targetAccept: settleTargetAccept,
        }),
      })

      if (!settleRes.ok) {
        const err = await settleRes.json().catch(() => ({})) as any
        throw new Error(`[relai:bridge-mpp] Bridge settle failed: ${err.error || settleRes.status}`)
      }

      const settleData = await settleRes.json() as {
        success?: boolean
        targetTxId?: string
        sourceTxId?: string
        xPayment?: string
      }

      // The bridge settle returns either:
      // - A real targetTxId (Solana target or direct execution)
      // - targetTxId="pending" + xPayment (EVM target: pre-signed authorization)
      //   We must execute xPayment via the facilitator to get the real tx hash.
      let targetTxHash = settleData.targetTxId

      if ((!targetTxHash || targetTxHash === 'pending') && settleData.xPayment) {
        // Decode xPayment — it's a standard x402 PaymentPayload
        const paymentPayload = JSON.parse(
          Buffer.from(settleData.xPayment, 'base64').toString(),
        ) as { facilitatorUrl?: string; accepted?: any; network?: string; payload?: any; [key: string]: any }

        const isSolanaTarget = (paymentPayload.network || '').startsWith('solana:')

        if (isSolanaTarget && paymentPayload.payload?.transaction) {
          // Solana target: the bridge already signed the SPL transfer.
          // Broadcast directly — the facilitator would reject due to fee_payer_isolation.
          const { Connection, VersionedTransaction } = await import('@solana/web3.js')
          const solRpc = solanaRpcUrl || 'https://api.mainnet-beta.solana.com'
          const connection = new Connection(solRpc, 'confirmed')
          const txBuf = Buffer.from(paymentPayload.payload.transaction, 'base64')
          const tx = VersionedTransaction.deserialize(txBuf)
          const sig = await connection.sendRawTransaction(tx.serialize(), {
            skipPreflight: false,
            preflightCommitment: 'confirmed',
          })
          await connection.confirmTransaction(sig, 'confirmed')
          targetTxHash = sig
        } else {
          // EVM target: POST to facilitator to execute the EIP-3009 authorization on-chain.
          const facilitatorUrl = (
            paymentPayload.facilitatorUrl || paymentFacilitator || 'https://facilitator.x402.fi'
          ).replace(/\/$/, '')

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
            const err = await facilitatorRes.json().catch(() => ({})) as any
            throw new Error(
              `[relai:bridge-mpp] Facilitator settle failed: ${err.error || err.errorReason || facilitatorRes.status}`,
            )
          }

          const facilitatorData = await facilitatorRes.json() as {
            transaction?: string
            txHash?: string
            success?: boolean
          }
          targetTxHash = facilitatorData.transaction || facilitatorData.txHash
        }
      }

      if (!targetTxHash || targetTxHash === 'pending') {
        throw new Error('[relai:bridge-mpp] Bridge settle did not return targetTxId')
      }

      // Return credential with bridge proof
      return Credential.serialize({
        challenge,
        payload: {
          type: 'settled',
          targetTxHash,
          sourceTxHash,
          sourceChain: source.chain,
        },
        source: source.type === 'evm'
          ? `did:pkh:${source.chain}:${evmAccount!.address}`
          : `did:pkh:${source.chain}:${solanaKeypair!.publicKey.toBase58()}`,
      })
    },
  })

  // ─── Source chain selection ─────────────────────────────────────────

  function selectSourceChain(
    supportedChains: string[],
    supportedAssets: string[],
  ): { type: 'evm' | 'solana'; chain: string; asset: string } | null {
    // Prioritize Solana if configured (better UX, lower fees)
    if (solanaKeypair) {
      const solIdx = supportedChains.findIndex((c) => c.startsWith('solana:'))
      if (solIdx >= 0) {
        const solAsset = supportedAssets[solIdx] || supportedAssets.find((a) => !a.startsWith('0x')) || ''
        return { type: 'solana', chain: supportedChains[solIdx], asset: solAsset }
      }
    }

    // Then try EVM — preferred chain first, then any
    if (evmAccount) {
      if (preferredSourceChainId) {
        const preferred = `eip155:${preferredSourceChainId}`
        const prefIdx = supportedChains.indexOf(preferred)
        if (prefIdx >= 0) {
          const evmAsset = supportedAssets[prefIdx] || supportedAssets.find((a) => a.startsWith('0x')) || ''
          return { type: 'evm', chain: preferred, asset: evmAsset }
        }
      }
      for (let i = 0; i < supportedChains.length; i++) {
        if (supportedChains[i].startsWith('eip155:')) {
          const evmAsset = supportedAssets[i] || supportedAssets.find((a) => a.startsWith('0x')) || ''
          return { type: 'evm', chain: supportedChains[i], asset: evmAsset }
        }
      }
    }

    return null
  }

  // ─── EVM source payment ─────────────────────────────────────────────

  async function executeEvmSourcePayment(opts: {
    chain: string
    tokenAddress: string
    bridgePayTo: string
    amount: bigint
  }): Promise<string> {
    if (!evmAccount) {
      throw new Error('[relai:bridge-mpp] evmAccount required for EVM source payment')
    }

    const chainIdStr = opts.chain.replace('eip155:', '')
    const chainId = parseInt(chainIdStr, 10)
    const rpcUrl = rpcUrls?.[opts.chain] || DEFAULT_EVM_RPC[opts.chain]

    if (!rpcUrl) {
      throw new Error(`[relai:bridge-mpp] No RPC URL for source chain ${opts.chain} — provide rpcUrls in config`)
    }

    const chain: Chain = {
      id: chainId,
      name: opts.chain,
      nativeCurrency: { name: 'ETH', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpcUrl] } },
    }

    const walletClient = createWalletClient({
      account: evmAccount,
      chain,
      transport: http(rpcUrl),
    })

    const txHash = await walletClient.sendTransaction({
      to: opts.tokenAddress as `0x${string}`,
      data: encodeFunctionData({
        abi: ERC20_TRANSFER_ABI,
        functionName: 'transfer',
        args: [opts.bridgePayTo as `0x${string}`, opts.amount],
      }),
    })

    // Wait for confirmation
    const confirmed = await waitForEvmReceipt(rpcUrl, txHash)
    if (!confirmed) {
      throw new Error('[relai:bridge-mpp] Source EVM transaction not confirmed within timeout')
    }

    return txHash
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
      throw new Error('[relai:bridge-mpp] solanaKeypair required for Solana source payment')
    }

    // Dynamic import to avoid bundling Solana deps when not used
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

    // Use feePayer if available, otherwise user pays gas
    const payerPubkey = opts.feePayerSvm
      ? new PublicKey(opts.feePayerSvm)
      : userPubkey

    const { blockhash } = await connection.getLatestBlockhash('confirmed')
    const message = new TransactionMessage({
      payerKey: payerPubkey,
      recentBlockhash: blockhash,
      instructions: [transferIx],
    }).compileToV0Message()

    const transaction = new VersionedTransaction(message)
    transaction.sign([userKeypair])

    // Send and confirm
    const signature = await connection.sendTransaction(transaction, {
      skipPreflight: false,
      preflightCommitment: 'confirmed',
    })

    // Wait for confirmation
    const confirmation = await connection.confirmTransaction(signature, 'confirmed')
    if (confirmation.value.err) {
      throw new Error(`[relai:bridge-mpp] Solana source transaction failed: ${JSON.stringify(confirmation.value.err)}`)
    }

    return signature
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────

async function waitForEvmReceipt(rpcUrl: string, txHash: string, timeoutMs = 30000): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    })
    const data = await res.json() as { result?: { status: string } }
    if (data.result) {
      return data.result.status === '0x1'
    }
    await new Promise(r => setTimeout(r, 1000))
  }
  return false
}
