/**
 * Shared ERC-20 Transfer verification utility.
 *
 * Used by both evm-server.ts (direct payments) and bridge-server.ts
 * (bridged payments on the target chain).
 */

const TRANSFER_EVENT_TOPIC = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'

export interface VerifyErc20TransferOptions {
  /** Transaction hash (0x-prefixed) */
  txHash: string
  /** RPC URL for the chain */
  rpcUrl: string
  /** ERC-20 token contract address */
  tokenAddress: string
  /** Expected recipient address */
  recipient: string
  /** Minimum expected amount in base units */
  expectedAmount: bigint
}

/**
 * Verify that an on-chain transaction contains a valid ERC-20 Transfer event
 * to the expected recipient for at least the expected amount.
 *
 * @throws if the transaction is missing, failed, or doesn't match.
 */
export async function verifyErc20Transfer(opts: VerifyErc20TransferOptions): Promise<void> {
  const { txHash, rpcUrl, tokenAddress, recipient, expectedAmount } = opts

  // Poll for receipt — the transaction may take a few seconds to be indexed by the RPC node
  let receipt: any = null
  for (let attempt = 0; attempt < 5; attempt++) {
    const receiptRes = await fetch(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0', id: 1,
        method: 'eth_getTransactionReceipt',
        params: [txHash],
      }),
    })
    const receiptData = await receiptRes.json() as { result?: any; error?: { message: string } }

    if (receiptData.error) {
      throw new Error(`RPC error: ${receiptData.error.message}`)
    }

    receipt = receiptData.result
    if (receipt) break
    // Wait before retrying (1s, 2s, 3s, 4s)
    await new Promise((r) => setTimeout(r, (attempt + 1) * 1000))
  }

  if (!receipt) {
    throw new Error('Transaction not found or not yet confirmed')
  }
  if (receipt.status !== '0x1') {
    throw new Error('Transaction failed on-chain')
  }

  // Verify ERC-20 Transfer event
  const recipientPadded = '0x' + recipient.slice(2).toLowerCase().padStart(64, '0')
  const tokenLower = tokenAddress.toLowerCase()

  const matchingLog = (receipt.logs as any[]).find((log: any) => {
    if (log.address.toLowerCase() !== tokenLower) return false
    if (log.topics[0] !== TRANSFER_EVENT_TOPIC) return false
    if (log.topics[2]?.toLowerCase() !== recipientPadded) return false
    return BigInt(log.data) >= expectedAmount
  })

  if (!matchingLog) {
    throw new Error('No matching ERC-20 Transfer found for recipient and amount')
  }
}
