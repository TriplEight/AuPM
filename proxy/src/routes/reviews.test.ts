// proxy/src/routes/reviews.test.ts
//
// CAUTION: own SQLite file via SQLITE_PATH, set before the dynamic import
// (same trick as proxy/src/routes/health.test.ts).
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-routes-reviews-test-${randomUUID()}.db`)

const { default: db } = await import('../db.js')
const { setStatus } = await import('../status.js')
const { default: reviewsRouter } = await import('./reviews.js')

beforeEach(() => {
  db.exec('DELETE FROM audit_status')
})

function seed(): void {
  setStatus('zeta', '1.0.0', 'COMMUNITY_REVIEWED', 'ADDR', 'TX3', 'sha512-z', 'alice', 'full')
  setStatus('@babel/core', '7.25.2', 'COMMUNITY_REVIEWED', 'ADDR', 'TX1', 'sha512-b', 'alice', 'x')
  setStatus('@babel/core', '7.24.0', 'COMMUNITY_REVIEWED', 'ADDR', 'TX2', 'sha512-c', 'alice', null)
  setStatus('other', '1.0.0', 'COMMUNITY_REVIEWED', 'ADDR', 'TX4', 'sha512-o', 'bob', 'full')
}

describe('GET /api/v1/reviews', () => {
  test('lists one reviewer, sorted by name then version, mixed-case query', async () => {
    seed()
    const res = await reviewsRouter.request('/?reviewer=ALICE')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.reviewer).toBe('github:alice')
    expect(body.reviews.map((r: { name: string; version: string }) => [r.name, r.version])).toEqual(
      [
        ['@babel/core', '7.24.0'],
        ['@babel/core', '7.25.2'],
        ['zeta', '1.0.0'],
      ],
    )
    expect(body.reviews[1]).toEqual({
      name: '@babel/core',
      version: '7.25.2',
      status: 'COMMUNITY_REVIEWED',
      scope: 'x',
      anchorTxid: 'TX1',
      reviewedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/),
    })
  })

  test('accepts the github: prefix; a row without scope reports null', async () => {
    seed()
    const body = await (await reviewsRouter.request('/?reviewer=github:Alice')).json()
    expect(body.reviewer).toBe('github:alice')
    expect(body.reviews[0].scope).toBeNull()
  })

  test('empty list for a reviewer with no records', async () => {
    seed()
    const res = await reviewsRouter.request('/?reviewer=carol')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ reviewer: 'github:carol', reviews: [] })
  })

  test.each([
    '',
    '?reviewer=',
    '?reviewer=github:',
    '?reviewer=-alice',
    '?reviewer=alice-',
    '?reviewer=al--ice',
    '?reviewer=al_ice',
    '?reviewer=a%20b',
    `?reviewer=${'a'.repeat(40)}`,
  ])('400 for missing or malformed login %j', async (query) => {
    const res = await reviewsRouter.request(`/${query}`)
    expect(res.status).toBe(400)
    expect(typeof (await res.json()).error).toBe('string')
  })

  test('accepts a 39-character login', async () => {
    const res = await reviewsRouter.request(`/?reviewer=${'a'.repeat(39)}`)
    expect(res.status).toBe(200)
  })
})
