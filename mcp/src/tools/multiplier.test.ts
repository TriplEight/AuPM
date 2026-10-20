import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } from '@x402-avm/avm'
import { encodePaymentResponseHeader } from '@x402-avm/core/http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../config.js'
import { attestLockfileTool } from './attest.js'
import { installTool } from './install.js'

// Test mnemonic: a fresh throwaway account, never funded.
const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'
const PAY_TO = 'J6DSQYYXYO53B7PC6MZ5M2OO7V3RM4MIWTV7KCH5IQBUXF7KMGPVFWIRAM'
const FEE_PAYER = 'EA4DXI4WJWSSJQAAKG5ZFNVA6U26NT7DBWHUKP5C3HSVKBAQ3KGPKVEN5A'
const DEFAULT_LABEL = 'x1 (default)'

function algodParamsResponse(): Response {
  return new Response(
    JSON.stringify({
      'consensus-version': 'https://github.com/algorandfoundation/specs/tree/abc123',
      fee: 0,
      'genesis-hash': Buffer.alloc(32, 0x12).toString('base64'),
      'genesis-id': 'mainnet-v1.0',
      'last-round': 1000,
      'min-fee': 1000,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

function unpaid402(amount: number): Response {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: 'http://localhost:4873/resource' },
    accepts: [
      {
        scheme: 'exact',
        network: ALGORAND_MAINNET_CAIP2,
        asset: USDC_MAINNET_ASA_ID,
        amount: String(amount),
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: { asset: USDC_MAINNET_ASA_ID, feePayer: FEE_PAYER, tag: 'x402-global-challenge' },
      },
    ],
  }
  return new Response(null, {
    status: 402,
    headers: {
      'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
    },
  })
}

describe('donor multiplier in the MCP tools', () => {
  let dir: string
  let lockfilePath: string
  let multiplierHeaders: (string | null)[]
  let fetchMock: ReturnType<typeof vi.fn>

  // The server prices from the multiplier header. The stub does the same: tenths x 1,000.
  function stubServer(body: () => BodyInit): void {
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.includes('/v2/transactions/params')) return algodParamsResponse()
      multiplierHeaders.push(request.headers.get('X-AuPM-Multiplier'))
      const tenths = Number(request.headers.get('X-AuPM-Multiplier') ?? '1')
      if (!request.headers.get('PAYMENT-SIGNATURE')) return unpaid402(1_000 * tenths)
      return new Response(body(), {
        status: 200,
        headers: {
          'PAYMENT-RESPONSE': encodePaymentResponseHeader({
            success: true,
            transaction: 'txid-multiplier',
            network: ALGORAND_MAINNET_CAIP2,
          }),
        },
      })
    })
    vi.stubGlobal('fetch', fetchMock)
  }

  function writeConfig(text: string): void {
    fs.mkdirSync(path.join(dir, 'aupm'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'aupm', 'config.toml'), text)
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-multiplier-test-'))
    lockfilePath = path.join(dir, 'package-lock.json')
    fs.writeFileSync(
      lockfilePath,
      JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/ms': { version: '2.1.3' } } }),
    )
    multiplierHeaders = []
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('AUPM_DONATE', '')
    vi.stubEnv('AUPM_MULTIPLIER', '')
    vi.stubEnv('AUPM_PROXY_URL', 'http://localhost:4873')
    vi.stubEnv('AUPM_DONOR_MNEMONIC', TEST_MNEMONIC)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function install() {
    return await installTool.handler({ pkg: 'lodash', version: '4.17.21', allowDonation: true })
  }

  async function attest() {
    return await attestLockfileTool.handler({ lockfilePath, allowDonation: true })
  }

  it('with no multiplier set, sends tenths 10, pays x1 and the receipt says default', async () => {
    stubServer(() => new Uint8Array([1]))
    const result = await install()
    expect(multiplierHeaders).toEqual(['10', '10'])
    if (result.status !== 'paid') throw new Error(`unexpected ${result.status}`)
    expect(result.receipt).toEqual({
      baseMicro: 10_000,
      multiplier: DEFAULT_LABEL,
      totalMicro: 10_000,
    })
  })

  it.each([
    ['0.1', '1', 'x0.1', 1_000],
    ['1', '10', 'x1', 10_000],
    ['100', '1000', 'x100', 1_000_000],
  ])(
    'multiplier %s sends tenths %s and the receipt shows %s',
    async (setting, tenths, label, total) => {
      writeConfig(`multiplier = "${setting}"\n`)
      stubServer(() => new Uint8Array([1]))
      const result = await install()
      expect(multiplierHeaders).toEqual([tenths, tenths])
      if (result.status !== 'paid') throw new Error(`unexpected ${result.status}`)
      expect(result.receipt).toEqual({ baseMicro: 10_000, multiplier: label, totalMicro: total })
    },
  )

  it('the attest tool sends the multiplier and returns the receipt', async () => {
    vi.stubEnv('AUPM_MULTIPLIER', '2.5')
    stubServer(() => JSON.stringify({ summary: {}, attestation: {} }))
    const result = await attest()
    expect(multiplierHeaders).toEqual(['25', '25'])
    if (result.status !== 'attested') throw new Error(`unexpected ${result.status}`)
    expect(result.receipt).toEqual({ baseMicro: 10_000, multiplier: 'x2.5', totalMicro: 25_000 })
  })

  it('a 402 above the multiplied cap is refused: the donation fails and nothing is paid', async () => {
    writeConfig('multiplier = "1"\n')
    fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(input, init)
      if (request.url.includes('/v2/transactions/params')) return algodParamsResponse()
      if (request.headers.get('PAYMENT-SIGNATURE')) throw new Error('must never sign above the cap')
      if (request.headers.get('X-AuPM-Donate') === '0') return new Response(new Uint8Array([1]))
      return unpaid402(10_001)
    })
    vi.stubGlobal('fetch', fetchMock)
    const result = await install()
    if (result.status !== 'free') throw new Error(`unexpected ${result.status}`)
    expect(result.txid).toBeNull()
    expect(result.donationFailure).toBeDefined()
  })

  it.each(['0', '0.05', '1.25', '101', '-1', 'abc'])(
    'a bad multiplier %j in the env var fails both tools with the range before any request',
    async (value) => {
      vi.stubEnv('AUPM_MULTIPLIER', value)
      stubServer(() => new Uint8Array([1]))
      await expect(install()).rejects.toThrow(ConfigError)
      await expect(install()).rejects.toThrow('from 0.1 to 100')
      await expect(attest()).rejects.toThrow('from 0.1 to 100')
      expect(fetchMock).not.toHaveBeenCalled()
    },
  )

  it('a bad multiplier in the config file fails the call before any request', async () => {
    writeConfig('multiplier = "1.25"\n')
    stubServer(() => new Uint8Array([1]))
    await expect(install()).rejects.toThrow('config.toml:1:')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('the tool descriptions state the default, the minimum and the maximum price', () => {
    for (const description of [installTool.description, attestLockfileTool.description]) {
      expect(description).toContain('default is x1 ($0.01)')
      expect(description).toContain('minimum is x0.1 ($0.001)')
      expect(description).toContain('maximum is x100')
    }
  })
})
