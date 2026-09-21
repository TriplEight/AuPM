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

import algosdk from 'algosdk'
import { Hono } from 'hono'
import type { GithubClient, ProofKind } from './ledger.js'
import {
  ClaimAlreadyVerifiedError,
  ClaimIdentityMismatchError,
  createClaim,
  getEarningsForLogin,
  verifyClaim,
} from './ledger.js'

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
    // WARNING: a payout destination must be validated before it is stored,
    // not at payout time. scripts/payout.ts later emits this address as a
    // real MainNet payout — an invalid address fails the payout, and a
    // valid-but-wrong address is unrecoverable. algosdk.isValidAddress
    // checks the checksum, not merely the length.
    if (!algosdk.isValidAddress(algorandAddress)) {
      return c.json({ error: 'algorandAddress is not a valid Algorand address' }, 400)
    }
    // WARNING: a verified claim is not reopened by an unauthenticated
    // request — otherwise anyone who knows a contributor's identity string
    // could block their payouts forever. See ledger.ts's createClaim.
    let nonce: string
    try {
      ;({ nonce } = createClaim(identity, algorandAddress))
    } catch (err) {
      if (err instanceof ClaimAlreadyVerifiedError) {
        return c.json({ error: err.message }, 409)
      }
      throw err
    }
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
    // WARNING: a proof owner that does not bind to `identity` is rejected
    // outright (400) — never recorded as a failed claim. Otherwise an
    // attacker could hijack another identity's claim by publishing a proof
    // they own themselves. See ledger.ts's verifyClaim.
    let claim: Awaited<ReturnType<typeof verifyClaim>>
    try {
      claim = await verifyClaim(identity, { kind, owner, repo }, github)
    } catch (err) {
      if (err instanceof ClaimIdentityMismatchError) {
        return c.json({ error: err.message }, 400)
      }
      throw err
    }
    if (!claim) return c.json({ error: `no pending claim for identity ${identity}` }, 404)
    return c.json(claim)
  })

  return router
}
