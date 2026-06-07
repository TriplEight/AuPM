// mcp/src/tools/install.ts
import algosdk from 'algosdk'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { signerFromMnemonic } from '../signer.js'

const PROXY_URL = process.env['SPM_PROXY_URL'] ?? 'http://localhost:4873'

type PaymentAccept = {
  scheme: string
  network: string
  payTo: string
  asset: string
  maxAmountRequired: string
  maxTimeoutSeconds: number
  extra?: { appMethod?: string; args?: string[] }
}

type PaymentRequirements = {
  x402Version: number
  accepts: PaymentAccept[]
}

export type InstallResult = {
  pkg: string
  version: string
  status: 'free' | 'paid'
  tarballPath: string
  txid: string | null
  loraUrl: string | null
}

async function fetchRecipients(
  algod: algosdk.Algodv2,
  appId: number,
): Promise<string[]> {
  const appInfo = await algod.getApplicationByID(appId).do()
  const gs: Array<{ key: string; value: { type: number; bytes: string; uint: bigint } }> =
    (appInfo.params?.globalState as never) ?? []
  const keyToAddr: Record<string, string> = {}
  for (const entry of gs) {
    const key = Buffer.from(entry.key, 'base64').toString()
    if (entry.value.type === 1) {
      keyToAddr[key] = algosdk.encodeAddress(Buffer.from(entry.value.bytes, 'base64'))
    }
  }
  // Return in split order: auditor, maintainer, adversarial, treasury, ops
  return ['aud', 'mnt', 'adv', 'tre', 'ops']
    .map((k) => keyToAddr[k])
    .filter(Boolean)
}

async function buildPaymentHeader(requirements: PaymentRequirements): Promise<string> {
  const mnemonic = process.env['PAYER_MNEMONIC']
  if (!mnemonic) throw new Error('PAYER_MNEMONIC env var not set')
  const appId = Number(process.env['SPLIT_APP_ID'])
  if (!appId) throw new Error('SPLIT_APP_ID env var not set')

  const accepted = requirements.accepts[0]
  if (!accepted) throw new Error('No accepted payment scheme in 402 response')

  const { account, signer } = signerFromMnemonic(mnemonic)
  const algod = new algosdk.Algodv2(
    process.env['ALGOD_TOKEN'] ?? '',
    process.env['ALGOD_SERVER'] ?? 'https://testnet-api.algonode.cloud',
    process.env['ALGOD_PORT'] ?? '443',
  )

  const sp = await algod.getTransactionParams().do()
  const assetId = Number(accepted.asset)
  const amount = BigInt(accepted.maxAmountRequired)
  const args = accepted.extra?.args ?? []
  const pkg = args[0] ?? ''
  const ver = args[1] ?? ''

  // Fetch recipient addresses from app global state so inner txns can reach them
  const recipients = await fetchRecipients(algod, appId)

  // Txn 0: USDC asset transfer to SplitRouter app (fee pooled — inner txns covered by appcall)
  const axfer = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr.toString(),
    receiver: accepted.payTo,
    amount,
    assetIndex: assetId,
    suggestedParams: { ...sp, fee: 0n, flatFee: true },
  })

  // Txn 1: ARC-4 appcall pay(axfer, pkg, ver)
  const payMethod = new algosdk.ABIMethod({
    name: 'pay',
    args: [
      { type: 'axfer', name: 'payment' },
      { type: 'string', name: 'pkg' },
      { type: 'string', name: 'ver' },
    ],
    returns: { type: 'void' },
  })

  const atc = new algosdk.AtomicTransactionComposer()
  atc.addMethodCall({
    appID: appId,
    method: payMethod,
    // For 'axfer' typed arg: pass the transaction + signer as a TransactionWithSigner
    methodArgs: [{ txn: axfer, signer }, pkg, ver],
    sender: account.addr.toString(),
    suggestedParams: {
      ...sp,
      fee: BigInt(7000), // covers 5 inner txn fees via pooling
      flatFee: true,
    },
    // All 5 split recipients must be in appAccounts so the AVM can execute inner transfers.
    // The asset must also be in appForeignAssets so the inner-txn holdings are available.
    appAccounts: recipients,
    appForeignAssets: [assetId],
    signer,
  })

  // Build + sign the group
  await atc.buildGroup()
  const signedTxns = await atc.gatherSignatures()

  const payload = {
    payload: {
      signedTransactions: signedTxns.map((t) =>
        Buffer.from(t as Uint8Array).toString('base64'),
      ),
    },
  }
  return Buffer.from(JSON.stringify(payload)).toString('base64')
}

export const installTool = {
  name: 'install_audited_package',
  description:
    'Install an npm package via SPM. If COMMUNITY_REVIEWED or higher, autonomously pays ' +
    '$0.001 USDC on Algorand TestNet. Returns tarball path and settlement txid.',

  async handler({ pkg, version }: { pkg: string; version: string }): Promise<InstallResult> {
    const basePkg = pkg.split('/').pop() ?? pkg
    const tarballName = `${basePkg}-${version}.tgz`
    const pkgPath = pkg.startsWith('@')
      ? pkg.replace('@', '%40').replace('/', '%2F')
      : pkg
    const url = `${PROXY_URL}/${pkgPath}/-/${tarballName}`

    let res = await fetch(url)
    let txid: string | null = null

    if (res.status === 402) {
      const requirements = (await res.json()) as PaymentRequirements
      const paymentHeader = await buildPaymentHeader(requirements)
      res = await fetch(url, { headers: { 'PAYMENT-SIGNATURE': paymentHeader } })
      if (!res.ok) {
        throw new Error(`Payment rejected: ${res.status} — ${await res.text()}`)
      }
      txid = res.headers.get('X-AUDIT-ATTESTATION')
    } else if (!res.ok) {
      throw new Error(`Install failed: ${res.status}`)
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-'))
    const tarballPath = path.join(tmpDir, tarballName)
    fs.writeFileSync(tarballPath, Buffer.from(await res.arrayBuffer()))

    return {
      pkg,
      version,
      status: txid ? 'paid' : 'free',
      tarballPath,
      txid,
      loraUrl: txid ? `https://lora.algokit.io/testnet/transaction/${txid}` : null,
    }
  },
}
