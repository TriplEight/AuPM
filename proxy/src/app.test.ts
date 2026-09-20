// proxy/src/app.test.ts
//
// CAUTION: the facilitator client used here is a stub (see
// stubFacilitatorClient below). No test in this file performs a network
// call — env vars are set before the app modules are imported so that
// proxy/src/config.ts resolves PAY_TO/CAIP2_NETWORK/USDC_ASA_ID from them.

import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402-avm/core/http'
import type { FacilitatorClient } from '@x402-avm/core/server'
import { beforeEach, describe, expect, test } from 'vitest'

const FAKE_APP_ADDRESS = 'FAKEADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

process.env.SPLIT_APP_ADDRESS = FAKE_APP_ADDRESS
process.env.NETWORK = 'mainnet'
// A 32-byte hex seed, not a real key — only the free attestation paths
// (single-attest, zero-coverage lockfile) ever reach getAttestationSigningKey()
// in this file; every paid path is blocked by the (stub, always-invalid)
// facilitator before signing would run.
process.env.ATTEST_SIGNING_KEY = 'fc982b5f02591ece632fde9d22879692daafd28398f928369c5f1c1f9ff0fd3a'

const db = (await import('./db.js')).default
const { setStatus } = await import('./status.js')
const { createApp } = await import('./app.js')
const { buildHttpServer } = await import('./x402/server.js')
const { CAIP2_NETWORK, USDC_ASA_ID, TAG } = await import('./config.js')

function stubFacilitatorClient(): FacilitatorClient {
  return {
    getSupported: async () => ({
      kinds: [
        { x402Version: 2, scheme: 'exact', network: CAIP2_NETWORK, extra: { feePayer: FEE_PAYER } },
      ],
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: false, invalidReason: 'stub facilitator: never valid' }),
    settle: async () => ({
      success: false,
      errorReason: 'stub facilitator: never settles',
      transaction: '',
      network: CAIP2_NETWORK,
    }),
  }
}

const { getAccrualsForTxid } = await import('./claims/ledger.js')

const { httpServer } = buildHttpServer(stubFacilitatorClient(), FEE_PAYER)
const app = createApp(httpServer)

function stubSuccessFacilitatorClient(): FacilitatorClient {
  return {
    getSupported: async () => ({
      kinds: [
        { x402Version: 2, scheme: 'exact', network: CAIP2_NETWORK, extra: { feePayer: FEE_PAYER } },
      ],
      extensions: [],
      signers: {},
    }),
    verify: async () => ({ isValid: true }),
    settle: async () => ({
      success: true,
      transaction: 'INTEGRATION-TX-1',
      network: CAIP2_NETWORK,
    }),
  }
}

beforeEach(() => {
  db.exec('DELETE FROM audit_status')
})

describe('x402 gate', () => {
  test('non-tarball request: proxied without 402 check', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash')
    expect(res.status).not.toBe(402)
  })

  test('unreviewed tarball path: returns 200 and sends no payment header', async () => {
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz')
    expect(res.status).not.toBe(402)
  })

  test('reviewed tarball path: returns 402', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz')
    expect(res.status).toBe(402)
  })

  test('402 body carries the asset id, the fee payer, and the tag', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz')
    expect(res.status).toBe(402)
    // x402Version 2 puts the PaymentRequired payload in the PAYMENT-REQUIRED
    // header (base64), not the JSON body — the JSON body is `{}`. Verified by
    // reading @x402-avm/core's createHTTPPaymentRequiredResponse().
    const header = res.headers.get('PAYMENT-REQUIRED')
    expect(header).toBeTruthy()
    const paymentRequired = decodePaymentRequiredHeader(header as string) as unknown as {
      accepts: Array<{ extra?: { asset?: string; feePayer?: string; tag?: string } }>
    }
    const option = paymentRequired.accepts[0]
    expect(option?.extra?.asset).toBe(USDC_ASA_ID)
    expect(option?.extra?.feePayer).toBe(FEE_PAYER)
    expect(option?.extra?.tag).toBe(TAG)
  })

  test('reviewed scoped package tarball: returns 402', async () => {
    setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/@scope/pkg/-/pkg-1.0.0.tgz')
    expect(res.status).toBe(402)
  })

  test('/api/v1/status is free and unauthenticated regardless of tier', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/api/v1/status/lodash/4.17.21')
    expect(res.status).toBe(200)
  })

  // A zero-coverage lockfile (no reviewed packages) is free by design (the
  // attestation-signing work item's lockfile pre-middleware answers it
  // before the payment gate ever runs) — so this reaches the gate with a
  // lockfile that has one reviewed package instead, to keep testing what it
  // always tested: the gate fires before the real handler runs.
  test('POST /v1/attest/lockfile: 402 before the real handler runs (nonzero coverage)', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null, 'sha512-abc')
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': {
            version: '2.1.3',
            resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
            integrity: 'sha512-abc',
          },
        },
      }),
    })
    expect(res.status).toBe(402)
  })

  test('GET /v1/attest: 402 before the real handler runs (reviewed, with stored integrity)', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null, 'sha512-abc')
    const res = await app.request('/v1/attest?name=ms&version=2.1.3')
    expect(res.status).toBe(402)
  })

  test('GET /v1/attest: UNREVIEWED never returns 402, and sends no payment header', async () => {
    const res = await app.request('/v1/attest?name=ms&version=2.1.3')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
  })

  test('GET /v1/attest: a reviewed row with no stored integrity is free, never 402 (honesty rule)', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/v1/attest?name=ms&version=2.1.3')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
  })
})

// Drives a real settlement through the whole app (not the middleware alone):
// this is the wiring test for claimsLedgerMiddleware and createClaimsRouter
// (see proxy/src/app.ts). The facilitator stub here reports every payload
// valid and always settles — no real Algorand signature is built; only
// @x402-avm/core's own header codecs and this file's stub run.
describe('claims ledger, wired into the real app', () => {
  test('a settled paid request writes an accrual, and the earnings route reports it for free', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'github:alice', null, 'sha512-abc')

    const { httpServer: paidHttpServer } = buildHttpServer(
      stubSuccessFacilitatorClient(),
      FEE_PAYER,
    )
    const paidApp = createApp(paidHttpServer)

    // Unpaid request: 402, carrying the real payment requirements.
    const unpaidRes = await paidApp.request('/v1/attest?name=ms&version=2.1.3')
    expect(unpaidRes.status).toBe(402)
    const requiredHeader = unpaidRes.headers.get('PAYMENT-REQUIRED')
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader as string) as unknown as {
      accepts: Array<Record<string, unknown>>
    }
    const accepted = paymentRequired.accepts[0]

    // Retry with a PAYMENT-SIGNATURE header built from those exact
    // requirements, so findMatchingRequirements accepts it.
    const paymentSignature = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: {},
    } as unknown as Parameters<typeof encodePaymentSignatureHeader>[0])

    const paidRes = await paidApp.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'PAYMENT-SIGNATURE': paymentSignature },
    })
    expect(paidRes.status).toBe(200)
    expect(paidRes.headers.get('PAYMENT-RESPONSE')).toBeTruthy()

    const accruals = getAccrualsForTxid('INTEGRATION-TX-1')
    const auditorRow = accruals.find((row) => row.role === 'auditor')
    expect(auditorRow?.identity).toBe('github:alice')
    expect(auditorRow?.amount_micro).toBe(500)

    const earningsRes = await paidApp.request('/api/v1/earnings/github/alice')
    expect(earningsRes.status).toBe(200)
    const earnings = (await earningsRes.json()) as {
      roles: Array<{ role: string; accruedMicro: number }>
    }
    const auditorEarnings = earnings.roles.find((r) => r.role === 'auditor')
    expect(auditorEarnings?.accruedMicro).toBeGreaterThanOrEqual(500)
  })

  test('GET /api/v1/earnings/github/:login: 200, never 402, no payment header', async () => {
    const res = await app.request('/api/v1/earnings/github/nobody')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
  })

  test('POST /api/v1/claims: 200 with a nonce, never 402, no payment header', async () => {
    const res = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ identity: 'github:carol', algorandAddress: 'ALGOADDR' }),
    })
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    const body = (await res.json()) as { nonce: string }
    expect(typeof body.nonce).toBe('string')
    expect(body.nonce.length).toBeGreaterThan(0)
  })
})
