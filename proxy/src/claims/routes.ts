// proxy/src/claims/routes.ts
//
// The claim flow's HTTP surface (SPEC-v3.md 5.3):
//   GET  /api/v1/earnings/github/:login  — public, free
//   POST /api/v1/claims                  — returns a nonce, records a pending claim
//   POST /api/v1/claims/verify           — checks the claimant's published proof
//
// This router uses full absolute paths and is meant to be mounted at root
// (`app.route('/', claimsRouter)`), matching how these paths are written in
// the spec. Exported, not mounted — a follow-up step wires it into
// proxy/src/app.ts once that file is free for this item to touch.

import { Hono } from 'hono'
import type { GithubClient, ProofKind } from './ledger.js'
import { createClaim, getEarningsForLogin, verifyClaim } from './ledger.js'

/**
 * Build the claims router. `github` is the injectable GitHub client used by
 * the verify endpoint (CAUTION: tests must pass a stub so no test performs
 * a network call). Production wiring passes a real client.
 */
export function createClaimsRouter(github: GithubClient): Hono {
  const router = new Hono()

  // Public, free — never exposes another identity's data: the login in the
  // path is the only identity this handler ever reads or returns.
  router.get('/api/v1/earnings/github/:login', (c) => {
    const login = c.req.param('login')
    return c.json(getEarningsForLogin(login))
  })

  router.post('/api/v1/claims', async (c) => {
    const body = await c.req.json().catch(() => null)
    const identity = typeof body?.identity === 'string' ? body.identity : undefined
    const algorandAddress =
      typeof body?.algorandAddress === 'string' ? body.algorandAddress : undefined
    if (!identity || !algorandAddress) {
      return c.json({ error: 'identity and algorandAddress are required' }, 400)
    }
    const { nonce } = createClaim(identity, algorandAddress)
    return c.json({ identity, nonce, status: 'pending' })
  })

  router.post('/api/v1/claims/verify', async (c) => {
    const body = await c.req.json().catch(() => null)
    const identity = typeof body?.identity === 'string' ? body.identity : undefined
    const kind: ProofKind | undefined =
      body?.proofKind === 'gist' || body?.proofKind === 'well-known' ? body.proofKind : undefined
    const owner = typeof body?.owner === 'string' ? body.owner : undefined
    const repo = typeof body?.repo === 'string' ? body.repo : undefined
    if (!identity || !kind || !owner) {
      return c.json({ error: 'identity, proofKind, and owner are required' }, 400)
    }
    const claim = await verifyClaim(identity, { kind, owner, repo }, github)
    if (!claim) return c.json({ error: `no pending claim for identity ${identity}` }, 404)
    return c.json(claim)
  })

  return router
}
