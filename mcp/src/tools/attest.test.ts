import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } from '@x402-avm/avm'
import { encodePaymentResponseHeader } from '@x402-avm/core/http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attestLockfileTool } from './attest.js'

const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'

const PAY_TO = 'J6DSQYYXYO53B7PC6MZ5M2OO7V3RM4MIWTV7KCH5IQBUXF7KMGPVFWIRAM'
const FEE_PAYER = 'EA4DXI4WJWSSJQAAKG5ZFNVA6U26NT7DBWHUKP5C3HSVKBAQ3KGPKVEN5A'
const RESOURCE_URL = 'http://localhost:4873/v1/attest/lockfile'
const LOCKFILE_PRICE = '20000'

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

function paymentRequiredHeader(): string {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [
      {
        scheme: 'exact',
        network: ALGORAND_MAINNET_CAIP2,
        asset: USDC_MAINNET_ASA_ID,
        amount: LOCKFILE_PRICE,
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: {
          asset: USDC_MAINNET_ASA_ID,
          feePayer: FEE_PAYER,
          tag: 'x402-global-challenge',
        },
      },
    ],
  }
  return Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function settleResponseHeader(transaction: string): string {
  return encodePaymentResponseHeader({
    success: true,
    transaction,
    network: ALGORAND_MAINNET_CAIP2,
  })
}

function writeLockfile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-attest-test-'))
  const lockfilePath = path.join(dir, 'package-lock.json')
  fs.writeFileSync(
    lockfilePath,
    JSON.stringify({ lockfileVersion: 3, packages: { 'node_modules/ms': { version: '2.1.3' } } }),
  )
  return lockfilePath
}

describe('attest_lockfile', () => {
  let lockfilePath: string

  beforeEach(() => {
    lockfilePath = writeLockfile()
    process.env.SPM_DONOR_MNEMONIC = TEST_MNEMONIC
    process.env.SPM_PROXY_URL = 'http://localhost:4873'
    delete process.env.NETWORK
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SPM_DONOR_MNEMONIC
    delete process.env.SPM_PROXY_URL
    delete process.env.NETWORK
    fs.rmSync(path.dirname(lockfilePath), { recursive: true, force: true })
  })

  it('without allowDonation, a 402 never signs and reports donation_required', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
        }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath })

    expect(result.status).toBe('donation_required')
    if (result.status !== 'donation_required') throw new Error('unreachable')
    expect(result.priceMicro).toBe(20_000)
    expect(result.resourceUrl).toBe(RESOURCE_URL)
    expect(result.asset).toBe(USDC_MAINNET_ASA_ID)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('with allowDonation, POSTs the raw lockfile bytes and pays exactly one retry', async () => {
    let capturedBody: string | null = null
    let paidRequestCount = 0

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()

      const request = input instanceof Request ? input : new Request(url, init)
      const paymentSignature = request.headers.get('PAYMENT-SIGNATURE')
      if (!paymentSignature) {
        capturedBody = await request.clone().text()
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
        })
      }

      paidRequestCount += 1
      return new Response(
        JSON.stringify({
          summary: { total: 1, reviewed: 1, unreviewed: 0, unresolvable: 0, integrityMismatch: 0 },
          attestation: { payloadType: 'application/vnd.in-toto+json' },
        }),
        { status: 200, headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-lockfile-ok') } },
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath, allowDonation: true })

    expect(result.status).toBe('attested')
    if (result.status !== 'attested') throw new Error('unreachable')
    expect(result.summary).toMatchObject({ reviewed: 1 })
    expect(paidRequestCount).toBe(1)
    expect(capturedBody).toContain('node_modules/ms')

    const resourceCalls = mockFetch.mock.calls.filter(
      ([input]) => !requestUrl(input as RequestInfo | URL).includes('/v2/transactions/params'),
    )
    expect(resourceCalls).toHaveLength(2)
  })

  it('a zero-coverage 200 succeeds without SPM_DONOR_MNEMONIC set', async () => {
    delete process.env.SPM_DONOR_MNEMONIC
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: {
              total: 1,
              reviewed: 0,
              unreviewed: 1,
              unresolvable: 0,
              integrityMismatch: 0,
            },
            attestation: { payloadType: 'application/vnd.in-toto+json' },
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath, allowDonation: true })

    expect(result.status).toBe('attested')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
