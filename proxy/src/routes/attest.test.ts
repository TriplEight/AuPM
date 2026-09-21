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

// CAUTION: this file gets its own SQLite file via SQLITE_PATH, set before
// the dynamic imports below (same trick as proxy/src/claims/ledger.test.ts).
// Without per-file isolation, vitest's parallel test files race on the same
// physical database and writes from one file can be wiped by another file's
// beforeEach mid-test.
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import algosdk from 'algosdk'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import type { Attribution } from '../attest/attribution.js'
import type { Envelope, Statement } from '../attest/dsse.js'
import { verifyEnvelope } from '../attest/dsse.js'
import { loadSigningKey, type SigningKey } from '../attest/keys.js'
import { LOCKFILE_MAX_BYTES } from '../attest/lockfile.js'
import { createRateLimiter } from '../attest/ratelimit.js'
import type { AttestRoutesOptions } from './attest.js'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-attest-routes-test-${randomUUID()}.db`)

const { default: db } = await import('../db.js')
const { setStatus } = await import('../status.js')
const { buildAttestRoutes } = await import('./attest.js')

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

// Drives app.request() with a distinguishable simulated TCP peer, the way
// @hono/node-server's real getConnInfo() reads one: bindings.incoming.
// socket.remoteAddress (see @hono/node-server/dist/conninfo.mjs). Hono's
// request() forwards its third argument straight through to `c.env`
// (hono-base.js #dispatch -> new Context(..., { env })), so this is not a
// stub of clientIp() itself — it exercises the real getConnInfo() call
// against a fabricated (but shaped exactly like the real thing) env, the
// same route production traffic takes under serve().
function requestWithSocket(
  app: Hono<{ Variables: AppVariables }>,
  input: string,
  remoteAddress: string,
  init?: RequestInit,
) {
  return app.request(input, init, {
    incoming: { socket: { remoteAddress, remotePort: 0, remoteFamily: 'IPv4' } },
  })
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
    // No `reviewer` login stored on the row (only the on-chain `auditor_addr`
    // was set): the auditor identity must be null, never the Algorand
    // address — the ledger keys strictly on `github:<login>` and could never
    // find it under an address (defect: a stranded, unmatchable accrual).
    expect(attribution?.packages).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: null, maintainer: null },
    ])
  })

  test('attribution.auditor is "github:<login>" from the reviewer column, never the auditor_addr', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc', 'alice')
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
    expect(attribution?.packages).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: null },
    ])
    // predicate.packages[].reviewer must carry the same identity, never a
    // raw Algorand address — SPEC-v3 §6.3's lockfile statement shape.
    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    const predicate = statement.predicate as { packages: { reviewer: string | null }[] }
    expect(predicate.packages[0]?.reviewer).toBe('github:alice')
    expect(predicate.packages[0]?.reviewer).not.toBe('AUDITOR_ADDR')
  })
})

describe('POST /v1/attest/lockfile: body size cap', () => {
  // A stream instrumented to record whether anything ever acquired a
  // reader on it — used to prove the oversized-Content-Length path returns
  // before the body is read at all, not merely before it finishes.
  //
  // CAUTION: a ReadableStream's `pull()` fires once automatically, to
  // pre-fill its internal queue, even when nothing ever calls
  // `getReader()` on it — that firing is not evidence anything read the
  // body. `getReader()` — which readLimitedBody() must call to read even
  // one byte — is the real signal.
  function neverReadStream(): { stream: ReadableStream<Uint8Array>; wasRead: () => boolean } {
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(encoder.encode('{}'))
        controller.close()
      },
    })
    let read = false
    const originalGetReader = stream.getReader.bind(stream)
    stream.getReader = ((...args: Parameters<typeof stream.getReader>) => {
      read = true
      return originalGetReader(...args)
    }) as typeof stream.getReader
    return { stream, wasRead: () => read }
  }

  // A stream that emits `totalBytes` across small chunks, and records both
  // how many bytes it actually handed out and whether it was cancelled —
  // used to prove a hard read cap stops mid-stream, never draining a body
  // that has no truthful Content-Length to reject up front.
  function boundedChunkStream(
    totalBytes: number,
    chunkSize = 64 * 1024,
  ): { stream: ReadableStream<Uint8Array>; bytesSent: () => number; wasCancelled: () => boolean } {
    let sent = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= totalBytes) {
          controller.close()
          return
        }
        const size = Math.min(chunkSize, totalBytes - sent)
        controller.enqueue(new Uint8Array(size))
        sent += size
      },
      cancel() {
        cancelled = true
      },
    })
    return { stream, bytesSent: () => sent, wasCancelled: () => cancelled }
  }

  test('an oversized Content-Length is rejected before the body is read', async () => {
    const { app } = buildTestApp()
    const { stream, wasRead } = neverReadStream()
    const init = {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': String(LOCKFILE_MAX_BYTES + 1),
      },
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit

    const res = await app.request('/v1/attest/lockfile', init)

    expect(res.status).toBe(413)
    expect(wasRead()).toBe(false)
  })

  test('a chunked body with no Content-Length exceeding the cap is rejected mid-stream', async () => {
    const { app } = buildTestApp()
    const totalBytes = LOCKFILE_MAX_BYTES + 5 * 1024 * 1024
    const { stream, bytesSent, wasCancelled } = boundedChunkStream(totalBytes)
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit

    const res = await app.request('/v1/attest/lockfile', init)

    expect(res.status).toBe(413)
    // The reader was stopped well short of the full, lying body — never
    // buffered the whole thing before rejecting it.
    expect(bytesSent()).toBeLessThan(totalBytes)
    expect(wasCancelled()).toBe(true)
  })

  test('a small declared Content-Length that understates the real body is still rejected', async () => {
    const { app } = buildTestApp()
    const totalBytes = LOCKFILE_MAX_BYTES + 5 * 1024 * 1024
    const { stream, bytesSent, wasCancelled } = boundedChunkStream(totalBytes)
    const init = {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': '10' },
      body: stream,
      duplex: 'half',
    } as unknown as RequestInit

    const res = await app.request('/v1/attest/lockfile', init)

    expect(res.status).toBe(413)
    expect(bytesSent()).toBeLessThan(totalBytes)
    expect(wasCancelled()).toBe(true)
  })

  test('a malformed body within the size cap still returns 400, not 413', async () => {
    const { app } = buildTestApp()
    const res = await app.request('/v1/attest/lockfile', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{ not json',
    })
    expect(res.status).toBe(400)
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
    // No `reviewer` login stored (only auditor_addr): auditor must be null,
    // never the Algorand address the ledger cannot key on.
    expect(attribution?.packages).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: null, maintainer: null },
    ])
  })

  test('attribution.auditor and predicate.reviewer are "github:<login>", never the auditor_addr', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc', 'bob')
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest?name=ms&version=2.1.3')

    expect(res.status).toBe(200)
    const attribution = getAttribution()
    expect(attribution?.packages).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'github:bob', maintainer: null },
    ])
    const body = (await res.json()) as { attestation: Envelope }
    const statement = decodeStatement(body.attestation)
    const predicate = statement.predicate as { packages: { reviewer: string | null }[] }
    expect(predicate.packages[0]?.reviewer).toBe('github:bob')
    expect(predicate.packages[0]?.reviewer).not.toBe('AUDITOR_ADDR')
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

// A paid-tier row can carry a legacy sha1- integrity from before this route
// only spoke sha512-. isReviewedWithIntegrity() (status.ts) only checks for
// a non-null integrity, so it alone would still advertise this row as paid
// — and the paid handler would then always throw decoding it, charging the
// caller for a 500. Pins that the two agree: unusable integrity resolves to
// UNREVIEWED, same as a missing one.
describe('GET /v1/attest: integrity-format gating', () => {
  test('a row with sha1- integrity is not advertised as paid, and the route does not throw', async () => {
    setStatus('legacy-pkg', '1.0.0', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha1-deadbeef')
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest?name=legacy-pkg&version=1.0.0')

    expect(res.status).toBe(200)
    expect(res.status).not.toBe(500)
    const body = (await res.json()) as { tier: string; attestation: Envelope }
    expect(body.tier).toBe('UNREVIEWED')
    const ok = await verifyEnvelope(body.attestation, [
      { keyid: signingKey.keyid, publicKey: signingKey.publicKey },
    ])
    expect(ok).toBe(true)
    expect(getAttribution()).toEqual({ route: 'single-attest', priceMicro: 0, packages: [] })
  })

  test('a row with sha512- integrity still prices and still returns a signed statement', async () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc')
    const { app, getAttribution } = buildTestApp()

    const res = await app.request('/v1/attest?name=ms&version=2.1.3')

    expect(res.status).toBe(200)
    const body = (await res.json()) as { tier: string; attestation: Envelope }
    expect(body.tier).toBe('COMMUNITY_REVIEWED')
    const ok = await verifyEnvelope(body.attestation, [
      { keyid: signingKey.keyid, publicKey: signingKey.publicKey },
    ])
    expect(ok).toBe(true)
    expect(getAttribution()).toEqual({
      route: 'single-attest',
      priceMicro: 1_000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: null, maintainer: null }],
    })
  })
})

// Boundary test between this route and the free-tier rate limiter: a
// spoofable HTTP header must never be able to raise the cap. Pins the
// TRUST_PROXY gate (defect: X-Forwarded-For trusted unconditionally, so an
// attacker sending a fresh value on every request defeated the limiter that
// is the stated control against using the free path as an unpriced signing
// oracle).
describe('free-path rate limit: X-Forwarded-For trust boundary', () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY
  })

  test('TRUST_PROXY unset: a different X-Forwarded-For on every request never raises the cap', async () => {
    delete process.env.TRUST_PROXY
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }) })

    const spoofedIps = ['198.51.100.1', '198.51.100.2', '198.51.100.3']
    const statuses: number[] = []
    for (const ip of spoofedIps) {
      const res = await app.request('/v1/attest?name=ms&version=2.1.3', {
        headers: { 'x-forwarded-for': ip },
      })
      statuses.push(res.status)
    }

    // All three requests collapse onto the same (untrusted) bucket, so the
    // cap of 2 is enforced regardless of the spoofed header value.
    expect(statuses).toEqual([200, 200, 429])
  })

  test('TRUST_PROXY=true: distinct trusted client IPs get independent caps', async () => {
    process.env.TRUST_PROXY = 'true'
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) })

    const first = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': '203.0.113.50' },
    })
    const second = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': '203.0.113.51' },
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })

  test('TRUST_PROXY=true: a multi-hop header takes the rightmost (proxy-appended) entry, never the leftmost', async () => {
    process.env.TRUST_PROXY = 'true'
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) })

    // The leftmost entry is attacker-supplied; only the last hop was
    // appended by the trusted proxy itself.
    const first = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': 'attacker-controlled, 203.0.113.99' },
    })
    expect(first.status).toBe(200)

    // A second request with a different attacker-supplied leftmost entry,
    // but the same trusted rightmost hop, must hit the same bucket.
    const second = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': 'different-attacker-value, 203.0.113.99' },
    })
    expect(second.status).toBe(429)
  })
})

// Boundary test for the same reason, pinned separately for X-Real-IP: a
// prior fix gated X-Forwarded-For behind TRUST_PROXY but left X-Real-IP
// trusted unconditionally, letting a caller rotate it for unlimited free
// signed attestations. clientIp() must decide both headers together.
describe('free-path rate limit: X-Real-IP trust boundary', () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY
  })

  test('TRUST_PROXY unset: a different X-Real-IP on every request never raises the cap', async () => {
    delete process.env.TRUST_PROXY
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }) })

    const spoofedIps = ['198.51.100.11', '198.51.100.12', '198.51.100.13']
    const statuses: number[] = []
    for (const ip of spoofedIps) {
      const res = await app.request('/v1/attest?name=ms&version=2.1.3', {
        headers: { 'x-real-ip': ip },
      })
      statuses.push(res.status)
    }

    // All three requests collapse onto the same (untrusted) bucket, so the
    // cap of 2 is enforced regardless of the spoofed header value.
    expect(statuses).toEqual([200, 200, 429])
  })

  test('TRUST_PROXY=true: distinct X-Real-IP values get independent caps', async () => {
    process.env.TRUST_PROXY = 'true'
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) })

    const first = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-real-ip': '203.0.113.60' },
    })
    const second = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-real-ip': '203.0.113.61' },
    })
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })

  test('TRUST_PROXY=true, both headers present: X-Forwarded-For wins over X-Real-IP', async () => {
    process.env.TRUST_PROXY = 'true'
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) })

    // Same X-Forwarded-For, a different X-Real-IP each time: must collapse
    // onto the same bucket, pinning X-Forwarded-For's trusted last hop as
    // the winner when both headers are present.
    const first = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': '203.0.113.77', 'x-real-ip': '198.51.100.1' },
    })
    expect(first.status).toBe(200)

    const second = await app.request('/v1/attest?name=ms&version=2.1.3', {
      headers: { 'x-forwarded-for': '203.0.113.77', 'x-real-ip': '198.51.100.2' },
    })
    expect(second.status).toBe(429)
  })
})

// Regression test for a second-pass defect: gating both headers behind
// TRUST_PROXY made every untrusted caller collapse onto one shared bucket,
// trading the header-spoofing bypass for a denial of service (one caller
// exhausting the cap blocked the free path for everyone). clientIp() must
// fall back to the unspoofable socket address, not a shared constant, while
// a socket address is available.
describe('free-path rate limit: socket-address fallback (TRUST_PROXY unset)', () => {
  afterEach(() => {
    delete process.env.TRUST_PROXY
  })

  test('two callers on different socket addresses get independent buckets', async () => {
    delete process.env.TRUST_PROXY
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 1 }) })

    // Caller A exhausts its own cap.
    const a1 = await requestWithSocket(app, '/v1/attest?name=ms&version=2.1.3', '203.0.113.201')
    expect(a1.status).toBe(200)
    const a2 = await requestWithSocket(app, '/v1/attest?name=ms&version=2.1.3', '203.0.113.201')
    expect(a2.status).toBe(429)

    // Caller B, a distinct socket address, is unaffected by A's exhausted
    // cap: one caller must never be able to deny the free path to another.
    const b1 = await requestWithSocket(app, '/v1/attest?name=ms&version=2.1.3', '203.0.113.202')
    expect(b1.status).toBe(200)
  })

  test('a rotating X-Real-IP from one socket address still never raises that socket’s cap', async () => {
    delete process.env.TRUST_PROXY
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }) })

    const spoofedIps = ['198.51.100.21', '198.51.100.22', '198.51.100.23']
    const statuses: number[] = []
    for (const ip of spoofedIps) {
      const res = await requestWithSocket(
        app,
        '/v1/attest?name=ms&version=2.1.3',
        '203.0.113.210',
        {
          headers: { 'x-real-ip': ip },
        },
      )
      statuses.push(res.status)
    }

    // The header is ignored entirely (TRUST_PROXY unset); every request
    // shares the one real socket's bucket, so the cap of 2 is enforced.
    expect(statuses).toEqual([200, 200, 429])
  })

  test('no socket address available: the handler does not throw', async () => {
    delete process.env.TRUST_PROXY
    const { app } = buildTestApp({ rateLimiter: createRateLimiter({ windowMs: 60_000, max: 2 }) })

    // app.request() with no injected env: getConnInfo() throws internally,
    // caught by socketAddress(), falling back to the shared constant.
    const res = await app.request('/v1/attest?name=ms&version=2.1.3')

    expect(res.status).toBe(200)
    expect(res.status).not.toBe(500)
  })
})
