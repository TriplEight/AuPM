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

    return { success: true, txid }
  } catch (err) {
    return { success: false, error: String(err) }
  }
}
