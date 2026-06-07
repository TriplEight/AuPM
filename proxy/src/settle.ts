// proxy/src/settle.ts
import algosdk from 'algosdk'

export type SettlementResult =
  | { success: true; txid: string }
  | { success: false; error: string }

const algod = new algosdk.Algodv2(
  process.env['ALGOD_TOKEN'] ?? '',
  process.env['ALGOD_SERVER'] ?? 'https://testnet-api.algonode.cloud',
  process.env['ALGOD_PORT'] ?? '443',
)

type BridgeProof = {
  x402Version: number
  scheme: string
  network: string
  payload: { transactionCode: string; payTo: string; asset: string }
}

async function settleUsdc(decoded: {
  payload: { signedTransactions: string[] }
}): Promise<SettlementResult> {
  const rawTxns = decoded.payload.signedTransactions.map(
    (t) => Buffer.from(t, 'base64') as unknown as Uint8Array,
  )
  const { txid } = (await algod.sendRawTransaction(rawTxns).do()) as { txid: string }
  await algosdk.waitForConfirmation(algod, txid, 6)
  const lastRaw = rawTxns[rawTxns.length - 1]!
  const lastStxn = algosdk.decodeSignedTransaction(lastRaw)
  const appCallTxid = (lastStxn.txn as algosdk.Transaction).txID()
  return { success: true, txid: appCallTxid }
}

function settleEurdBridge(proof: BridgeProof): SettlementResult {
  // Quantoz bridge proof — EURD was sent on-chain asynchronously by Quantoz.
  // transactionCode (e.g. "QP20260602151925BHY") is the settlement reference.
  const { transactionCode } = proof.payload
  if (!transactionCode) {
    return { success: false, error: 'Missing transactionCode in EURD bridge proof' }
  }
  return { success: true, txid: transactionCode }
}

export async function settle(paymentHeader: string): Promise<SettlementResult> {
  try {
    // Try USDC path: base64 JSON with signedTransactions
    try {
      const decoded = JSON.parse(Buffer.from(paymentHeader, 'base64').toString('utf8')) as Record<
        string,
        unknown
      >
      if (
        decoded?.payload &&
        typeof decoded.payload === 'object' &&
        'signedTransactions' in decoded.payload
      ) {
        return await settleUsdc(decoded as { payload: { signedTransactions: string[] } })
      }
    } catch {
      // not base64 USDC — fall through to EURD
    }

    // Try EURD bridge path: base64url JSON with scheme/network/payload.transactionCode
    const bridgeDecoded = JSON.parse(
      Buffer.from(paymentHeader, 'base64url').toString('utf8'),
    ) as BridgeProof
    if (
      bridgeDecoded?.scheme === 'exact' &&
      bridgeDecoded?.network === 'algorand:mainnet' &&
      bridgeDecoded?.payload?.transactionCode
    ) {
      return settleEurdBridge(bridgeDecoded)
    }

    return { success: false, error: 'Unrecognized payment proof format' }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
