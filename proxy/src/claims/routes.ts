// proxy/src/claims/routes.ts
//
// The earnings ledger's HTTP surface (SPEC.md 5.3):
//   GET  /api/v1/earnings/github/:login  — public, free
//
// This router uses full absolute paths and is meant to be mounted at root
// (`app.route('/', claimsRouter)`), matching how these paths are written in
// the spec.

import { Hono } from 'hono'
import { getEarningsForLogin } from './ledger.js'

/** Build the earnings router. */
export function createClaimsRouter(): Hono {
  const router = new Hono()

  // Public, free — never exposes another identity's data: the login in the
  // path is the only identity this handler ever reads or returns.
  router.get('/api/v1/earnings/github/:login', (c) => {
    const login = c.req.param('login')
    return c.json(getEarningsForLogin(login))
  })

  return router
}
