// mcp/src/tools/install.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from '@x402-avm/avm'
import { registerExactAvmScheme } from '@x402-avm/avm/exact/client'
import { x402Client } from '@x402-avm/core/client'
import { decodePaymentResponseHeader } from '@x402-avm/core/http'
import { wrapFetchWithPayment } from '@x402-avm/fetch'
import { signerFromMnemonic } from '../signer.js'

const PROXY_URL = process.env.SPM_PROXY_URL ?? 'http://localhost:4873'

// NETWORK selects Algorand MainNet (default) or TestNet rehearsal.
const NETWORK = (process.env.NETWORK ?? 'mainnet').toLowerCase()
const IS_TESTNET = NETWORK === 'testnet'
const CAIP2_NETWORK = IS_TESTNET ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2
const USDC_ASSET_ID = IS_TESTNET ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID
const EXPLORER_NETWORK = IS_TESTNET ? 'testnet' : 'mainnet'

export type InstallResult = {
  pkg: string
  version: string
  status: 'free' | 'paid'
  tarballPath: string
  txid: string | null
  loraUrl: string | null
}

type DecodedSettleResponse = {
  success: boolean
  transaction: string
}

function isDecodedSettleResponse(value: unknown): value is DecodedSettleResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as { success: unknown }).success === 'boolean' &&
    'transaction' in value &&
    typeof (value as { transaction: unknown }).transaction === 'string'
  )
}

// Reads the settlement txid from the PAYMENT-RESPONSE header the installed
// @x402-avm/hono middleware sets on a paid response (legacy name
// X-PAYMENT-RESPONSE also accepted by @x402-avm/core). A missing header
// means the download was free. A present but malformed or unsuccessful
// header means settlement is unproven — that must never be reported as
// 'free'.
function readSettlementTxid(res: Response): string | null {
  const header = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('X-PAYMENT-RESPONSE')
  if (!header) return null

  let decoded: unknown
  try {
    decoded = decodePaymentResponseHeader(header)
  } catch {
    throw new Error('Install failed: malformed PAYMENT-RESPONSE header')
  }

  if (!isDecodedSettleResponse(decoded) || !decoded.success || !decoded.transaction) {
    throw new Error('Install failed: unsettled PAYMENT-RESPONSE header')
  }

  return decoded.transaction
}

// Env var holding the payer's 25-word Algorand mnemonic.
// WARNING: this value must never be printed or included in an error message.
const PAYER_KEY_ENV = 'PAYER_MNEMONIC'

function readPayerMnemonic(): string {
  const value = process.env[PAYER_KEY_ENV]
  if (!value) throw new Error(`${PAYER_KEY_ENV} env var not set`)
  return value
}

// Builds an x402 client bound to exactly one Algorand network (never the
// 'algorand:*' wildcard), so a payment can only be made on the network NETWORK
// selects.
function buildPaymentClient() {
  const signer = signerFromMnemonic(readPayerMnemonic())
  const client = new x402Client()
  registerExactAvmScheme(client, { signer, networks: [CAIP2_NETWORK] })
  return client
}

export const installTool = {
  name: 'install_audited_package',
  description:
    'Install an npm package via SPM. If COMMUNITY_REVIEWED or higher, autonomously pays ' +
    `$0.001 USDC on Algorand ${IS_TESTNET ? 'TestNet' : 'MainNet'} (asset ${USDC_ASSET_ID}) ` +
    'as a plain asset transfer to the merchant payTo address. Returns tarball path and ' +
    'settlement txid.',

  async handler({ pkg, version }: { pkg: string; version: string }): Promise<InstallResult> {
    const basePkg = pkg.split('/').pop() ?? pkg
    const tarballName = `${basePkg}-${version}.tgz`
    const pkgPath = pkg.startsWith('@') ? pkg.replace('@', '%40').replace('/', '%2F') : pkg
    const url = `${PROXY_URL}/${pkgPath}/-/${tarballName}`

    const client = buildPaymentClient()
    const payFetch = wrapFetchWithPayment(fetch, client)

    // wrapFetchWithPayment retries a 402 exactly once — it never loops. A second
    // 402 (rejected payment) is returned as-is and falls into the !res.ok check below.
    const res = await payFetch(url)
    if (!res.ok) {
      throw new Error(`Install failed: ${res.status}`)
    }

    const txid = readSettlementTxid(res)

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-'))
    const tarballPath = path.join(tmpDir, tarballName)
    fs.writeFileSync(tarballPath, Buffer.from(await res.arrayBuffer()))

    return {
      pkg,
      version,
      status: txid ? 'paid' : 'free',
      tarballPath,
      txid,
      loraUrl: txid ? `https://lora.algokit.io/${EXPLORER_NETWORK}/transaction/${txid}` : null,
    }
  },
}
