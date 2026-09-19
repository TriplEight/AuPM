// proxy/src/app.ts

import type { x402HTTPResourceServer } from '@x402-avm/core/http'
import { paymentMiddlewareFromHTTPServer } from '@x402-avm/hono'
import { Hono } from 'hono'
import { proxyToNpm } from './proxy.js'
import statusRouter from './routes/status.js'
import { boot } from './x402/server.js'

type AppVariables = {
  settlementTxid?: string
}

/**
 * Build the Hono app from an already-wired x402HTTPResourceServer. Pure
 * wiring, no I/O — this is what tests call directly with a stub-backed
 * httpServer so no test ever reaches the network.
 */
export function createApp(httpServer: x402HTTPResourceServer): Hono<{ Variables: AppVariables }> {
  const app = new Hono<{ Variables: AppVariables }>()

  // Free, unauthenticated, never gated — the audit-status API. Registered
  // before the payment gate so it terminates the request itself; it is also
  // absent from the x402 route table, so the gate would no-op on it anyway.
  app.route('/api/v1/status', statusRouter)

  // x402 payment gate, registered *before* the attest stub handlers and the
  // npm passthrough below: for a configured paid route, the middleware
  // returns 402 (or grants access via the tarball free-tier hook in
  // proxy/src/x402/tarball.ts) and only calls next() once that clears — the
  // handler after it never runs for an unpaid request. Routes outside the
  // x402 route table (status, and anything the proxy passes through) are
  // untouched: requiresPayment() is false for them, so the gate is a no-op.
  app.use('*', paymentMiddlewareFromHTTPServer(httpServer))

  // ---- Mount point for later work items ----
  // TODO(attestation-signing item): replace these stubs by mounting
  // proxy/src/routes/attest.ts here for POST /v1/attest/lockfile and
  // GET /v1/attest, once DSSE signing lands.
  // TODO(claims-ledger item): mount the claims middleware here, registered
  // *after* the payment middleware's next(), so it can read PAYMENT-RESPONSE
  // off the response and write accruals.

  // Temporary stub handlers for the paid attest routes so the 402 path is
  // testable now. Real handlers ship in the attestation-signing work item.
  app.post('/v1/attest/lockfile', (c) =>
    c.json({ error: 'not implemented: ships in the attestation-signing work item' }, 501),
  )
  app.get('/v1/attest', (c) =>
    c.json({ error: 'not implemented: ships in the attestation-signing work item' }, 501),
  )

  // npm passthrough — reached only once payment (or the free-tier grant) clears.
  app.all('*', (c) => proxyToNpm(c))

  return app
}

// Production entrypoint, imported by proxy/src/index.ts (`app.fetch`).
//
// The facilitator boot (HTTPFacilitatorClient.getSupported(), a network
// call) is deferred to the first incoming request rather than run at
// module-load time. That keeps `import './app.js'` network-free, which is
// what lets proxy/src/app.test.ts and proxy/src/x402/*.test.ts import this
// module and use createApp() with a stubbed facilitator client without ever
// touching the network.
let bootPromise: ReturnType<typeof boot> | undefined

const app = new Hono<{ Variables: AppVariables }>()
app.use('*', async (c) => {
  bootPromise ??= boot()
  const { httpServer } = await bootPromise
  return createApp(httpServer).fetch(c.req.raw)
})

export default app
