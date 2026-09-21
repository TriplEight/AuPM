// mcp/src/donor.test.ts
import { Buffer } from 'node:buffer'
import {
  ALGORAND_MAINNET_CAIP2,
  decodeSignedTransaction,
  decodeUnsignedTransaction,
  USDC_MAINNET_ASA_ID,
} from '@x402-avm/avm'
import { encodePaymentResponseHeader } from '@x402-avm/core/http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DONATION_CAP_MICRO, DonationRefusedError, fetchWithDonation } from './donor.js'

// Test mnemonic — fresh throwaway account, never funded
const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'

// Valid MainNet-shaped addresses, generated once for these tests only.
const PAY_TO = 'J6DSQYYXYO53B7PC6MZ5M2OO7V3RM4MIWTV7KCH5IQBUXF7KMGPVFWIRAM'
const FEE_PAYER = 'EA4DXI4WJWSSJQAAKG5ZFNVA6U26NT7DBWHUKP5C3HSVKBAQ3KGPKVEN5A'
const RESOURCE_URL = 'http://localhost:4873/v1/attest/lockfile'

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

// A facilitator-shaped 402: PaymentRequired carried in the PAYMENT-REQUIRED
// header (x402 v2), never in the JSON body.
function paymentRequiredHeader(amount: string, asset: string): string {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [
      {
        scheme: 'exact',
        network: ALGORAND_MAINNET_CAIP2,
        asset,
        amount,
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: { asset, feePayer: FEE_PAYER, tag: 'x402-global-challenge' },
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

function unpaid402(amount: string, asset: string): Response {
  return new Response(null, {
    status: 402,
    headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader(amount, asset) },
  })
}

describe('fetchWithDonation', () => {
  beforeEach(() => {
    delete process.env.SPM_DONOR_MNEMONIC
    delete process.env.NETWORK
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SPM_DONOR_MNEMONIC
    delete process.env.NETWORK
  })

  it('without allowDonation, a 402 does not sign and reports the price and resource url', async () => {
    const mockFetch = vi.fn(async () => unpaid402('1000', USDC_MAINNET_ASA_ID))
    vi.stubGlobal('fetch', mockFetch)

    const result = await fetchWithDonation(RESOURCE_URL, undefined, false)

    expect(result.kind).toBe('donation_required')
    if (result.kind !== 'donation_required') throw new Error('unreachable')
    expect(result.requirement.priceMicro).toBe(1000)
    expect(result.requirement.resourceUrl).toBe(RESOURCE_URL)
    expect(result.requirement.asset).toBe(USDC_MAINNET_ASA_ID)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('with allowDonation, a 402 at exactly the cap signs and retries exactly once', async () => {
    process.env.SPM_DONOR_MNEMONIC = TEST_MNEMONIC
    let paidRequestCount = 0

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()

      const request = input instanceof Request ? input : new Request(url, init)
      const paymentSignature = request.headers.get('PAYMENT-SIGNATURE')
      if (!paymentSignature) return unpaid402(String(DONATION_CAP_MICRO), USDC_MAINNET_ASA_ID)

      paidRequestCount += 1
      return new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-cap-ok') },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await fetchWithDonation(RESOURCE_URL, undefined, true)

    expect(result.kind).toBe('response')
    expect(paidRequestCount).toBe(1)
    const resourceCalls = mockFetch.mock.calls.filter(
      ([input]) => !requestUrl(input as RequestInfo | URL).includes('/v2/transactions/params'),
    )
    expect(resourceCalls).toHaveLength(2)
  })

  it('with allowDonation, a 402 one microUSDC over the cap does not sign', async () => {
    process.env.SPM_DONOR_MNEMONIC = TEST_MNEMONIC
    const overCap = String(DONATION_CAP_MICRO + 1)

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()
      const request = input instanceof Request ? input : new Request(url, init)
      if (request.headers.get('PAYMENT-SIGNATURE')) {
        throw new Error('must never sign a requirement above the donation cap')
      }
      return unpaid402(overCap, USDC_MAINNET_ASA_ID)
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchWithDonation(RESOURCE_URL, undefined, true)).rejects.toThrow(
      DonationRefusedError,
    )
  })

  it('with allowDonation, a 402 for a non-USDC asset does not sign', async () => {
    process.env.SPM_DONOR_MNEMONIC = TEST_MNEMONIC

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()
      const request = input instanceof Request ? input : new Request(url, init)
      if (request.headers.get('PAYMENT-SIGNATURE')) {
        throw new Error('must never sign a non-USDC requirement')
      }
      // Asset '0' is ALGO, not the USDC ASA — CLAUDE.md: an omitted/wrong
      // asset must never be paid as if it were USDC.
      return unpaid402('1000', '0')
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchWithDonation(RESOURCE_URL, undefined, true)).rejects.toThrow(
      DonationRefusedError,
    )
  })

  it('a zero-coverage 200 succeeds without SPM_DONOR_MNEMONIC set, even with allowDonation true', async () => {
    const mockFetch = vi.fn(
      async () => new Response(JSON.stringify({ summary: { reviewed: 0 } }), { status: 200 }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await fetchWithDonation(RESOURCE_URL, undefined, true)

    expect(result.kind).toBe('response')
    if (result.kind !== 'response') throw new Error('unreachable')
    expect(result.response.status).toBe(200)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('fails with a message naming SPM_DONOR_MNEMONIC when it is unset and a donation is due', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()
      return unpaid402(String(DONATION_CAP_MICRO), USDC_MAINNET_ASA_ID)
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(fetchWithDonation(RESOURCE_URL, undefined, true)).rejects.toThrow(
      /SPM_DONOR_MNEMONIC/,
    )
  })
})

// Re-export shape check so decodeSignedTransaction/decodeUnsignedTransaction stay used —
// exercised via the paid group shape below.
describe('fetchWithDonation: paid transaction group shape', () => {
  beforeEach(() => {
    process.env.SPM_DONOR_MNEMONIC = TEST_MNEMONIC
    delete process.env.NETWORK
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SPM_DONOR_MNEMONIC
  })

  it('pays with a plain USDC asset transfer to payTo, never an appcall', async () => {
    let capturedHeader: string | null = null

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()

      const request = input instanceof Request ? input : new Request(url, init)
      const paymentSignature = request.headers.get('PAYMENT-SIGNATURE')
      if (!paymentSignature) {
        return unpaid402(String(DONATION_CAP_MICRO), USDC_MAINNET_ASA_ID)
      }
      capturedHeader = paymentSignature
      return new Response(new Uint8Array([1]), {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-shape-ok') },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    await fetchWithDonation(RESOURCE_URL, undefined, true)

    expect(capturedHeader).not.toBeNull()
    // biome-ignore lint/style/noNonNullAssertion: not-null asserted above
    const payloadJson = JSON.parse(Buffer.from(capturedHeader!, 'base64').toString('utf8')) as {
      payload: { paymentGroup: string[]; paymentIndex: number }
    }
    const { paymentGroup, paymentIndex } = payloadJson.payload
    expect(paymentGroup).toHaveLength(2)
    const decoded = paymentGroup.map((txn, i) =>
      i === paymentIndex ? decodeSignedTransaction(txn).txn : decodeUnsignedTransaction(txn),
    )
    for (const txn of decoded) {
      expect(txn.type).not.toBe('appl')
    }
    // biome-ignore lint/style/noNonNullAssertion: paymentIndex is decoded from this same settled payment group
    const payment = decoded[paymentIndex]!
    expect(payment.type).toBe('axfer')
    expect(payment.assetTransfer?.receiver.toString()).toBe(PAY_TO)
    expect(payment.assetTransfer?.assetId).toBe(BigInt(USDC_MAINNET_ASA_ID))
  })
})
