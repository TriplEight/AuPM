// mcp/src/tools/install.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { decodePaymentResponseHeader } from '@x402-avm/core/http'
import {
  EXPLORER_NETWORK,
  fetchWithDonation,
  IS_TESTNET,
  PRICE_PER_ENTRY_MICRO,
  USDC_ASSET_ID,
} from '../donor.js'

const PROXY_URL = process.env.SPM_PROXY_URL ?? 'http://localhost:4873'

export type InstallOutcome =
  | {
      status: 'free' | 'paid'
      pkg: string
      version: string
      tarballPath: string
      txid: string | null
      loraUrl: string | null
    }
  | {
      status: 'donation_required'
      pkg: string
      version: string
      priceMicro: number
      resourceUrl: string
      asset: string
    }

export type InstallResult = InstallOutcome

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

export const installTool = {
  name: 'install_audited_package',
  description:
    'Install an npm package via SPM. If COMMUNITY_REVIEWED or higher, this route returns ' +
    `402. Pass allowDonation: true to donate up to ${PRICE_PER_ENTRY_MICRO} microUSDC on ` +
    `Algorand ${IS_TESTNET ? 'TestNet' : 'MainNet'} (asset ${USDC_ASSET_ID}) as a plain ` +
    'asset transfer to the merchant payTo address. Without allowDonation, a 402 is reported ' +
    "back as status: 'donation_required' with the price and resource URL, and nothing is " +
    'signed. Returns tarball path and settlement txid on a paid or free install.',

  async handler({
    pkg,
    version,
    allowDonation = false,
  }: {
    pkg: string
    version: string
    allowDonation?: boolean
  }): Promise<InstallResult> {
    const basePkg = pkg.split('/').pop() ?? pkg
    const tarballName = `${basePkg}-${version}.tgz`
    const pkgPath = pkg.startsWith('@') ? pkg.replace('@', '%40').replace('/', '%2F') : pkg
    const url = `${PROXY_URL}/${pkgPath}/-/${tarballName}`

    const result = await fetchWithDonation(url, undefined, allowDonation)
    if (result.kind === 'donation_required') {
      return {
        status: 'donation_required',
        pkg,
        version,
        priceMicro: result.requirement.priceMicro,
        resourceUrl: result.requirement.resourceUrl,
        asset: result.requirement.asset,
      }
    }

    const res = result.response
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
