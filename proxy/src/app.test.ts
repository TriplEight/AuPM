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

// A real 64-byte sha512 digest, base64 encoded.
//
// CAUTION: never use a short placeholder such as 'sha512-abc' here. That
// decodes to 2 bytes, and integrityToHex now rejects anything that is not
// exactly 64 bytes, so the row stops being priceable and a paid route
// quietly returns free. A fixture that does not look like real data stops
// testing the real path.
const REVIEWED_INTEGRITY =
  'sha512-uMabji0PUK/GUkT4djAnOhdLs5wT7SYAFg85uVAC7RjEn3rHxVZkSM7STlycrgrv9tJioRWIV9l213uMAlOdiQ=='

const FAKE_APP_ADDRESS = 'FAKEADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

process.env.PAY_TO_ADDRESS = FAKE_APP_ADDRESS
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
    expect(res.headers.get('X-SPM-Tier')).toBe('UNREVIEWED')
  })

  // ADR 0006 / SPEC §10.4: npm install can never pay a 402, so a reviewed
  // tarball is free unless the request opts in with X-SPM-Donate: 1.
  test('unreviewed tarball path with X-SPM-Donate: 1: still returns 200', async () => {
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'X-SPM-Donate': '1' },
    })
    expect(res.status).not.toBe(402)
  })

  test('reviewed tarball path, no donate header: returns 200, tier and donate hint', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz')
    expect(res.status).toBe(200)
    expect(res.headers.get('X-SPM-Tier')).toBe('COMMUNITY_REVIEWED')
    expect(res.headers.get('X-SPM-Donate-Hint')).toBe('1000')
  })

  // Any header value other than the exact string "1" does not opt in
  // (CLAUDE.md invariant 4: "X-SPM-Donate: 0 ... gets a free partial
  // attestation" — the tarball route applies the identical rule).
  test('reviewed tarball path, X-SPM-Donate: 0: returns 200, not 402', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'X-SPM-Donate': '0' },
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('X-SPM-Donate-Hint')).toBe('1000')
  })

  test('reviewed tarball path, X-SPM-Donate: 1: returns 402', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'X-SPM-Donate': '1' },
    })
    expect(res.status).toBe(402)
  })

  // Defect pin, driven through the real app (Hono -> x402 route matcher ->
  // onProtectedRequest hook -> proxy.ts passthrough): the route matcher in
  // @x402-avm/core collapses a duplicate slash and strips a trailing slash
  // before testing TARBALL_ROUTE_KEY, but normalizeTarballPath used to do
  // neither. A `//` before `/-/` produced the bogus name "lodash/", which
  // read UNREVIEWED and bypassed the paywall (served the tarball, 200, for
  // free). A trailing `/` made isTarballPath return false, so the hook never
  // ran and an unreviewed package was charged (402). Every spelling below
  // must land on the same side as the canonical path.
  describe.each([
    ['canonical', '/lodash/-/lodash-4.17.21.tgz'],
    ['duplicate slash before /-/', '/lodash//-/lodash-4.17.21.tgz'],
    ['duplicate slash after /-/', '/lodash/-//lodash-4.17.21.tgz'],
    ['trailing slash', '/lodash/-/lodash-4.17.21.tgz/'],
    ['leading double slash', '//lodash/-/lodash-4.17.21.tgz'],
  ])('unscoped tarball path spelling: %s (reviewed)', (_label, path) => {
    test('X-SPM-Donate: 1: 402, never 200, never tarball bytes', async () => {
      setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
      const res = await app.request(path, { headers: { 'X-SPM-Donate': '1' } })
      expect(res.status).toBe(402)
    })

    test('no donate header: 200, never 402 (free tier grant)', async () => {
      setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
      const res = await app.request(path)
      expect(res.status).not.toBe(402)
    })
  })

  // Companion negative control, real (unreviewed) package: same spellings
  // must never return 402, driven through a real upstream response.
  describe.each([
    ['canonical', '/ms/-/ms-2.1.3.tgz'],
    ['duplicate slash before /-/', '/ms//-/ms-2.1.3.tgz'],
    ['duplicate slash after /-/', '/ms/-//ms-2.1.3.tgz'],
    ['leading double slash', '//ms/-/ms-2.1.3.tgz'],
  ])('unscoped tarball path spelling: %s (unreviewed)', (_label, path) => {
    test('200, no payment header, never 402', async () => {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(res.status).not.toBe(402)
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    })
  })

  // Trailing slash, unreviewed: proxy.ts's npm passthrough forwards the raw
  // (untrimmed) path upstream, so this legitimately 404s at the registry —
  // that literal URL is not a real npm tarball resource. The invariant this
  // defect broke is narrower: the free-tier hook must classify it as a
  // tarball path and grant access before the payment gate ever runs, so it
  // is never charged (never 402), regardless of what the registry then
  // does with it.
  test('unscoped tarball path, trailing slash (unreviewed): never 402, no payment header', async () => {
    const res = await app.request('/ms/-/ms-2.1.3.tgz/')
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
  })

  test('402 body carries the asset id, the fee payer, and the tag', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'X-SPM-Donate': '1' },
    })
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

  test('reviewed scoped package tarball, X-SPM-Donate: 1: returns 402', async () => {
    setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/@scope/pkg/-/pkg-1.0.0.tgz', {
      headers: { 'X-SPM-Donate': '1' },
    })
    expect(res.status).toBe(402)
  })

  test('reviewed scoped package tarball, no donate header: returns 200 (free tier grant)', async () => {
    setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/@scope/pkg/-/pkg-1.0.0.tgz')
    expect(res.status).not.toBe(402)
    expect(res.headers.get('X-SPM-Tier')).toBe('COMMUNITY_REVIEWED')
    expect(res.headers.get('X-SPM-Donate-Hint')).toBe('1000')
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
    ['the /-/ separator itself also encoded', '/%40scope%2Fpkg%2F-%2Fpkg-1.0.0.tgz'],
    // Defect pin: duplicate-slash / trailing-slash spellings, each combined
    // with an already-covered percent-encoding, must still return 402.
    ['duplicate slash before /-/', '/@scope/pkg//-/pkg-1.0.0.tgz'],
    ['duplicate slash after /-/', '/@scope/pkg/-//pkg-1.0.0.tgz'],
    ['trailing slash', '/@scope/pkg/-/pkg-1.0.0.tgz/'],
    ['leading double slash', '//@scope/pkg/-/pkg-1.0.0.tgz'],
    ['duplicate slash combined with %40 scope encoding', '/%40scope/pkg//-/pkg-1.0.0.tgz'],
    ['trailing slash combined with %2F separator encoding', '/@scope%2Fpkg/-/pkg-1.0.0.tgz/'],
  ])('scoped tarball path encoding: %s (reviewed)', (_label, path) => {
    test('X-SPM-Donate: 1: 402, regardless of encoding', async () => {
      setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
      const res = await app.request(path, { headers: { 'X-SPM-Donate': '1' } })
      expect(res.status).toBe(402)
    })

    test('no donate header: 200, regardless of encoding (free tier grant)', async () => {
      setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
      const res = await app.request(path)
      expect(res.status).not.toBe(402)
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
    ['the /-/ separator itself also encoded', '/%40babel%2Fcore%2F-%2Fcore-7.25.2.tgz'],
    // Defect pin: same duplicate-slash spellings, combined with an
    // already-covered percent-encoding, for a real unreviewed package —
    // must never return 402. (Trailing-slash variants are covered
    // separately below: proxy.ts forwards the raw path upstream, so a
    // literal trailing slash legitimately 404s at the registry.)
    ['duplicate slash before /-/', '/@babel/core//-/core-7.25.2.tgz'],
    ['duplicate slash after /-/', '/@babel/core/-//core-7.25.2.tgz'],
    ['leading double slash', '//@babel/core/-/core-7.25.2.tgz'],
    ['duplicate slash combined with %40 scope encoding', '/%40babel/core//-/core-7.25.2.tgz'],
  ])('scoped tarball path encoding: %s (unreviewed)', (_label, path) => {
    test('200, no payment header, regardless of encoding', async () => {
      const res = await app.request(path)
      expect(res.status).toBe(200)
      expect(res.status).not.toBe(402)
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    })
  })

  // Trailing slash, scoped + unreviewed: same narrower invariant as the
  // unscoped case above — never charged (never 402), even though the raw
  // trailing-slash URL legitimately 404s at the real npm registry.
  describe.each([
    ['trailing slash', '/@babel/core/-/core-7.25.2.tgz/'],
    ['trailing slash combined with %2F separator encoding', '/@babel%2Fcore/-/core-7.25.2.tgz/'],
  ])('scoped tarball path encoding: %s (unreviewed)', (_label, path) => {
    test('never 402, no payment header', async () => {
      const res = await app.request(path)
      expect(res.status).not.toBe(402)
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    })
  })

  // Defect pin (H1, invariant-4 variant 4): TARBALL_ROUTE_KEY compiles to
  // `^\/.*?\/-\/.*?$`, case-insensitive, with no `.tgz` suffix required —
  // strictly wider than the old isTarballPath, which required a
  // case-sensitive `.tgz` suffix. Any path in that gap (an uppercase or
  // mixed-case suffix, `/-/readme`, no extension at all) was a route the
  // gate protected but the free-tier hook could never recognise, so an
  // unreviewed package charged (402). Fixed via isTarballRouteScope: a path
  // inside the route's scope but not shaped like a resolvable tarball
  // filename now defaults to free, never to a charge.
  describe.each([
    ['lowercase .tgz', '/chalk/-/chalk-5.3.0.tgz'],
    ['uppercase .TGZ', '/chalk/-/chalk-5.3.0.TGZ'],
    ['mixed-case .Tgz', '/chalk/-/chalk-5.3.0.Tgz'],
    ['no filename after /-/', '/chalk/-/readme'],
    ['no filename at all, trailing /-/', '/chalk/-/'],
    ['no extension', '/chalk/-/chalk-5.3.0'],
  ])('tarball route scope, unreviewed package, %s', (_label, path) => {
    test('never 402, no payment header', async () => {
      const res = await app.request(path)
      expect(res.status).not.toBe(402)
      expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    })
  })

  // Companion positive control: every spelling covered above, plus the
  // uppercase-suffix spelling this defect introduced, still returns 402 for
  // a reviewed package. WARNING: never relax this — a defect here hands a
  // reviewed tarball out for free under a different-case suffix.
  describe.each([
    ['lowercase .tgz', '/chalk/-/chalk-5.3.0.tgz'],
    ['uppercase .TGZ', '/chalk/-/chalk-5.3.0.TGZ'],
    ['mixed-case .Tgz', '/chalk/-/chalk-5.3.0.Tgz'],
  ])('tarball route scope, reviewed package, %s', (_label, path) => {
    test('X-SPM-Donate: 1: 402, regardless of suffix case', async () => {
      setStatus('chalk', '5.3.0', 'COMMUNITY_REVIEWED', null, null)
      const res = await app.request(path, { headers: { 'X-SPM-Donate': '1' } })
      expect(res.status).toBe(402)
    })

    test('no donate header: 200, regardless of suffix case (free tier grant)', async () => {
      setStatus('chalk', '5.3.0', 'COMMUNITY_REVIEWED', null, null)
      const res = await app.request(path)
      expect(res.status).not.toBe(402)
    })
  })

  // `/-/readme` and the no-extension spelling can never resolve to a
  // specific version, so they stay free even when the package name has a
  // reviewed row at some other version — there is nothing here to
  // positively identify as that reviewed tarball.
  test('reviewed package, /-/readme: still never 402 (nothing to resolve)', async () => {
    setStatus('chalk', '5.3.0', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/chalk/-/readme')
    expect(res.status).not.toBe(402)
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
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': {
            version: '2.1.3',
            resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
        },
      }),
    })
    expect(res.status).toBe(402)
  })

  // SPEC §11.2, ADR 0008: the lockfile route prices at 1,000 microUSDC x N
  // reviewed entries — a DynamicPrice function, resolved against the exact
  // same LockfileAnalysis the pre-middleware already computed (never a
  // second parse). N is `summary.reviewed`, not `summary.total`.
  test('POST /v1/attest/lockfile: PAYMENT-REQUIRED amount is 1,000 x N for N reviewed entries', async () => {
    setStatus('pkg-a', '1.0.0', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    setStatus('pkg-b', '1.0.0', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    setStatus('pkg-c', '1.0.0', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/pkg-a': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
          'node_modules/pkg-b': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg-b/-/pkg-b-1.0.0.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
          'node_modules/pkg-c': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg-c/-/pkg-c-1.0.0.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
        },
      }),
    })
    expect(res.status).toBe(402)
    const header = res.headers.get('PAYMENT-REQUIRED')
    const paymentRequired = decodePaymentRequiredHeader(header as string) as unknown as {
      accepts: Array<{ amount?: string; asset?: string }>
    }
    expect(paymentRequired.accepts[0]?.amount).toBe('3000')
    expect(paymentRequired.accepts[0]?.asset).toBe(USDC_ASA_ID)
  })

  // SPEC §10.4, §12.3: an INTEGRITY_MISMATCH or UNRESOLVABLE entry is never
  // charged — N counts only COMMUNITY_REVIEWED entries whose integrity
  // matches, never the tree's total entry count.
  test('POST /v1/attest/lockfile: an INTEGRITY_MISMATCH and an UNRESOLVABLE entry are never charged', async () => {
    setStatus('pkg-a', '1.0.0', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    setStatus('pkg-b', '1.0.0', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    setStatus('pkg-c', '1.0.0', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    setStatus('pkg-mismatch', '1.0.0', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/pkg-a': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
          'node_modules/pkg-b': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg-b/-/pkg-b-1.0.0.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
          'node_modules/pkg-c': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg-c/-/pkg-c-1.0.0.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
          // Reviewed, but the lockfile's own integrity disagrees with the
          // stored known-good value: INTEGRITY_MISMATCH, never charged.
          'node_modules/pkg-mismatch': {
            version: '1.0.0',
            resolved: 'https://registry.npmjs.org/pkg-mismatch/-/pkg-mismatch-1.0.0.tgz',
            integrity: `sha512-${'B'.repeat(86)}==`,
          },
          // Not resolved from the npm registry: UNRESOLVABLE, never charged.
          'node_modules/pkg-unresolvable': {
            version: '1.0.0',
            resolved: 'git+https://github.com/example/pkg-unresolvable.git',
            integrity: REVIEWED_INTEGRITY,
          },
        },
      }),
    })
    expect(res.status).toBe(402)
    const header = res.headers.get('PAYMENT-REQUIRED')
    const paymentRequired = decodePaymentRequiredHeader(header as string) as unknown as {
      accepts: Array<{ amount?: string }>
    }
    expect(paymentRequired.accepts[0]?.amount).toBe('3000')
  })

  test('GET /v1/attest: 402 before the real handler runs (reviewed, with stored integrity)', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    const res = await app.request('/v1/attest?name=ms&version=2.1.3')
    expect(res.status).toBe(402)
  })

  // X-SPM-Donate: 0 opts into the free partial attestation (SPEC.md §11.2,
  // §12.3, ADR 0006) before the payment gate runs — the gate must never see
  // this request, on either attestation route.
  test('POST /v1/attest/lockfile, X-SPM-Donate: 0: 200 partial, never 402', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-SPM-Donate': '0' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': {
            version: '2.1.3',
            resolved: 'https://registry.npmjs.org/ms/-/ms-2.1.3.tgz',
            integrity: REVIEWED_INTEGRITY,
          },
        },
      }),
    })
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
  })

  test('GET /v1/attest, X-SPM-Donate: 0: 200 partial, never 402', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null, REVIEWED_INTEGRITY)
    const res = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'X-SPM-Donate': '0' },
    })
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
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
      REVIEWED_INTEGRITY,
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
    expect(auditorRow?.amount_micro).toBe(400)

    const earningsRes = await paidApp.request('/api/v1/earnings/github/alice')
    expect(earningsRes.status).toBe(200)
    const earnings = (await earningsRes.json()) as {
      roles: Array<{ role: string; accruedMicro: number }>
    }
    const auditorEarnings = earnings.roles.find((r) => r.role === 'auditor')
    expect(auditorEarnings?.accruedMicro).toBeGreaterThanOrEqual(400)
  })

  // SPEC §11.2, §13.2, ADR 0008: a settled lockfile payment for N reviewed
  // packages ledgers each package's own full 400/100/200/150/100/50 role
  // shares — never a cross-package split — and the accrual sum across all
  // packages equals the exact amount charged.
  test('a settled paid lockfile request accrues 400/100/200/150/100/50 per reviewed package', async () => {
    setStatus('pkg-a', '1.0.0', 'COMMUNITY_REVIEWED', 'ADDR_A', null, REVIEWED_INTEGRITY, 'alice')
    setStatus('pkg-b', '1.0.0', 'COMMUNITY_REVIEWED', 'ADDR_B', null, REVIEWED_INTEGRITY, 'bob')
    setStatus('pkg-c', '1.0.0', 'COMMUNITY_REVIEWED', 'ADDR_C', null, REVIEWED_INTEGRITY, 'carol')

    const lockfileBody = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        'node_modules/pkg-a': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/pkg-a/-/pkg-a-1.0.0.tgz',
          integrity: REVIEWED_INTEGRITY,
        },
        'node_modules/pkg-b': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/pkg-b/-/pkg-b-1.0.0.tgz',
          integrity: REVIEWED_INTEGRITY,
        },
        'node_modules/pkg-c': {
          version: '1.0.0',
          resolved: 'https://registry.npmjs.org/pkg-c/-/pkg-c-1.0.0.tgz',
          integrity: REVIEWED_INTEGRITY,
        },
      },
    })

    const { httpServer: paidHttpServer } = buildHttpServer(
      stubSuccessFacilitatorClient('INTEGRATION-TX-LOCKFILE'),
      FEE_PAYER,
    )
    const paidApp = createApp(paidHttpServer)

    const unpaidRes = await paidApp.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: lockfileBody,
    })
    expect(unpaidRes.status).toBe(402)
    const requiredHeader = unpaidRes.headers.get('PAYMENT-REQUIRED')
    const paymentRequired = decodePaymentRequiredHeader(requiredHeader as string) as unknown as {
      accepts: Array<Record<string, unknown>>
    }
    const accepted = paymentRequired.accepts[0]
    expect(accepted?.amount).toBe('3000')

    const paymentSignature = encodePaymentSignatureHeader({
      x402Version: 2,
      accepted,
      payload: {},
    } as unknown as Parameters<typeof encodePaymentSignatureHeader>[0])

    const paidRes = await paidApp.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'PAYMENT-SIGNATURE': paymentSignature,
      },
      body: lockfileBody,
    })
    expect(paidRes.status).toBe(200)
    expect(paidRes.headers.get('PAYMENT-RESPONSE')).toBeTruthy()

    const accruals = getAccrualsForTxid('INTEGRATION-TX-LOCKFILE')
    expect(accruals).toHaveLength(18) // 6 roles x 3 packages
    expect(accruals.reduce((sum, row) => sum + row.amount_micro, 0)).toBe(3000)

    for (const [pkg, login] of [
      ['pkg-a', 'alice'],
      ['pkg-b', 'bob'],
      ['pkg-c', 'carol'],
    ] as const) {
      const pkgRows = accruals.filter((row) => row.pkg === pkg)
      const byRole = Object.fromEntries(pkgRows.map((row) => [row.role, row]))
      expect(byRole.auditor?.amount_micro).toBe(400)
      expect(byRole.auditor?.identity).toBe(`github:${login}`)
      expect(byRole.contributor?.amount_micro).toBe(100)
      expect(byRole.contributor?.identity).toBe('unassigned')
      expect(byRole.maintainer?.amount_micro).toBe(200)
      expect(byRole.maintainer?.identity).toBe('unassigned')
      expect(byRole.reviewer?.amount_micro).toBe(150)
      expect(byRole.reviewer?.identity).toBe('unassigned')
      expect(byRole.treasury?.amount_micro).toBe(100)
      expect(byRole.treasury?.identity).toBe('unassigned')
      expect(byRole.ops?.amount_micro).toBe(50)
      expect(byRole.ops?.identity).toBe('ops')
    }
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
      REVIEWED_INTEGRITY,
      'carol',
    )

    const { httpServer: paidHttpServer } = buildHttpServer(
      stubSuccessFacilitatorClient('INTEGRATION-TX-TARBALL'),
      FEE_PAYER,
    )
    const paidApp = createApp(paidHttpServer)

    // Opt in to payment — without X-SPM-Donate: 1, the free-tier hook would
    // grant access here instead of returning 402 (ADR 0006, SPEC §10.4).
    const unpaidRes = await paidApp.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'X-SPM-Donate': '1' },
    })
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

    // The retry must also carry X-SPM-Donate: 1 — the hook runs on every
    // request, so without it here the free-tier grant would short-circuit
    // the payment flow and no PAYMENT-RESPONSE header would ever be set.
    const paidRes = await paidApp.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'PAYMENT-SIGNATURE': paymentSignature, 'X-SPM-Donate': '1' },
    })
    expect(paidRes.status).toBe(200)
    expect(paidRes.headers.get('PAYMENT-RESPONSE')).toBeTruthy()

    const accruals = getAccrualsForTxid('INTEGRATION-TX-TARBALL')
    expect(accruals.length).toBeGreaterThan(0)
    expect(accruals.every((row) => row.route === 'tarball')).toBe(true)
    const auditorRow = accruals.find((row) => row.role === 'auditor')
    expect(auditorRow?.identity).toBe('github:carol')
    expect(auditorRow?.amount_micro).toBe(400)
  })

  test('GET /api/v1/earnings/github/:login: 200, never 402, no payment header', async () => {
    const res = await app.request('/api/v1/earnings/github/nobody')
    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
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
