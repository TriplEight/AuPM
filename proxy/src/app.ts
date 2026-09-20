// proxy/src/app.ts

import type { x402HTTPResourceServer } from '@x402-avm/core/http'
import { paymentMiddlewareFromHTTPServer } from '@x402-avm/hono'
import { Hono } from 'hono'
import type { Attribution } from './attest/attribution.js'
import type { SigningKeyLike } from './attest/dsse.js'
import type { LockfileAnalysis } from './attest/lockfile.js'
import type { RateLimiter } from './attest/ratelimit.js'
import { createGithubClient } from './claims/github.js'
import { claimsLedgerMiddleware } from './claims/middleware.js'
import { createClaimsRouter } from './claims/routes.js'
import { GITHUB_READONLY_TOKEN, getAttestationSigningKey } from './config.js'
import { proxyToNpm } from './proxy.js'
import type { AttestRoutesOptions } from './routes/attest.js'
import { buildAttestRoutes } from './routes/attest.js'
import statusRouter from './routes/status.js'

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
  spmLockfileAnalysis?: LockfileAnalysis
}

export interface CreateAppOptions {
  /** Loads the SPM attestation signing key. Defaults to config.ts's env-backed loader. */
  getSigningKey?: () => Promise<SigningKeyLike>
  /** Rate limiter for the free (zero-coverage) lockfile path. Injectable for tests. */
  rateLimiter?: RateLimiter
  /** Known-good tarball integrity lookup for reviewed packages. Injectable for tests. */
  integrityLookup?: AttestRoutesOptions['integrityLookup']
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

  // Fails cleanly on a thrown error (e.g. claim-proof verification with no
  // GITHUB_READONLY_TOKEN configured) instead of an opaque crash. WARNING:
  // never let this leak a secret; it returns only `err.message`, and the
  // GitHub client (proxy/src/claims/github.ts) never puts a token in one.
  app.onError((err, c) => c.json({ error: err.message }, 500))

  const attest = buildAttestRoutes({
    getSigningKey: options.getSigningKey ?? getAttestationSigningKey,
    rateLimiter: options.rateLimiter,
    integrityLookup: options.integrityLookup,
  })

  // Free, unauthenticated, never gated — the audit-status API. Registered
  // before the payment gate so it terminates the request itself; it is also
  // absent from the x402 route table, so the gate would no-op on it anyway.
  app.route('/api/v1/status', statusRouter)

  // Claims ledger write path (SPEC-v3.md 5.2), registered *before* the
  // payment middleware below so it wraps that middleware's next() call and
  // can read PAYMENT-RESPONSE off the settled response on the way out.
  // CAUTION: order matters — after the payment middleware it never sees the
  // settlement header (see proxy/src/claims/middleware.ts).
  app.use('*', claimsLedgerMiddleware)

  // Claims read/write API — free, never gated. An unpaid contributor must
  // always be able to see what they are owed (CLAUDE.md). Mounted before
  // the payment gate, alongside /api/v1/status above.
  app.route('/', createClaimsRouter(createGithubClient(GITHUB_READONLY_TOKEN)))

  // Pre-payment validation and the lockfile route's zero-coverage free
  // path. Both run — and can fully answer the request — *before* the x402
  // payment gate below, so a malformed lockfile (400) or a zero-coverage
  // lockfile (free 200) never reaches, and is never charged by, the
  // facilitator (CLAUDE.md: unreviewed never returns 402; a caller must
  // never pay for a malformed lockfile).
  app.post('/v1/attest/lockfile', attest.lockfilePreMiddleware)
  app.get('/v1/attest', attest.singleAttestPreMiddleware)

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

  // npm passthrough — reached only once payment (or the free-tier grant) clears.
  app.all('*', (c) => proxyToNpm(c))

  return app
}
