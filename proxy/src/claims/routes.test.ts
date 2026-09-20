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
const { writeAccruals } = await import('./ledger.js')
const { createClaimsRouter } = await import('./routes.js')
type Attribution = import('./attribution-rules.js').Attribution
type GithubClient = import('./ledger.js').GithubClient

beforeEach(() => {
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM claims')
  db.exec('DELETE FROM payouts')
})

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
      body: JSON.stringify({ identity: 'github:alice', algorandAddress: 'ALGOADDR' }),
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

describe('POST /api/v1/claims/verify', () => {
  test('verifies a gist-backed claim end to end through the router', async () => {
    const app = createClaimsRouter(stubGithubClient({ alice: 'placeholder' }))
    const createRes = await app.request('/api/v1/claims', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: 'github:alice', algorandAddress: 'ALGOADDR' }),
    })
    const { nonce } = (await createRes.json()) as { nonce: string }

    const verifyingApp = createClaimsRouter(
      stubGithubClient({ alice: `spm-claim:ALGOADDR:${nonce}` }),
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
      body: JSON.stringify({ identity: 'github:victim', algorandAddress: 'VICTIM-ADDR' }),
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
