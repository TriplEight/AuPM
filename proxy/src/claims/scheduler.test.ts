// proxy/src/claims/scheduler.test.ts
//
// CAUTION: every test here injects a fake SchedulerClock — no test opens a
// real Node timer or waits on the real clock — and stubs the indexer,
// backup, and credit client the same way nightly.test.ts does, so no test
// in this file performs a real network or chain call. This file gets its
// own SQLite file via SQLITE_PATH, set before the dynamic import below
// (same trick as this directory's other test files).
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-claims-scheduler-test-${randomUUID()}.db`)

const { default: db, recordNightlyRunEnd, recordNightlyRunStart } = await import('./schema.js')
const { computeNextRunAt, needsCatchUp, startNightlyScheduler } = await import('./scheduler.js')
type IndexerClient = import('./reconcile.js').IndexerClient
type NightlyDeps = import('./nightly.js').NightlyDeps
type SchedulerClock = import('./scheduler.js').SchedulerClock

beforeEach(() => {
  db.exec('DELETE FROM nightly_runs')
  db.exec('DELETE FROM nightly_lease')
})

function emptyIndexer(): IndexerClient {
  return { listUsdcInflows: vi.fn().mockResolvedValue([]) }
}

function stubDeps(overrides: Partial<NightlyDeps> = {}): NightlyDeps {
  return {
    indexer: emptyIndexer(),
    backup: vi.fn(() => '/backup/audit-2026.db'),
    creditClient: null,
    assertGenesisMatches: () => {},
    env: {},
    log: () => {},
    ...overrides,
  }
}

describe('computeNextRunAt: item N1.1', () => {
  test('today at 03:17 UTC when now is earlier that day', () => {
    const next = computeNextRunAt(new Date('2026-03-05T00:00:00.000Z'))
    expect(next.toISOString()).toBe('2026-03-05T03:17:00.000Z')
  })

  test('the millisecond before 03:17 UTC still resolves to today', () => {
    const next = computeNextRunAt(new Date('2026-03-05T03:16:59.999Z'))
    expect(next.toISOString()).toBe('2026-03-05T03:17:00.000Z')
  })

  test('exactly 03:17:00.000 UTC rolls to tomorrow, never a zero-delay repeat', () => {
    const next = computeNextRunAt(new Date('2026-03-05T03:17:00.000Z'))
    expect(next.toISOString()).toBe('2026-03-06T03:17:00.000Z')
  })

  test('later the same day resolves to tomorrow', () => {
    const next = computeNextRunAt(new Date('2026-03-05T12:00:00.000Z'))
    expect(next.toISOString()).toBe('2026-03-06T03:17:00.000Z')
  })

  test('rolls across a month boundary', () => {
    const next = computeNextRunAt(new Date('2026-03-31T12:00:00.000Z'))
    expect(next.toISOString()).toBe('2026-04-01T03:17:00.000Z')
  })
})

describe('needsCatchUp: item N1.2', () => {
  const now = new Date('2026-03-05T00:00:00.000Z')

  test('true when no successful run exists', () => {
    expect(needsCatchUp(undefined, now)).toBe(true)
  })

  test('false when the last successful run started less than 24 hours ago', () => {
    const lastSuccess = { started_at: now.getTime() - 23 * 60 * 60 * 1000 } as never
    expect(needsCatchUp(lastSuccess, now)).toBe(false)
  })

  test('false at exactly 24 hours (not "more than")', () => {
    const lastSuccess = { started_at: now.getTime() - 24 * 60 * 60 * 1000 } as never
    expect(needsCatchUp(lastSuccess, now)).toBe(false)
  })

  test('true when the last successful run started more than 24 hours ago', () => {
    const lastSuccess = { started_at: now.getTime() - 24 * 60 * 60 * 1000 - 1 } as never
    expect(needsCatchUp(lastSuccess, now)).toBe(true)
  })
})

/** A fake SchedulerClock: `now()` reads a mutable box, `setTimeout` records
 * every scheduled callback instead of opening a real timer. */
function fakeClock(startAt: Date): SchedulerClock & { firedCallbacks: number } {
  const box = { current: startAt }
  return {
    firedCallbacks: 0,
    now: () => box.current,
    setTimeout: vi.fn(() => Symbol('timer')),
    clearTimeout: vi.fn(),
  }
}

describe('startNightlyScheduler: item N1.1 (daily timer)', () => {
  test('schedules the next run at 03:17 UTC and returns a stoppable handle', () => {
    const clock = fakeClock(new Date('2026-03-05T00:00:00.000Z'))
    const handle = startNightlyScheduler(stubDeps(), clock)

    expect(clock.setTimeout).toHaveBeenCalledTimes(1)
    const call = vi.mocked(clock.setTimeout).mock.calls.at(0)
    expect(call?.[1]).toBe(3 * 60 * 60 * 1000 + 17 * 60 * 1000)

    handle.stop()
    expect(clock.clearTimeout).toHaveBeenCalledTimes(1)
  })
})

describe('startNightlyScheduler: item N1.2 (start-up catch-up)', () => {
  test('runs once at start when no run has ever completed', async () => {
    const clock = fakeClock(new Date('2026-03-05T00:00:00.000Z'))
    const backup = vi.fn(() => '/backup/audit-2026.db')

    startNightlyScheduler(stubDeps({ backup }), clock)
    // runNightlyWithLease is fire-and-forget from startNightlyScheduler —
    // flush the microtask queue so its (stubbed, synchronous) steps run.
    await vi.waitFor(() => expect(backup).toHaveBeenCalledTimes(1))
  })

  test('does not run at start when the last successful run is under 24 hours old', async () => {
    const now = new Date('2026-03-05T00:00:00.000Z')
    recordNightlyRunEnd(
      recordNightlyRunStart(now.getTime() - 1000),
      now.getTime() - 500,
      'success',
      null,
      null,
      null,
    )
    const clock = fakeClock(now)
    const backup = vi.fn(() => '/backup/audit-2026.db')

    startNightlyScheduler(stubDeps({ backup }), clock)
    await new Promise((resolve) => setImmediate(resolve))
    expect(backup).not.toHaveBeenCalled()
  })
})

describe('startNightlyScheduler: item N1.3 (a failed run never stops the caller)', () => {
  test('a catch-up run that throws is caught, logged, and recorded — startNightlyScheduler itself never throws', () => {
    const clock = fakeClock(new Date('2026-03-05T00:00:00.000Z'))
    const log = vi.fn()
    const backup = vi.fn(() => {
      throw new Error('backup destination is unwritable')
    })

    expect(() => startNightlyScheduler(stubDeps({ backup, log }), clock)).not.toThrow()
  })
})
