// proxy/src/app.test.ts
//
// CAUTION: the facilitator client used here is a stub (see
// stubFacilitatorClient below). No test in this file performs a network
// call — env vars are set before the app modules are imported so that
// proxy/src/config.ts resolves PAY_TO/CAIP2_NETWORK/USDC_ASA_ID from them.
//
// CAUTION: this file also gets its own SQLite file via SQLITE_PATH, set
// before the dynamic import of ./db.js below (same trick as
// proxy/src/claims/ledger.test.ts). Without per-file isolation, vitest's
// parallel test files race on the same physical database and writes from
// one file can be wiped by another file's beforeEach mid-test.

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { decodePaymentRequiredHeader, encodePaymentSignatureHeader } from '@x402-avm/core/http'
import type { FacilitatorClient } from '@x402-avm/core/server'
import { beforeEach, describe, expect, test } from 'vitest'
import { signEnvelope, type VerificationKey, verifyEnvelope } from './attest/dsse.js'

const FAKE_APP_ADDRESS = 'FAKEADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

process.env.SPLIT_APP_ADDRESS = FAKE_APP_ADDRESS
process.env.NETWORK = 'mainnet'
// A 32-byte hex seed, not a real key — only the free attestation paths
// (single-attest, zero-coverage lockfile) ever reach getAttestationSigningKey()
// in this file; every paid path is blocked by the (stub, always-invalid)
// facilitator before signing would run.
process.env.ATTEST_SIGNING_KEY = 'fc982b5f02591ece632fde9d22879692daafd28398f928369c5f1c1f9ff0fd3a'
process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-app-test-${randomUUID()}.db`)

const db = (await import('./db.js')).default
const { setStatus } = await import('./status.js')
const { createApp } = await import('./app.js')
const { buildHttpServer } = await import('./x402/server.js')
const { CAIP2_NETWORK, USDC_ASA_ID, TAG, getAttestationSigningKey } = await import('./config.js')

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

function stubSuccessFacilitatorClient(transaction = 'INTEGRATION-TX-1'): FacilitatorClient {
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
      transaction,
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

  // Paywall-bypass regression, driven through the *real* app (the x402
  // gate's onProtectedRequest hook, proxy/src/x402/tarball.ts's path parser,
  // and the SQLite status store together) — every accepted encoding of a
  // reviewed scoped package's tarball path must return 402. WARNING: never
  // relax this; a defect here hands a reviewed tarball out for free
  // (mcp/src/tools/install.ts requests the %2F-encoded form).
  describe.each([
    ['literal slash', '/@scope/pkg/-/pkg-1.0.0.tgz'],
    ['%40-encoded scope only', '/%40scope/pkg/-/pkg-1.0.0.tgz'],
    ['%2F-encoded separator only', '/@scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['%2f-encoded separator only (lowercase)', '/@scope%2fpkg/-/pkg-1.0.0.tgz'],
    ['both encoded', '/%40scope%2Fpkg/-/pkg-1.0.0.tgz'],
  ])('scoped tarball path encoding: %s (reviewed)', (_label, path) => {
    test('402, regardless of encoding', async () => {
      setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
      const res = await app.request(path)
      expect(res.status).toBe(402)
    })
  })

  // Companion case, same encodings, for a real published (unreviewed)
  // package's tarball — a real request/response pair so "200" is asserted
  // against an actual upstream response, not just "not 402".
  describe.each([
    ['literal slash', '/@babel/core/-/core-7.25.2.tgz'],
    ['%40-encoded scope only', '/%40babel/core/-/core-7.25.2.tgz'],
    ['%2F-encoded separator only', '/@babel%2Fcore/-/core-7.25.2.tgz'],
    ['%2f-encoded separator only (lowercase)', '/@babel%2fcore/-/core-7.25.2.tgz'],
    ['both encoded', '/%40babel%2Fcore/-/core-7.25.2.tgz'],
  ])('scoped tarball path encoding: %s (unreviewed)', (_label, path) => {
    test('200, no payment header, regardless of encoding', async () => {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(res.status).not.toBe(402)
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    })
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
    // auditor_addr is a plain Algorand address — a different fact from the
    // reviewer's GitHub login (the 7th argument). Defect pin: the ledger
    // must key on `github:<login>` (from `reviewer`), never on this address
    // — writing the accrual under the address would strand the auditor's
    // share under an identity no lookup, including the earnings endpoint
    // below, can ever find.
    setStatus(
      'ms',
      '2.1.3',
      'COMMUNITY_REVIEWED',
      'ONCHAIN_ATTESTING_ADDR',
      null,
      'sha512-abc',
      'alice',
    )

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

  // Defect pin: the paid tarball route never set `attribution`, so
  // claimsLedgerMiddleware wrote no accrual for any tarball payment —
  // tarball revenue accrued on chain with no record of who was owed it.
  test('a settled paid tarball request writes a tarball accrual', async () => {
    setStatus(
      'lodash',
      '4.17.21',
      'COMMUNITY_REVIEWED',
      'ONCHAIN_ATTESTING_ADDR',
      null,
      'sha512-abc',
      'carol',
    )

    const { httpServer: paidHttpServer } = buildHttpServer(
      stubSuccessFacilitatorClient('INTEGRATION-TX-TARBALL'),
      FEE_PAYER,
    )
    const paidApp = createApp(paidHttpServer)

    const unpaidRes = await paidApp.request('/lodash/-/lodash-4.17.21.tgz')
    expect(unpaidRes.status).toBe(402)
    const requiredHeader = unpaidRes.headers.get('PAYMENT-REQUIRED')
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader as string) as unknown as {
      accepts: Array<Record<string, unknown>>
    }
    const accepted = paymentRequired.accepts[0]

    const paymentSignature = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: {},
    } as unknown as Parameters<typeof encodePaymentSignatureHeader>[0])

    const paidRes = await paidApp.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'PAYMENT-SIGNATURE': paymentSignature },
    })
    expect(paidRes.status).toBe(200)
    expect(paidRes.headers.get('PAYMENT-RESPONSE')).toBeTruthy()

    const accruals = getAccrualsForTxid('INTEGRATION-TX-TARBALL')
    expect(accruals.length).toBeGreaterThan(0)
    expect(accruals.every((row) => row.route === 'tarball')).toBe(true)
    const auditorRow = accruals.find((row) => row.role === 'auditor')
    expect(auditorRow?.identity).toBe('github:carol')
    expect(auditorRow?.amount_micro).toBe(500)
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

// GET /.well-known/spm-keys.json publishes the attestation public key so a
// third party can verify a DSSE envelope offline, without holding the key
// out of band (see proxy/src/attest/keys.ts). Registered before the
// payment gate in app.ts, so it must never require payment.
describe('.well-known/spm-keys.json', () => {
  test('200, never 402, no payment header, body carries exactly the four published fields', async () => {
    const res = await app.request('/.well-known/spm-keys.json')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()

    const body = (await res.json()) as Array<Record<string, unknown>>
    expect(body).toHaveLength(1)
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    const entry = body[0]!
    expect(Object.keys(entry).sort()).toEqual(['keyid', 'publicKey', 'validFrom', 'validUntil'])

    const configuredKey = await getAttestationSigningKey()
    expect(entry.keyid).toBe(configuredKey.keyid)
  })

  test('sets content-type and a cache header', async () => {
    const res = await app.request('/.well-known/spm-keys.json')
    expect(res.headers.get('content-type')).toContain('application/json')
    expect(res.headers.get('cache-control')).toBeTruthy()
  })

  test('never leaks the seed or the configured ATTEST_SIGNING_KEY value', async () => {
    const res = await app.request('/.well-known/spm-keys.json')
    const serialized = await res.text()
    const configuredKey = await getAttestationSigningKey()

    expect(serialized).not.toContain(process.env.ATTEST_SIGNING_KEY as string)
    expect(serialized).not.toContain(Buffer.from(configuredKey.seed).toString('base64'))
    expect(serialized).not.toContain(Buffer.from(configuredKey.seed).toString('hex'))
  })

  test('no signing key configured: a clear error, never a placeholder key', async () => {
    const { httpServer: noKeyHttpServer } = buildHttpServer(stubFacilitatorClient(), FEE_PAYER)
    const noKeyApp = createApp(noKeyHttpServer, {
      getSigningKey: async () => {
        throw new Error('ATTEST_SIGNING_KEY is not set: cannot sign attestations')
      },
    })

    const res = await noKeyApp.request('/.well-known/spm-keys.json')
    expect(res.status).toBeGreaterThanOrEqual(500)
    const body = (await res.json()) as { error?: string }
    expect(typeof body.error).toBe('string')
    expect((body.error as string).length).toBeGreaterThan(0)
  })

  test('round trip: an envelope signed by the proxy verifies against only the fetched keys', async () => {
    const signingKey = await getAttestationSigningKey()
    const payload = new TextEncoder().encode(JSON.stringify({ hello: 'spm' }))
    const envelope = await signEnvelope(payload, 'application/vnd.spm.test+json', signingKey)

    const res = await app.request('/.well-known/spm-keys.json')
    expect(res.status).toBe(200)
    const fetchedKeys = (await res.json()) as VerificationKey[]

    const verified = await verifyEnvelope(envelope, fetchedKeys)
    expect(verified).toBe(true)
  })
})
