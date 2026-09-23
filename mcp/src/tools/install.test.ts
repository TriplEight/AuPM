import { Buffer } from 'node:buffer'
import {
  ALGORAND_MAINNET_CAIP2,
  decodeSignedTransaction,
  decodeUnsignedTransaction,
  USDC_MAINNET_ASA_ID,
} from '@x402-avm/avm'
import { encodePaymentResponseHeader } from '@x402-avm/core/http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installTool } from './install.js'

// Test mnemonic — fresh throwaway account, never funded
const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'

// Valid MainNet-shaped addresses, generated once for these tests only.
const PAY_TO = 'J6DSQYYXYO53B7PC6MZ5M2OO7V3RM4MIWTV7KCH5IQBUXF7KMGPVFWIRAM'
const FEE_PAYER = 'EA4DXI4WJWSSJQAAKG5ZFNVA6U26NT7DBWHUKP5C3HSVKBAQ3KGPKVEN5A'
const UNIT = '1000'

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
function paymentRequiredHeader(): string {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: 'http://localhost:4873/lodash/-/lodash-4.17.21.tgz' },
    accepts: [
      {
        scheme: 'exact',
        network: ALGORAND_MAINNET_CAIP2,
        asset: USDC_MAINNET_ASA_ID,
        amount: UNIT,
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: { asset: USDC_MAINNET_ASA_ID, feePayer: FEE_PAYER, tag: 'x402-global-challenge' },
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

// Builds a real PAYMENT-RESPONSE header value via the matching encoder, the
// same one the installed @x402-avm/hono middleware uses to set it.
function settleResponseHeader(transaction: string, success = true): string {
  return encodePaymentResponseHeader({
    success,
    transaction,
    network: ALGORAND_MAINNET_CAIP2,
  })
}

describe('install_audited_package', () => {
  beforeEach(() => {
    process.env.SPM_DONOR_MNEMONIC = TEST_MNEMONIC
    process.env.SPM_PROXY_URL = 'http://localhost:4873'
    delete process.env.NETWORK
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.SPM_DONOR_MNEMONIC
    delete process.env.SPM_PROXY_URL
    delete process.env.NETWORK
  })

  it('without allowDonation, a 402 never signs and reports donation_required', async () => {
    const mockFetch = vi.fn(async () => {
      return new Response(null, {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await installTool.handler({ pkg: 'lodash', version: '4.17.21' })

    expect(result.status).toBe('donation_required')
    if (result.status !== 'donation_required') throw new Error('unreachable')
    expect(result.priceMicro).toBe(1000)
    expect(result.resourceUrl).toBe('http://localhost:4873/lodash/-/lodash-4.17.21.tgz')
    expect(result.asset).toBe(USDC_MAINNET_ASA_ID)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('without allowDonation, sends X-SPM-Donate: 0', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(requestUrl(input), init)
      expect(request.headers.get('X-SPM-Donate')).toBe('0')
      return new Response(new Uint8Array([1, 2, 3, 4]), { status: 200 })
    })
    vi.stubGlobal('fetch', mockFetch)

    await installTool.handler({ pkg: 'lodash', version: '4.17.21' })

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('with allowDonation, sends X-SPM-Donate: 1 on both the initial and the paid retry', async () => {
    process.env.SPM_DONOR_MNEMONIC = TEST_MNEMONIC
    const seenHeaderValues: (string | null)[] = []

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()

      const request = input instanceof Request ? input : new Request(url, init)
      seenHeaderValues.push(request.headers.get('X-SPM-Donate'))
      const paymentSignature = request.headers.get('PAYMENT-SIGNATURE')
      if (!paymentSignature) {
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
        })
      }
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-header-value-ok') },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    await installTool.handler({ pkg: 'lodash', version: '4.17.21', allowDonation: true })

    expect(seenHeaderValues).toEqual(['1', '1'])
  })

  it('with allowDonation, pays with a plain USDC asset transfer to payTo — exactly one paid retry, no appcall', async () => {
    let paidRequestCount = 0
    let capturedHeader: string | null = null

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)

      // The x402-avm ExactAvmScheme fetches suggested params from algod to build
      // the transaction group. Stub it so the test never reaches the network.
      if (url.includes('/v2/transactions/params')) {
        return algodParamsResponse()
      }

      const request = input instanceof Request ? input : new Request(url, init)
      const paymentSignature = request.headers.get('PAYMENT-SIGNATURE')

      if (!paymentSignature) {
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
        })
      }

      // A second call ever showing up without exactly one prior 402 would mean
      // wrapFetchWithPayment retried more than once — CAUTION: retry storms are
      // classified as DEV traffic and discarded.
      paidRequestCount += 1
      capturedHeader = paymentSignature
      return new Response(new Uint8Array([1, 2, 3, 4]), {
        status: 200,
        headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-abc123') },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await installTool.handler({
      pkg: 'lodash',
      version: '4.17.21',
      allowDonation: true,
    })

    if (result.status === 'donation_required') throw new Error('unreachable')
    expect(result.status).toBe('paid')
    expect(result.txid).toBe('txid-abc123')
    expect(result.loraUrl).not.toBeNull()
    expect(result.loraUrl).toContain('txid-abc123')
    expect(paidRequestCount).toBe(1)
    expect(capturedHeader).not.toBeNull()

    // Exactly two calls to the resource server: the initial 402, then one paid
    // retry. (A third mockFetch call is the internal algod params lookup.)
    const resourceCalls = mockFetch.mock.calls.filter(
      ([input]) => !requestUrl(input as RequestInfo | URL).includes('/v2/transactions/params'),
    )
    expect(resourceCalls).toHaveLength(2)

    // Decode PAYMENT-SIGNATURE (base64 JSON) → payment payload → paymentGroup.
    // biome-ignore lint/style/noNonNullAssertion: not-null asserted above
    const payloadJson = JSON.parse(Buffer.from(capturedHeader!, 'base64').toString('utf8')) as {
      payload: { paymentGroup: string[]; paymentIndex: number }
    }
    const { paymentGroup, paymentIndex } = payloadJson.payload

    // No application-call transaction anywhere in the group — the old
    // SplitRouter appcall payload is gone. The group is just the fee-payer
    // self-payment (unsigned, for the facilitator to sign) and the client's
    // plain USDC transfer.
    expect(paymentGroup).toHaveLength(2)
    const decoded = paymentGroup.map((txn, i) =>
      i === paymentIndex ? decodeSignedTransaction(txn).txn : decodeUnsignedTransaction(txn),
    )
    for (const txn of decoded) {
      expect(txn.type).not.toBe('appl')
    }

    // The designated payment transaction is a plain USDC transfer to payTo.
    // biome-ignore lint/style/noNonNullAssertion: paymentIndex is decoded from this same settled payment group
    const payment = decoded[paymentIndex]!
    expect(payment.type).toBe('axfer')
    expect(payment.assetTransfer?.receiver.toString()).toBe(PAY_TO)
    expect(payment.assetTransfer?.amount).toBe(BigInt(UNIT))
    expect(payment.assetTransfer?.assetId).toBe(BigInt(USDC_MAINNET_ASA_ID))
  })

  it('returns free result without payment when server returns 200 directly', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {},
        }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await installTool.handler({ pkg: 'lodash', version: '4.17.21' })

    if (result.status === 'donation_required') throw new Error('unreachable')
    expect(result.status).toBe('free')
    expect(result.txid).toBeNull()
    expect(result.loraUrl).toBeNull()
    // Only one fetch — no 402, so no retry and no payment.
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('accepts the legacy X-PAYMENT-RESPONSE header the same way', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'X-PAYMENT-RESPONSE': settleResponseHeader('txid-legacy456') },
        }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await installTool.handler({
      pkg: 'lodash',
      version: '4.17.21',
      allowDonation: true,
    })

    if (result.status === 'donation_required') throw new Error('unreachable')
    expect(result.status).toBe('paid')
    expect(result.txid).toBe('txid-legacy456')
    expect(result.loraUrl).toContain('txid-legacy456')
  })

  it('raises an error rather than reporting free on a malformed payment header', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: { 'PAYMENT-RESPONSE': 'not-valid-base64-json!!!' },
        }),
    )
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      installTool.handler({ pkg: 'lodash', version: '4.17.21', allowDonation: true }),
    ).rejects.toThrow()
  })

  it('raises an error rather than reporting free when settlement did not succeed', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(new Uint8Array([1, 2, 3, 4]), {
          status: 200,
          headers: {
            'PAYMENT-RESPONSE': settleResponseHeader('txid-failed789', false),
          },
        }),
    )
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      installTool.handler({ pkg: 'lodash', version: '4.17.21', allowDonation: true }),
    ).rejects.toThrow()
  })
})
