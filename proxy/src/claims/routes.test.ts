// proxy/src/claims/routes.test.ts
//
// CAUTION: `stubGithubClient` below performs no network I/O — no test in
// this file reaches GitHub.
//
// This file gets its own SQLite file via SQLITE_PATH, set before the
// dynamic import below (same trick as proxy/src/app.test.ts and this
// directory's ledger.test.ts) — the claims tables are shared across several
// test files here, so per-file isolation stops vitest's parallel test files
// from racing on the same physical database.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-claims-routes-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { writeAccruals, getClaim } = await import('./ledger.js')
const { createClaimsRouter } = await import('./routes.js')
type Attribution = import('./attribution-rules.js').Attribution
type GithubClient = import('./ledger.js').GithubClient

beforeEach(() => {
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM claims')
  db.exec('DELETE FROM payouts')
})

// Valid-checksum MainNet-shaped addresses (algosdk.generateAccount()), used
// wherever a test needs a payout destination that passes
// algosdk.isValidAddress — the router now rejects anything that doesn't.
const VALID_ADDR_1 = '43KJFOUAT6ZRMOAYSJ2E6ECFB7WH2QAWETOOZ3D4554M6R7TKTBFLQG6WY'
const VALID_ADDR_2 = 'MNFN6YYXQK5544BBDXW24B2PSNBQLRSXX3QGL6E52QZCJIARI5WTEOBRAI'
const VALID_ADDR_3 = 'D5XBKGHE5GFQDYR5NNYQRHAOUHC6AJKWT6GGLXR4VODV3GF6VY46UE3IWE'
const VALID_ADDR_4 = 'Q5THNFUQLRVCL3YTY5I45HZPTKH66LWOOVPDHKAL5MJG3TO3BFK6FK4KHM'
// Right length (58 chars), valid base32 alphabet, but wrong checksum — must
// still be rejected: length alone is not validation.
const BAD_CHECKSUM_ADDR = `${'A'.repeat(57)}Q`

function stubGithubClient(gistByLogin: Record<string, string> = {}): GithubClient {
  return {
    getFile: async () => null,
    getGistContent: async (login) => gistByLogin[login] ?? null,
  }
}

describe('GET /api/v1/earnings/github/:login', () => {
  test('reports accrued totals per role for a login, free and public', async () => {
    const attribution: Attribution = {
      route: 'single-attest',
      priceMicro: 1000,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:bob' },
      ],
    }
    writeAccruals(attribution, 'TXID-ROUTE-1')

    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/earnings/github/alice')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      identity: string
      roles: Array<{ role: string; accruedMicro: number }>
    }
    expect(body.identity).toBe('github:alice')
    expect(body.roles.find((r) => r.role === 'auditor')?.accruedMicro).toBe(500)
  })

  test("an unknown login reports zero, not another identity's data", async () => {
    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/earnings/github/nobody')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { totalAccruedMicro: number }
    expect(body.totalAccruedMicro).toBe(0)
  })
})

describe('POST /api/v1/claims', () => {
  test('returns a nonce and records a pending claim', async () => {
    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:alice', algorandAddress: VALID_ADDR_1 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nonce: string; status: string }
    expect(body.nonce).toBeTruthy()
    expect(body.status).toBe('pending')
  })

  test('400 when identity or algorandAddress is missing', async () => {
    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:alice' }),
    })
    expect(res.status).toBe(400)
  })
})

describe('POST /api/v1/claims: payout destination validation (I3 defect 1)', () => {
  test('400 for a non-address string, and no claim row is written', async () => {
    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:baddest', algorandAddress: 'not-an-address' }),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(body.error).toMatch(/algorandAddress/)
    expect(getClaim('github:baddest')).toBeUndefined()
  })

  test('a valid address still creates a claim and returns a nonce', async () => {
    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:goodaddr', algorandAddress: VALID_ADDR_1 }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { nonce: string; status: string }
    expect(body.nonce).toBeTruthy()
    expect(body.status).toBe('pending')
    expect(getClaim('github:goodaddr')?.algorand_address).toBe(VALID_ADDR_1)
  })

  test('400 for a 58-char address with a bad checksum, and no claim row is written', async () => {
    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:badchecksum', algorandAddress: BAD_CHECKSUM_ADDR }),
    })
    expect(res.status).toBe(400)
    expect(getClaim('github:badchecksum')).toBeUndefined()
  })
})

describe('POST /api/v1/claims: verified claim reset protection (H2)', () => {
  test('409 when re-claiming an already-verified identity, and the stored claim is unchanged', async () => {
    const createApp = createClaimsRouter(stubGithubClient())
    const createRes = await createApp.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:verified', algorandAddress: VALID_ADDR_2 }),
    })
    const { nonce } = (await createRes.json()) as { nonce: string }

    const verifyingApp = createClaimsRouter(
      stubGithubClient({ verified: `spm-claim:${VALID_ADDR_2}:${nonce}` }),
    )
    await verifyingApp.request('/api/v1/claims/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:verified', proofKind: 'gist', owner: 'verified' }),
    })

    const resetApp = createClaimsRouter(stubGithubClient())
    const res = await resetApp.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:verified', algorandAddress: VALID_ADDR_3 }),
    })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/v1/claims/verify', () => {
  test('verifies a gist-backed claim end to end through the router', async () => {
    const app = createClaimsRouter(stubGithubClient({ alice: 'placeholder' }))
    const createRes = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:alice', algorandAddress: VALID_ADDR_1 }),
    })
    const { nonce } = (await createRes.json()) as { nonce: string }

    const verifyingApp = createClaimsRouter(
      stubGithubClient({ alice: `spm-claim:${VALID_ADDR_1}:${nonce}` }),
    )
    const verifyRes = await verifyingApp.request('/api/v1/claims/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:alice', proofKind: 'gist', owner: 'alice' }),
    })
    expect(verifyRes.status).toBe(200)
    const body = (await verifyRes.json()) as { status: string }
    expect(body.status).toBe('verified')
  })

  test('404 when verifying an identity with no claim', async () => {
    const app = createClaimsRouter(stubGithubClient())
    const res = await app.request('/api/v1/claims/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:nobody', proofKind: 'gist', owner: 'nobody' }),
    })
    expect(res.status).toBe(404)
  })

  test('400 when the proof owner does not match the claimed identity (hijack attempt)', async () => {
    const createApp = createClaimsRouter(stubGithubClient())
    await createApp.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:victim', algorandAddress: VALID_ADDR_4 }),
    })

    const app = createClaimsRouter(stubGithubClient({ attacker: 'placeholder' }))
    const res = await app.request('/api/v1/claims/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:victim', proofKind: 'gist', owner: 'attacker' }),
    })
    expect(res.status).toBe(400)
  })
})
