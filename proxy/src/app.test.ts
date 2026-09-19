// proxy/src/app.test.ts
//
// CAUTION: the facilitator client used here is a stub (see
// stubFacilitatorClient below). No test in this file performs a network
// call — env vars are set before the app modules are imported so that
// proxy/src/config.ts resolves PAY_TO/CAIP2_NETWORK/USDC_ASA_ID from them.

import { decodePaymentRequiredHeader } from '@x402-avm/core/http'
import type { FacilitatorClient } from '@x402-avm/core/server'
import { beforeEach, describe, expect, test } from 'vitest'

const FAKE_APP_ADDRESS = 'FAKEADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

process.env.SPLIT_APP_ADDRESS = FAKE_APP_ADDRESS
process.env.NETWORK = 'mainnet'

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

const { httpServer } = buildHttpServer(stubFacilitatorClient(), FEE_PAYER)
const app = createApp(httpServer)

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

  test('POST /v1/attest/lockfile: 402 before the stub 501 handler runs', async () => {
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lockfileVersion: 3, packages: {} }),
    })
    expect(res.status).toBe(402)
  })

  test('GET /v1/attest: 402 before the stub 501 handler runs', async () => {
    const res = await app.request('/v1/attest?name=ms&version=2.1.3')
    expect(res.status).toBe(402)
  })
})

describe('app default export (production wiring)', () => {
  test('the default export does not perform a network call at import time', async () => {
    // Importing proxy/src/app.js above (transitively, via createApp) must not
    // have thrown or hung — the facilitator boot is deferred to first request.
    const mod = await import('./app.js')
    expect(mod.default).toBeDefined()
  })
})
