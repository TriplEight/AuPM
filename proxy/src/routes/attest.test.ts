// proxy/src/routes/attest.test.ts
//
// Exercises buildAttestRoutes()'s pre-middlewares and paid handlers directly,
// chained in one Hono route registration per route (pre-middleware, then
// handler) — the same composition app.ts uses around the real x402 payment
// gate, minus the gate itself. That lets these tests assert on the
// attestation logic this work item owns without fabricating a signed AVM
// payment payload, which is the real gate's job and out of this file's
// scope (see proxy/src/app.test.ts and proxy/src/x402/server.test.ts for
// gate-ordering coverage).

import { createHash } from 'node:crypto'
import algosdk from 'algosdk'
import { Hono } from 'hono'
import { beforeEach, describe, expect, test } from 'vitest'
import type { Attribution } from '../attest/attribution.js'
import type { Envelope, Statement } from '../attest/dsse.js'
import { verifyEnvelope } from '../attest/dsse.js'
import { loadSigningKey, type SigningKey } from '../attest/keys.js'
import { createRateLimiter } from '../attest/ratelimit.js'
import db from '../db.js'
import { setStatus } from '../status.js'
import { type AttestRoutesOptions, buildAttestRoutes } from './attest.js'

type AppVariables = {
  attribution?: Attribution
}

const encoder = new TextEncoder()

function npmEntry(version: string, integrity = 'sha512-abc') {
  return {
    version,
    resolved: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`,
    integrity,
  }
}

function decodeStatement(envelope: Envelope): Statement {
  return JSON.parse(new TextDecoder().decode(algosdk.base64ToBytes(envelope.payload))) as Statement
}

let signingKey: SigningKey

beforeEach(async () => {
  db.exec('DELETE FROM audit_status')
  signingKey = await loadSigningKey(crypto.getRandomValues(new Uint8Array(32)))
})

function buildTestApp(options: Partial<AttestRoutesOptions> = {}) {
  const attest = buildAttestRoutes({
    getSigningKey: options.getSigningKey ?? (async () => signingKey),
    rateLimiter: options.rateLimiter,
    integrityLookup: options.integrityLookup,
  })

  let capturedAttribution: Attribution | undefined
  const app = new Hono<{ Variables: AppVariables }>()

  app.use('/v1/attest/lockfile', async (c, next) => {
    await next()
    capturedAttribution = c.get('attribution')
  })
  app.post('/v1/attest/lockfile', attest.lockfilePreMiddleware, attest.lockfileHandler)

  app.use('/v1/attest', async (c, next) => {
    await next()
    capturedAttribution = c.get('attribution')
  })
  app.get('/v1/attest', attest.singleAttestPreMiddleware, attest.singleAttestHandler)

  return { app, getAttribution: () => capturedAttribution }
}

describe('POST /v1/attest/lockfile', () => {
  test('a lockfile with at least one reviewed package returns an envelope that verifies', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc')
    const { app } = buildTestApp()

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3') },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { summary: unknown; attestation: Envelope }
    const ok = await verifyEnvelope(body.attestation, [
      { keyid: signingKey.keyid, publicKey: signingKey.publicKey },
    ])
    expect(ok).toBe(true)
  })

  test('predicate.packages excludes unreviewed entries: 1 reviewed + 200 unreviewed', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc')
    const packages: Record<string, unknown> = { 'node_modules/ms': npmEntry('2.1.3') }
    for (let i = 0; i < 200; i++) {
      packages[`node_modules/unreviewed-pkg-${i}`] = npmEntry('1.0.0')
    }
    const { app } = buildTestApp()

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lockfileVersion: 3, packages }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      summary: { reviewed: number; unreviewed: number }
      attestation: Envelope
    }
    expect(body.summary.unreviewed).toBe(200)
    const statement = decodeStatement(body.attestation)
    const predicate = statement.predicate as { packages: unknown[] }
    expect(predicate.packages).toHaveLength(1)
  })

  test('predicate.absentMeans equals UNREVIEWED', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null)
    const { app } = buildTestApp()

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3') },
      }),
    })

    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    const predicate = statement.predicate as { absentMeans: string }
    expect(predicate.absentMeans).toBe('UNREVIEWED')
  })

  test('a zero-coverage lockfile returns 200 with no 402 and no payment header', async () => {
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3') },
      }),
    })

    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull()
    const body = (await res.json()) as { attestation: Envelope }
    expect(body.attestation).toBeDefined()
    expect(getAttribution()).toEqual({ route: 'lockfile', priceMicro: 0, packages: [] })
  })

  test('a malformed lockfile (bad JSON) returns 400 without settlement', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    expect(res.status).toBe(400)
  })

  test('lockfileVersion 1 returns 400', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lockfileVersion: 1, packages: {} }),
    })
    expect(res.status).toBe(400)
  })

  test('more than 10,000 entries returns 400', async () => {
    const packages: Record<string, unknown> = {}
    for (let i = 0; i < 10_001; i++) {
      packages[`node_modules/pkg${i}`] = npmEntry('1.0.0')
    }
    const { app } = buildTestApp()
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ lockfileVersion: 3, packages }),
    })
    expect(res.status).toBe(400)
  })

  test('an integrity mismatch reports tier INTEGRITY_MISMATCH, never COMMUNITY_REVIEWED', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null)
    setStatus('tampered', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const { app } = buildTestApp({
      integrityLookup: (pkg, version) =>
        pkg === 'tampered' && version === '1.0.0' ? 'sha512-known-good' : null,
    })

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3'),
          'node_modules/tampered': npmEntry('1.0.0', 'sha512-tampered-hash'),
        },
      }),
    })

    expect(res.status).toBe(200)
    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    const predicate = statement.predicate as {
      packages: { name: string; tier: string }[]
    }
    const tampered = predicate.packages.find((p) => p.name === 'tampered')
    expect(tampered?.tier).toBe('INTEGRITY_MISMATCH')
    expect(tampered?.tier).not.toBe('COMMUNITY_REVIEWED')
  })

  test('a git resolved entry reports UNRESOLVABLE', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null)
    const { app } = buildTestApp()

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3'),
          'node_modules/gitdep': {
            version: '1.0.0',
            resolved: 'git+https://github.com/example/gitdep.git#abc',
          },
        },
      }),
    })

    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    const predicate = statement.predicate as { packages: { name: string; tier: string }[] }
    expect(predicate.packages.find((p) => p.name === 'gitdep')?.tier).toBe('UNRESOLVABLE')
  })

  test('subject sha256 equals the sha256 of the exact request body bytes', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', null, null)
    const { app } = buildTestApp()
    const bodyString = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/ms': npmEntry('2.1.3') },
    })

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: bodyString,
    })

    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    const expected = createHash('sha256').update(encoder.encode(bodyString)).digest('hex')
    expect(statement.subject[0]?.digest.sha256).toBe(expected)
  })

  test('the free path returns 429 after the configured cap', async () => {
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) })
    const zeroCoverageBody = JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/ms': npmEntry('2.1.3') },
    })

    const first = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: zeroCoverageBody,
    })
    expect(first.status).toBe(200)

    const second = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.9' },
      body: zeroCoverageBody,
    })
    expect(second.status).toBe(429)
  })

  test('a paid response sets attribution with the correct priceMicro and reviewed packages', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc')
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3') },
      }),
    })

    expect(res.status).toBe(200)
    const attribution = getAttribution()
    expect(attribution).toBeDefined()
    expect(attribution?.route).toBe('lockfile')
    expect(attribution?.priceMicro).toBe(20_000)
    expect(attribution?.packages).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'AUDITOR_ADDR', maintainer: null },
    ])
  })
})

describe('GET /v1/attest', () => {
  test('parses a scoped package name from query params', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/v1/attest?name=@babel/core&version=7.25.2')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    expect(statement.subject[0]?.name).toBe('pkg:npm/@babel/core@7.25.2')
  })

  test('missing query params return 400', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/v1/attest?name=ms')
    expect(res.status).toBe(400)
  })

  test('a paid response sets attribution for the single-attest route', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc')
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest?name=ms&version=2.1.3')

    expect(res.status).toBe(200)
    const attribution = getAttribution()
    expect(attribution?.route).toBe('single-attest')
    expect(attribution?.priceMicro).toBe(1_000)
    expect(attribution?.packages).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'AUDITOR_ADDR', maintainer: null },
    ])
  })

  test('the subject digest equals the lowercase hex decoding of the stored integrity, computed independently', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc')
    const { app } = buildTestApp()

    const res = await app.request('/v1/attest?name=ms&version=2.1.3')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    // Independently computed: decode the base64 half of "sha512-abc" to hex,
    // never against attest.ts's own integrityToHex() output.
    const expectedHex = Buffer.from('abc', 'base64').toString('hex')
    expect(statement.subject[0]?.digest.sha512).toBe(expectedHex)
    expect(statement.subject[0]?.digest.sha512).not.toBe('')
  })

  test('an UNREVIEWED package returns 200, not 402, with a signed attestation and no attribution price', async () => {
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest?name=ms&version=2.1.3')

    expect(res.status).toBe(200)
    expect(res.status).not.toBe(402)
    expect(res.headers.get('PAYMENT-REQUIRED')).toBeNull()
    expect(res.headers.get('PAYMENT-RESPONSE')).toBeNull()
    const body = (await res.json()) as { tier: string; attestation: Envelope }
    expect(body.tier).toBe('UNREVIEWED')
    const ok = await verifyEnvelope(body.attestation, [
      { keyid: signingKey.keyid, publicKey: signingKey.publicKey },
    ])
    expect(ok).toBe(true)
    expect(getAttribution()).toEqual({ route: 'single-attest', priceMicro: 0, packages: [] })
  })

  test('a paid-tier row with no stored integrity is treated as UNREVIEWED, never charged', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1')
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest?name=ms&version=2.1.3')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { tier: string }
    expect(body.tier).toBe('UNREVIEWED')
    expect(getAttribution()).toEqual({ route: 'single-attest', priceMicro: 0, packages: [] })
  })

  test('the free path returns 429 after the configured cap', async () => {
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) })

    const first = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    })
    expect(first.status).toBe(200)

    const second = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': '203.0.113.10' },
    })
    expect(second.status).toBe(429)
  })
})
