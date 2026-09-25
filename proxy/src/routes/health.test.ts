// proxy/src/routes/health.test.ts
//
// CAUTION: this file gets its own SQLite file via SQLITE_PATH, set before
// the dynamic import below (same trick as proxy/src/status.test.ts).
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-routes-health-test-${randomUUID()}.db`)

const {
  default: db,
  recordNightlyRunEnd,
  recordNightlyRunStart,
} = await import('../claims/schema.js')
const { default: healthRouter, HEALTHY_SUCCESS_MAX_AGE_MS } = await import('./health.js')

beforeEach(() => {
  db.exec('DELETE FROM nightly_runs')
})

function recordRun(
  startedAt: number,
  endedAt: number,
  result: 'success' | 'failed',
  error: string | null = null,
): void {
  recordNightlyRunEnd(recordNightlyRunStart(startedAt), endedAt, result, error, null, null)
}

describe('GET /api/v1/health: item N1.6', () => {
  test('503 and both fields null when no run has ever happened', async () => {
    // No success ever recorded is not "healthy" — item N1.6 only defines a
    // 200 case (a recent success); everything else, including a server
    // that has not completed its first run yet, is the 503 "else".
    const res = await healthRouter.request('/')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.lastRun).toBeNull()
    expect(body.lastSuccess).toBeNull()
  })

  test('200 when the last success is comfortably inside the 26-hour window', async () => {
    // A margin below HEALTHY_SUCCESS_MAX_AGE_MS, not the exact boundary:
    // the route compares against a fresh Date.now() at request time, a few
    // milliseconds after this test computes `startedAt` — an exact-boundary
    // value would be flaky.
    const startedAt = Date.now() - HEALTHY_SUCCESS_MAX_AGE_MS + 60_000
    recordRun(startedAt, startedAt + 1000, 'success')

    const res = await healthRouter.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lastSuccess.startedAt).toBe(startedAt)
    expect(body.lastRun.result).toBe('success')
  })

  test('503 when the last success is more than 26 hours old', async () => {
    const startedAt = Date.now() - HEALTHY_SUCCESS_MAX_AGE_MS - 1000
    recordRun(startedAt, startedAt + 1000, 'success')

    const res = await healthRouter.request('/')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.lastSuccess.startedAt).toBe(startedAt)
  })

  test('503 when only failed runs exist, and the failure is still reported as lastRun', async () => {
    recordRun(Date.now() - 1000, Date.now(), 'failed', 'backup destination is unwritable')

    const res = await healthRouter.request('/')
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.lastSuccess).toBeNull()
    expect(body.lastRun.result).toBe('failed')
    expect(body.lastRun.error).toBe('backup destination is unwritable')
  })

  test('200 when a later failed run follows an earlier success within the window', async () => {
    const successAt = Date.now() - 1000
    recordRun(successAt, successAt + 100, 'success')
    recordRun(Date.now(), Date.now(), 'failed', 'transient indexer timeout')

    const res = await healthRouter.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.lastSuccess.startedAt).toBe(successAt)
    expect(body.lastRun.result).toBe('failed')
  })
})
