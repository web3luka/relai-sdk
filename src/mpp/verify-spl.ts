/**
 * Shared SPL Token Transfer verification utility for Solana.
 *
 * Used by bridge-server.ts when the target chain is Solana.
 * Verifies that a transaction contains an SPL token transfer
 * to the expected recipient for at least the expected amount.
 */

export interface VerifySplTransferOptions {
  /** Transaction signature (base58) */
  txSignature: string
  /** Solana RPC URL */
  rpcUrl: string
  /** SPL token mint address */
  tokenMint: string
  /** Expected recipient wallet address */
  recipient: string
  /** Minimum expected amount in base units */
  expectedAmount: bigint
}

/**
 * Verify that a Solana transaction contains a valid SPL token transfer
 * to the expected recipient for at least the expected amount.
 *
 * Uses raw JSON-RPC to avoid hard dependency on @solana/web3.js at runtime.
 *
 * @throws if the transaction is missing, failed, or doesn't match.
 */
export async function verifySplTransfer(opts: VerifySplTransferOptions): Promise<void> {
  const { txSignature, rpcUrl, tokenMint, recipient, expectedAmount } = opts

  // Fetch parsed transaction (includes token transfer details)
  const res = await fetch(rpcUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'getTransaction',
      params: [
        txSignature,
        { encoding: 'jsonParsed', commitment: 'confirmed', maxSupportedTransactionVersion: 0 },
      ],
    }),
  })

  const data = (await res.json()) as { result?: any; error?: { message: string } }

  if (data.error) {
    throw new Error(`Solana RPC error: ${data.error.message}`)
  }

  const tx = data.result
  if (!tx) {
    throw new Error('Solana transaction not found or not yet confirmed')
  }

  if (tx.meta?.err) {
    throw new Error(`Solana transaction failed: ${JSON.stringify(tx.meta.err)}`)
  }

  // Look for matching SPL token transfer in inner + outer instructions
  const allInstructions = [
    ...(tx.transaction?.message?.instructions || []),
    ...(tx.meta?.innerInstructions?.flatMap((inner: any) => inner.instructions) || []),
  ]

  const mintLower = tokenMint.toLowerCase()
  const recipientLower = recipient.toLowerCase()

  const matched = allInstructions.some((ix: any) => {
    const parsed = ix.parsed
    if (!parsed) return false

    // SPL Token transfer / transferChecked
    const type = parsed.type
    if (type !== 'transfer' && type !== 'transferChecked') return false

    const info = parsed.info
    if (!info) return false

    // Check mint (transferChecked has .mint, transfer we check via token balances)
    if (type === 'transferChecked') {
      if (info.mint?.toLowerCase() !== mintLower) return false
    }

    // Check amount
    const amount = type === 'transferChecked'
      ? BigInt(info.tokenAmount?.amount || '0')
      : BigInt(info.amount || '0')

    if (amount < expectedAmount) return false

    // Check destination — for SPL, 'destination' is an ATA, not the wallet directly.
    // We need to check postTokenBalances to see if recipient's wallet received tokens.
    return true
  })

  // Also verify via postTokenBalances that recipient received tokens
  const postBalances: any[] = tx.meta?.postTokenBalances || []
  const preBalances: any[] = tx.meta?.preTokenBalances || []

  const recipientPostBalance = postBalances.find(
    (b: any) =>
      b.mint?.toLowerCase() === mintLower &&
      b.owner?.toLowerCase() === recipientLower,
  )

  if (!recipientPostBalance) {
    throw new Error('Recipient not found in post-token balances for the expected mint')
  }

  const recipientPreBalance = preBalances.find(
    (b: any) =>
      b.mint?.toLowerCase() === mintLower &&
      b.owner?.toLowerCase() === recipientLower,
  )

  const postAmount = BigInt(recipientPostBalance.uiTokenAmount?.amount || '0')
  const preAmount = BigInt(recipientPreBalance?.uiTokenAmount?.amount || '0')
  const received = postAmount - preAmount

  if (received < expectedAmount) {
    throw new Error(
      `Insufficient SPL transfer: expected ${expectedAmount}, recipient received ${received}`,
    )
  }
}
