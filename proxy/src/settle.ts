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

export async function settle(paymentHeader: string): Promise<SettlementResult> {
  try {
    // PAYMENT-SIGNATURE header is base64-encoded JSON with the signed txn group
    const decoded = JSON.parse(
      Buffer.from(paymentHeader, 'base64').toString('utf8'),
    ) as { payload: { signedTransactions: string[] } }

    const rawTxns = decoded.payload.signedTransactions.map(
      (t) => Buffer.from(t, 'base64') as unknown as Uint8Array,
    )

    const { txid } = (await algod.sendRawTransaction(rawTxns).do()) as { txid: string }
    await algosdk.waitForConfirmation(algod, txid, 6)

    // Return the appcall txid (last txn in group) — it holds the inner transfers.
    // sendRawTransaction returns the first txn's txid (the axfer).
    const lastRaw = rawTxns[rawTxns.length - 1]!
    const lastStxn = algosdk.decodeSignedTransaction(lastRaw)
    const appCallTxid = (lastStxn.txn as algosdk.Transaction).txID()

    return { success: true, txid: appCallTxid }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
