// proxy/src/claims/scheduler.ts
//
// The in-process nightly scheduler (SPEC.md §13.2, ADR 0009, item N1).
// Computes the next 03:17 UTC run time, times a repeating call to
// runNightlyWithLease (nightly.ts), and decides whether a start-up
// catch-up run is due. Pure orchestration: every clock and timer call is
// injectable (SchedulerClock), so no test here waits on a real clock or
// opens a real timer. proxy/src/index.ts is the only caller that wires the
// real clock and real setTimeout/clearTimeout, and only when SPM_NIGHTLY
// is not "off" — this module performs no environment reads and no network
// I/O of its own.

import { type NightlyDeps, runNightlyWithLease } from './nightly.js'
import { getLastSuccessfulNightlyRun, type NightlyRunRow } from './schema.js'

export const NIGHTLY_HOUR_UTC = 3
export const NIGHTLY_MINUTE_UTC = 17

/** How stale the last successful run must be before start-up runs a
 * catch-up pass (item N1.2). */
export const CATCH_UP_STALE_MS = 24 * 60 * 60 * 1000

/**
 * The next 03:17:00.000 UTC instant strictly after `now`: today's 03:17
 * UTC when `now` is still before it, tomorrow's otherwise. `now` at exactly
 * 03:17:00.000 UTC rolls to tomorrow, so a run's own timer callback
 * (firing at that instant) always schedules its own next run in the
 * future, never a zero-delay repeat.
 */
export function computeNextRunAt(now: Date): Date {
  const next = new Date(
    Date.UTC(
      now.getUTCFullYear(),
      now.getUTCMonth(),
      now.getUTCDate(),
      NIGHTLY_HOUR_UTC,
      NIGHTLY_MINUTE_UTC,
      0,
      0,
    ),
  )
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1)
  }
  return next
}

/**
 * True when a start-up catch-up run is due (item N1.2): no successful run
 * exists yet, or the last one started more than CATCH_UP_STALE_MS ago.
 */
export function needsCatchUp(lastSuccess: NightlyRunRow | undefined, now: Date): boolean {
  if (!lastSuccess) return true
  return now.getTime() - lastSuccess.started_at > CATCH_UP_STALE_MS
}

/** Every clock and timer call the scheduler makes — injected so a test
 * never waits on a real clock or opens a real Node timer. */
export interface SchedulerClock {
  now: () => Date
  setTimeout: (callback: () => void, ms: number) => unknown
  clearTimeout: (handle: unknown) => void
}

export const realSchedulerClock: SchedulerClock = {
  now: () => new Date(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as NodeJS.Timeout),
}

export interface SchedulerHandle {
  /** Cancels the pending daily timer. Does not cancel a run already in
   * progress — runNightlyWithLease's own lease and try/finally handle
   * that. */
  stop: () => void
}

/**
 * Starts the daily 03:17 UTC schedule and, when due, a single start-up
 * catch-up run (items N1.1–N1.2). Both call runNightlyWithLease
 * (nightly.ts), so a catch-up run, the daily timer, and a concurrent
 * manual `nightly-main.ts` run never overlap (item N1.4, ADR 0009).
 * Neither call is awaited here: a slow or failing run must never delay the
 * timer that reschedules the next one, and runNightlyWithLease itself
 * never throws (item N1.3), so there is no unhandled rejection to await
 * for.
 */
export function startNightlyScheduler(
  deps: NightlyDeps,
  clock: SchedulerClock = realSchedulerClock,
): SchedulerHandle {
  let timer: unknown

  const runOnce = (): void => {
    void runNightlyWithLease(deps, clock.now)
  }

  const scheduleNext = (): void => {
    const delayMs = computeNextRunAt(clock.now()).getTime() - clock.now().getTime()
    timer = clock.setTimeout(() => {
      runOnce()
      scheduleNext()
    }, delayMs)
  }

  scheduleNext()

  if (needsCatchUp(getLastSuccessfulNightlyRun(), clock.now())) {
    runOnce()
  }

  return {
    stop: () => clock.clearTimeout(timer),
  }
}
