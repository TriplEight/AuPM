// proxy/src/shutdown.ts
//
// Clean shutdown on SIGTERM/SIGINT (item F4). Docker's default stop timeout
// is 10s: Compose sends SIGTERM, waits, then SIGKILL. PID 1 here
// (node --import tsx/esm src/index.ts) has no default SIGTERM action, and
// without a handler the process rides out the full window doing nothing
// before SIGKILL lands — possibly mid nightly-job SQLite write (ADR 0009).
//
// This module gives the process a deadline of its own, below Docker's
// default: it stops the nightly scheduler first (no new run starts), starts
// closing the HTTP listener, gives an in-flight nightly run a bounded
// window to finish, then closes SQLite — but only when that run finished
// cleanly. The server's own close is started but never awaited past the
// deadline: a keep-alive connection behind a reverse proxy can hold it
// pending indefinitely, and waiting on it would let that alone burn the
// whole budget (see runShutdown's own warning below). A nightly run still
// busy at the deadline is left alone: this module never touches its lease
// or its in-progress write, and exits non-zero so the caller knows the
// 1-hour lease-expiry path (nightly_lease, schema.ts) is what reclaims it,
// not a clean release here.
//
// Every dependency is injected — no test here opens a real server, a real
// database, or waits on a real timer.

/** Below Docker Compose's default `stop_grace_period` (10s) so the process
 * exits on its own terms instead of being SIGKILLed mid-write. */
export const SHUTDOWN_DEADLINE_MS = 8000

export interface ShutdownDeps {
  /** Stops the nightly scheduler's daily timer. Never cancels a run already
   * in progress (scheduler.ts's own SchedulerHandle.stop contract). */
  stopScheduler: () => void
  /** Resolves once no nightly run is in flight; resolves immediately when
   * none is. Never rejects — runNightlyWithLease never throws (item N1.3),
   * so there is nothing here to catch. */
  waitForNightlyIdle: () => Promise<void>
  /** Stops the HTTP server from accepting new connections and resolves once
   * it has fully closed. runShutdown starts this but never awaits it past
   * the deadline (see its own warning) — a lingering keep-alive connection
   * must never hold up the database close or the process exit. */
  closeServer: () => Promise<void>
  /** Closes the SQLite handle. Called only when no nightly run is in
   * flight — never under a running write. */
  closeDb: () => void
  /** Terminates the process. Injected so a test never actually exits. */
  exit: (code: number) => void
  log?: (line: string) => void
  setTimeout?: (callback: () => void, ms: number) => unknown
  clearTimeout?: (handle: unknown) => void
}

/**
 * Races `work` against `deadlineMs`. Resolves `true` when `work` finished
 * first, `false` when the deadline won. Never rejects — `work` itself must
 * not reject (runShutdown's callers guarantee this: closeServer and
 * waitForNightlyIdle never throw).
 */
function raceAgainstDeadline(
  work: Promise<void>,
  deadlineMs: number,
  setTimeoutFn: (callback: () => void, ms: number) => unknown,
  clearTimeoutFn: (handle: unknown) => void,
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const timer = setTimeoutFn(() => {
      if (settled) return
      settled = true
      resolve(false)
    }, deadlineMs)

    void work.then(() => {
      if (settled) return
      settled = true
      clearTimeoutFn(timer)
      resolve(true)
    })
  })
}

/**
 * Runs the shutdown sequence once (item F4, results 1-2): stop the
 * scheduler, start closing the server, then race an in-flight nightly run
 * against SHUTDOWN_DEADLINE_MS. The database closes only when that run
 * finished in time. Exits 0 on a clean shutdown, 1 when the deadline won —
 * the lease-expiry path then reclaims a still-running nightly run's lease,
 * never this module.
 *
 * WARNING: `deps.closeServer()` is started but never awaited before the
 * deadline race, and its outcome plays no part in that race. Behind a
 * reverse proxy a keep-alive connection can hold Node's `server.close()`
 * callback pending well past the deadline — Node invokes it only once
 * every connection has ended — so awaiting it first, or gating the
 * deadline on it, would let one lingering connection burn the whole budget
 * and delay this process's own exit past Docker's SIGKILL, the exact
 * failure this module exists to avoid. A server still draining at the
 * deadline is not a reason to withhold the database close: only a nightly
 * run's own SQLite write is.
 */
export async function runShutdown(deps: ShutdownDeps): Promise<void> {
  const log = deps.log ?? console.log
  const setTimeoutFn = deps.setTimeout ?? setTimeout
  const clearTimeoutFn = deps.clearTimeout ?? ((handle) => clearTimeout(handle as NodeJS.Timeout))

  deps.stopScheduler()
  // Kicked off, not awaited: see the warning above. A rejection here plays
  // no part in the deadline race either way, but it must never be
  // swallowed silently — log it and move on.
  deps.closeServer().catch((err: unknown) => {
    const reason = err instanceof Error ? err.message : String(err)
    log(`spm-shutdown: server close failed — ${reason}`)
  })

  const idleInTime = await raceAgainstDeadline(
    deps.waitForNightlyIdle(),
    SHUTDOWN_DEADLINE_MS,
    setTimeoutFn,
    clearTimeoutFn,
  )

  if (!idleInTime) {
    log(
      'spm-shutdown: nightly run still in flight at the deadline; exiting without ' +
        'closing the database — the 1-hour lease expiry will reclaim it',
    )
    deps.exit(1)
    return
  }

  deps.closeDb()
  log('spm-shutdown: clean shutdown complete')
  deps.exit(0)
}

/** The one method installShutdownHandlers needs from `process` — narrow on
 * purpose so a test injects a plain object instead of a real
 * NodeJS.Process. */
export interface SignalSource {
  on: (event: 'SIGTERM' | 'SIGINT', listener: () => void) => void
}

/**
 * Installs SIGTERM/SIGINT handlers (item F4, result 1). The first signal of
 * either kind runs `runShutdown` once; a second signal, of either kind,
 * exits at once with code 1 — for an operator who signals again because the
 * first attempt is not responding.
 */
export function installShutdownHandlers(
  deps: ShutdownDeps,
  onProcess: SignalSource = process,
): void {
  let shuttingDown = false
  const log = deps.log ?? console.log

  const handle = (signal: string): void => {
    if (shuttingDown) {
      log(`spm-shutdown: second ${signal}; exiting immediately`)
      deps.exit(1)
      return
    }
    shuttingDown = true
    log(`spm-shutdown: received ${signal}`)
    void runShutdown(deps)
  }

  onProcess.on('SIGTERM', () => handle('SIGTERM'))
  onProcess.on('SIGINT', () => handle('SIGINT'))
}
