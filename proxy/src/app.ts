// proxy/src/app.ts

import { readFileSync } from 'node:fs'
import * as ed from '@noble/ed25519'
import type { x402HTTPResourceServer } from '@x402-avm/core/http'
import { paymentMiddlewareFromHTTPServer } from '@x402-avm/hono'
import { Hono } from 'hono'
import type { Attribution } from './attest/attribution.js'
import type { SigningKeyLike } from './attest/dsse.js'
import { publishedKeys } from './attest/keys.js'
import type { LockfileAnalysis } from './attest/lockfile.js'
import type { RateLimiter } from './attest/ratelimit.js'
import { claimsLedgerMiddleware } from './claims/middleware.js'
import { createClaimsRouter } from './claims/routes.js'
import { ATTEST_SIGNING_KEY_VALID_FROM, getAttestationSigningKey, ISSUER } from './config.js'
import { buildLlmsTxt, buildX402Descriptor } from './discovery.js'
import { buildFrontPage } from './front-page.js'
import { proxyToNpm } from './proxy.js'
import type { AttestRoutesOptions } from './routes/attest.js'
import { buildAttestRoutes } from './routes/attest.js'
import contractRouter from './routes/contract.js'
import healthRouter from './routes/health.js'
import reviewsRouter from './routes/reviews.js'
import statusRouter from './routes/status.js'
import { getStatusOrUnreviewed, isFree, reviewerIdentity } from './status.js'
import {
  DEFAULT_MULTIPLIER_TENTHS,
  MULTIPLIER_HEADER,
  PRICE_PER_REVIEWED_PACKAGE_MICRO,
  parseMultiplier,
  priceReceipt,
} from './x402/multiplier.js'
import { OG_DESCRIPTION } from './x402/routes.js'
import { isTarballPath, parseTarballPath, tarballMultiplierGuard } from './x402/tarball.js'

export type AppVariables = {
  settlementTxid?: string
  // Set on every paid attest response, before returning (see
  // proxy/src/attest/attribution.ts). claimsLedgerMiddleware reads this off
  // the context after next(), from a middleware registered outside (before,
  // in app.use() order) the payment gate — so it still wraps the gate's own
  // next() call and observes the settled response.
  attribution?: Attribution
  // Internal: the lockfile pre-middleware's parsed classification, handed
  // to the paid handler once payment clears, so the request body — already
  // consumed while computing this — is never re-read or re-parsed.
  aupmLockfileAnalysis?: LockfileAnalysis
  // Internal: set on an empty lockfile body so the gate prices the 402.
  aupmEmptyRequest?: boolean
}

export interface CreateAppOptions {
  /** Loads the AuPM attestation signing key. Defaults to config.ts's env-backed loader. */
  getSigningKey?: () => Promise<SigningKeyLike>
  /** Rate limiter for the free (zero-coverage) lockfile path. Injectable for tests. */
  rateLimiter?: RateLimiter
  /** Rate limiter for every lockfile attestation request, paid or free. Injectable for tests. */
  lockfileRequestRateLimiter?: RateLimiter
  /** Known-good tarball integrity lookup for reviewed packages. Injectable for tests. */
  integrityLookup?: AttestRoutesOptions['integrityLookup']
  /** Replaces the worker-thread parser for pnpm-lock.yaml and yarn.lock. Injectable for tests. */
  yamlParser?: AttestRoutesOptions['yamlParser']
}

/**
 * Build the Hono app from an already-wired x402HTTPResourceServer. Pure
 * wiring, no I/O — this is what tests call directly with a stub-backed
 * httpServer so no test ever reaches the network.
 */
export function createApp(
  httpServer: x402HTTPResourceServer,
  options: CreateAppOptions = {},
): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()

  // Fails cleanly on a thrown error instead of an opaque crash. WARNING:
  // never return `err.message` to the client — a SQLite error can carry the
  // database path. Log the error server-side and return a fixed message.
  app.onError((err, c) => {
    console.error('[aupm] request failed —', err)
    return c.json({ error: 'internal error' }, 500)
  })

  const attest = buildAttestRoutes({
    getSigningKey: options.getSigningKey ?? getAttestationSigningKey,
    rateLimiter: options.rateLimiter,
    lockfileRequestRateLimiter: options.lockfileRequestRateLimiter,
    integrityLookup: options.integrityLookup,
    yamlParser: options.yamlParser,
  })

  // Free, unauthenticated, never gated — the audit-status API. Registered
  // before the payment gate so it terminates the request itself; it is also
  // absent from the x402 route table, so the gate would no-op on it anyway.
  app.route('/api/v1/status', statusRouter)

  // Free, unauthenticated, never gated — the nightly job's own health
  // (item N1.6). Registered before the payment gate for the same
  // reason as statusRouter above; absent from the x402 route table, so the
  // gate would no-op on it anyway.
  app.route('/api/v1/health', healthRouter)

  // Free, unauthenticated, never gated — the public contract coordinates and
  // one auditor's recorded reviews, for the auditor CLI. Same placement
  // reasoning as statusRouter above; both are absent from the x402 route table.
  app.route('/api/v1/contract', contractRouter)
  app.route('/api/v1/reviews', reviewsRouter)

  // Free, unauthenticated, never gated — the published attestation public
  // keys. A verifier needs this to check a DSSE envelope
  // offline; without it, offline verification only works for someone who
  // already holds the key out of band. WARNING: this route must never
  // return 402 — a verifier fetching a public key must never pay
  // Registered before the payment gate for that reason.
  app.get('/.well-known/aupm-keys.json', async (c) => {
    const getSigningKey = options.getSigningKey ?? getAttestationSigningKey
    // Throws when no signing key is configured; app.onError above turns
    // that into a clear { error } response, never a placeholder key.
    const key = await getSigningKey()
    const publicKey = await ed.getPublicKeyAsync(key.seed)
    const keys = publishedKeys([
      { keyid: key.keyid, publicKey, validFrom: ATTEST_SIGNING_KEY_VALID_FROM, validUntil: null },
    ])
    // The key list changes only on rotation, so it is safe to cache.
    c.header('cache-control', 'public, max-age=3600')
    return c.json(keys)
  })

  // Free, never gated, never ledgered: the front page, its og image and its
  // site icons carry the tags for the Bazaar merchant card. WARNING: these
  // routes must never return 402 and never reach the npm passthrough. Hono
  // answers HEAD from the GET handler. The image and icon paths under
  // /.well-known start with a dot, so no npm package name can collide with
  // them. favicon.ico is on the npm package-name blocklist.
  const frontPage = buildFrontPage(ISSUER, OG_DESCRIPTION)
  app.get('/', (c) => c.html(frontPage))
  const staticAssets = [
    ['/.well-known/aupm-og.png', 'og-image.png', 'image/png'],
    ['/favicon.ico', 'favicon.ico', 'image/x-icon'],
    ['/.well-known/aupm-icon.svg', 'icon.svg', 'image/svg+xml'],
    ['/.well-known/aupm-apple-touch-icon.png', 'apple-touch-icon.png', 'image/png'],
  ] as const
  for (const [route, file, contentType] of staticAssets) {
    const bytes = readFileSync(new URL(`./assets/${file}`, import.meta.url))
    app.get(route, (c) => {
      c.header('cache-control', 'public, max-age=86400')
      return c.body(bytes, 200, { 'content-type': contentType })
    })
  }

  // Free discovery documents, built once at start like the front page. They
  // list the paid routes from the route config. WARNING: they must never
  // return 402 and never reach the npm passthrough. `llms.txt` is a valid
  // npm package name. No such package exists today. This route shadows it.
  const x402Descriptor = buildX402Descriptor()
  const llmsTxt = buildLlmsTxt()
  app.get('/.well-known/x402', (c) => {
    c.header('cache-control', 'public, max-age=3600')
    return c.json(x402Descriptor)
  })
  app.get('/llms.txt', (c) => {
    c.header('cache-control', 'public, max-age=3600')
    return c.body(llmsTxt, 200, { 'content-type': 'text/markdown; charset=utf-8' })
  })

  // Claims ledger write path, registered *before* the
  // payment middleware below so it wraps that middleware's next() call and
  // can read PAYMENT-RESPONSE off the settled response on the way out.
  // CAUTION: order matters — after the payment middleware it never sees the
  // settlement header (see proxy/src/claims/middleware.ts).
  app.use('*', claimsLedgerMiddleware)

  // Earnings read API — free, never gated. An unpaid contributor must
  // always be able to see what they are owed. Mounted before
  // the payment gate, alongside /api/v1/status above.
  app.route('/', createClaimsRouter())

  // Pre-payment validation and the lockfile route's zero-coverage free
  // path. Both run — and can fully answer the request — *before* the x402
  // payment gate below, so a malformed lockfile (400) or a zero-coverage
  // lockfile (free 200) never reaches, and is never charged by, the
  // facilitator (unreviewed never returns 402; a caller must
  // never pay for a malformed lockfile).
  app.post('/v1/attest/lockfile', attest.lockfilePreMiddleware)
  app.get('/v1/attest', attest.singleAttestPreMiddleware)
  app.use('*', tarballMultiplierGuard)

  // x402 payment gate, registered *before* the paid attest handlers and the
  // npm passthrough below: for a configured paid route, the middleware
  // returns 402 (or grants access via the tarball free-tier hook in
  // proxy/src/x402/tarball.ts) and only calls next() once that clears — the
  // handler after it never runs for an unpaid request. Routes outside the
  // x402 route table (status, and anything the proxy passes through) are
  // untouched: requiresPayment() is false for them, so the gate is a no-op.
  app.use('*', paymentMiddlewareFromHTTPServer(httpServer))

  // Paid attest handlers — reached only once payment clears. The lockfile
  // pre-middleware above only calls next() (reaching the gate, then this
  // handler) when the lockfile has at least one reviewed package; it
  // answers the zero-coverage case itself, earlier in the chain.
  app.post('/v1/attest/lockfile', attest.lockfileHandler)
  app.get('/v1/attest', attest.singleAttestHandler)

  // AuPM's own namespaces never fall through to npm. The lockfile route is
  // POST-only; any other method gets a 405 that says what the route does.
  // Any other unmatched /v1/ or /api/ path gets AuPM's own 404. A tarball
  // path stays with the passthrough below: "v1" and "api" are npm package
  // names, so /v1/-/v1-1.0.0.tgz is a real npm path.
  app.all('/v1/attest/lockfile', (c) => {
    c.header('Allow', 'POST')
    return c.json(
      {
        error: 'method not allowed',
        message:
          'POST a package-lock.json, pnpm-lock.yaml or yarn.lock (v1) body to this route. It returns one signed attestation ' +
          'for every package in the lockfile.',
      },
      405,
    )
  })
  app.all('*', async (c, next) => {
    const path = c.req.path
    const inOwnNamespace = path.startsWith('/v1/') || path.startsWith('/api/')
    if (inOwnNamespace && !isTarballPath(path)) return c.json({ error: 'not found' }, 404)
    return next()
  })

  // npm passthrough — reached only once payment (or the free-tier grant)
  // clears. A tarball path reaching here is either the free-tier grant (an
  // unreviewed version, or a reviewed version the request did not opt in to
  // pay for, via proxy/src/x402/tarball.ts's onProtectedRequest hook) or a
  // cleared payment (a reviewed version requested with X-AuPM-Donate: 1) —
  // never an unpaid request that opted in; the x402 gate above never calls
  // next() for that case. Set attribution here so claimsLedgerMiddleware,
  // which wraps the gate's next() call, can write the tarball route's
  // accruals (every paid request is ledgered; the free path sets
  // priceMicro: 0, per the Attribution contract in
  // proxy/src/attest/attribution.ts).
  app.all('*', async (c) => {
    if (!isTarballPath(c.req.path)) return proxyToNpm(c)

    const { name, version } = parseTarballPath(c.req.path)
    const status = getStatusOrUnreviewed(name, version)

    // A reviewed tarball reaches this handler two ways: the free-tier grant
    // (the request did not opt in with X-AuPM-Donate: 1) or a cleared
    // payment (it did, and the gate above already settled it). The
    // request's own donate header says which happened — the
    // tarballFreeTierHook in proxy/src/x402/tarball.ts reads the identical
    // header the same way.
    const donatedForPaidTier = !isFree(status.status) && c.req.header('X-AuPM-Donate') === '1'

    // The multiplier guard above already rejected a bad value on the paid path.
    const tenths = parseMultiplier(c.req.header(MULTIPLIER_HEADER)) ?? DEFAULT_MULTIPLIER_TENTHS
    const price = priceReceipt(1, tenths)

    c.set(
      'attribution',
      donatedForPaidTier
        ? {
            route: 'tarball',
            priceMicro: price.totalMicro,
            packages: [{ pkg: name, version, auditor: reviewerIdentity(status) }],
          }
        : { route: 'tarball', priceMicro: 0, packages: [] },
    )

    // proxyToNpm returns a fresh Response built from the upstream registry's
    // own headers (never from this context's c.header() calls), so the tier
    // and donate-hint headers are added here, to the actual returned
    // Response, not via c.header() — a call before this point would be
    // silently discarded once this handler returns a different Response
    // object.
    const upstream = await proxyToNpm(c)
    const headers = new Headers(upstream.headers)
    headers.set('X-AuPM-Tier', status.status)
    if (!isFree(status.status) && !donatedForPaidTier) {
      headers.set('X-AuPM-Donate-Hint', String(PRICE_PER_REVIEWED_PACKAGE_MICRO))
    }
    if (donatedForPaidTier) {
      headers.set('X-AuPM-Price-Base', String(price.baseMicro))
      headers.set('X-AuPM-Multiplier', String(price.multiplierTenths))
      headers.set('X-AuPM-Price-Total', String(price.totalMicro))
    }
    return new Response(upstream.body, { status: upstream.status, headers })
  })

  return app
}
