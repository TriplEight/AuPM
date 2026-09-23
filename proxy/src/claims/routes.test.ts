// proxy/src/claims/routes.test.ts
//
// This file gets its own SQLite file via SQLITE_PATH, set before the
// dynamic import below (same trick as proxy/src/app.test.ts and this
// directory's ledger.test.ts) — the accruals and payouts tables are shared
// across several test files here, so per-file isolation stops vitest's
// parallel test files from racing on the same physical database.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-claims-routes-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { writeAccruals } = await import('./ledger.js')
const { createClaimsRouter } = await import('./routes.js')
type Attribution = import('./attribution-rules.js').Attribution

beforeEach(() => {
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM payouts')
})

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

    const app = createClaimsRouter()
    const res = await app.request('/api/v1/earnings/github/alice')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      identity: string
      roles: Array<{ role: string; accruedMicro: number }>
    }
    expect(body.identity).toBe('github:alice')
    expect(body.roles.find((r) => r.role === 'auditor')?.accruedMicro).toBe(400)
  })

  test("an unknown login reports zero, not another identity's data", async () => {
    const app = createClaimsRouter()
    const res = await app.request('/api/v1/earnings/github/nobody')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { totalAccruedMicro: number }
    expect(body.totalAccruedMicro).toBe(0)
  })

  test('the login path segment is case-insensitive: ALICE reports the same accrual as alice', async () => {
    const attribution: Attribution = {
      route: 'single-attest',
      priceMicro: 1000,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:Alice', maintainer: 'github:bob' },
      ],
    }
    writeAccruals(attribution, 'TXID-ROUTE-2')

    const app = createClaimsRouter()
    const res = await app.request('/api/v1/earnings/github/ALICE')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      identity: string
      roles: Array<{ role: string; accruedMicro: number }>
    }
    expect(body.identity).toBe('github:alice')
    expect(body.roles.find((r) => r.role === 'auditor')?.accruedMicro).toBe(400)
  })
})
