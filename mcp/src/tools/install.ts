// mcp/src/tools/install.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  EXPLORER_NETWORK,
  fetchWithDonation,
  IS_TESTNET,
  PRICE_PER_ENTRY_MICRO,
  USDC_ASSET_ID,
} from '../donor.js'
import { formatMicroUsd } from '../money.js'
import { proxyUrl } from '../proxy-url.js'

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

export const installTool = {
  name: 'install_audited_package',
  description:
    'Install an npm package via AuPM. If COMMUNITY_REVIEWED or higher, this route returns ' +
    `402. Pass allowDonation: true to donate up to ${formatMicroUsd(PRICE_PER_ENTRY_MICRO)} ` +
    `in USDC on Algorand ${IS_TESTNET ? 'TestNet' : 'MainNet'} (asset ${USDC_ASSET_ID}) as a ` +
    'plain asset transfer to the merchant payTo address. Without allowDonation, a 402 is reported ' +
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
    const url = `${proxyUrl()}/${pkgPath}/-/${tarballName}`

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

    const txid = result.settlement?.txid ?? null

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-'))
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
