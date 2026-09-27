// proxy/src/shutdown.test.ts
//
// CAUTION: every dependency here is a stub — no test opens a real HTTP
// server, a real SQLite handle, a real timer, or a real process signal.
// `exit` is always a mock, so a test that reaches a deadline never actually
// terminates this test process.
import { describe, expect, test, vi } from 'vitest'
import { installShutdownHandlers, runShutdown, type ShutdownDeps } from './shutdown.js'

/** A fake setTimeout/clearTimeout pair: setTimeout records the callback
 * instead of opening a real Node timer, so a test fires the deadline (or
 * doesn't) by calling it directly. */
function fakeTimer(): {
  setTimeout: ShutdownDeps['setTimeout']
  clearTimeout: ShutdownDeps['clearTimeout']
  fire: () => void
  cleared: unknown[]
} {
  let callback: (() => void) | null = null
  const cleared: unknown[] = []
  return {
    setTimeout: vi.fn((cb: () => void) => {
      callback = cb
      return 'timer-handle'
    }),
    clearTimeout: vi.fn((handle: unknown) => {
      cleared.push(handle)
    }),
    fire: () => callback?.(),
    cleared,
  }
}

function baseDeps(overrides: Partial<ShutdownDeps> = {}): ShutdownDeps {
  return {
    stopScheduler: vi.fn(),
    waitForNightlyIdle: vi.fn().mockResolvedValue(undefined),
    closeServer: vi.fn().mockResolvedValue(undefined),
    closeDb: vi.fn(),
    exit: vi.fn(),
    log: vi.fn(),
    ...overrides,
  }
}

describe('runShutdown: idle shutdown', () => {
  test('stops the scheduler, closes the server and db, and exits 0', async () => {
    const deps = baseDeps()

    await runShutdown(deps)

    expect(deps.stopScheduler).toHaveBeenCalledTimes(1)
    expect(deps.closeServer).toHaveBeenCalledTimes(1)
    expect(deps.closeDb).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(0)
  })

  test('the scheduler receives stop before the server closes', async () => {
    const order: string[] = []
    const deps = baseDeps({
      stopScheduler: vi.fn(() => order.push('stopScheduler')),
      closeServer: vi.fn(async () => {
        order.push('closeServer')
      }),
    })

    await runShutdown(deps)

    expect(order).toEqual(['stopScheduler', 'closeServer'])
  })
})

describe('runShutdown: a run finishes before the deadline', () => {
  test('waits for it, then closes the db and exits 0', async () => {
    let releaseRun: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    const timer = fakeTimer()
    const deps = baseDeps({
      waitForNightlyIdle: vi.fn(() => gate),
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    const done = runShutdown(deps)
    await new Promise((resolve) => setImmediate(resolve))
    expect(deps.closeDb).not.toHaveBeenCalled()
    expect(deps.exit).not.toHaveBeenCalled()

    releaseRun()
    await done

    expect(deps.closeDb).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(0)
    expect(timer.cleared).toEqual(['timer-handle'])
  })
})

describe('runShutdown: a run is still busy at the deadline', () => {
  test('logs, exits non-zero, and never closes the db', async () => {
    const timer = fakeTimer()
    const deps = baseDeps({
      waitForNightlyIdle: vi.fn(() => new Promise<void>(() => {})),
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    const done = runShutdown(deps)
    await new Promise((resolve) => setImmediate(resolve))
    timer.fire()
    await done

    expect(deps.closeDb).not.toHaveBeenCalled()
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(1)
    expect(deps.log).toHaveBeenCalledWith(expect.stringContaining('still in flight'))
  })
})

describe('runShutdown: the server close never resolves (a lingering keep-alive)', () => {
  test('a nightly-idle process still exits 0 within the deadline and closes the db', async () => {
    const timer = fakeTimer()
    const deps = baseDeps({
      closeServer: vi.fn(() => new Promise<void>(() => {})),
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    await runShutdown(deps)

    expect(deps.closeDb).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(0)
  })

  test('a busy nightly run still exits non-zero at the deadline and never closes the db', async () => {
    const timer = fakeTimer()
    const deps = baseDeps({
      closeServer: vi.fn(() => new Promise<void>(() => {})),
      waitForNightlyIdle: vi.fn(() => new Promise<void>(() => {})),
      setTimeout: timer.setTimeout,
      clearTimeout: timer.clearTimeout,
    })

    const done = runShutdown(deps)
    await new Promise((resolve) => setImmediate(resolve))
    timer.fire()
    await done

    expect(deps.closeDb).not.toHaveBeenCalled()
    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(1)
  })
})

describe('installShutdownHandlers', () => {
  function fakeProcess(): {
    on: (event: string, cb: () => void) => void
    trigger: (signal: 'SIGTERM' | 'SIGINT') => void
  } {
    const handlers = new Map<string, () => void>()
    return {
      on: (event, cb) => {
        handlers.set(event, cb)
      },
      trigger: (signal) => handlers.get(signal)?.(),
    }
  }

  test('runs the shutdown sequence on the first SIGTERM', () => {
    const deps = baseDeps()
    const proc = fakeProcess()

    installShutdownHandlers(deps, proc)
    proc.trigger('SIGTERM')

    expect(deps.stopScheduler).toHaveBeenCalledTimes(1)
  })

  test('a second signal exits at once with code 1, before any cleanup runs', () => {
    let releaseRun: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      releaseRun = resolve
    })
    const deps = baseDeps({
      waitForNightlyIdle: vi.fn(() => gate),
      setTimeout: vi.fn(() => 'unused-timer-handle'),
      clearTimeout: vi.fn(),
    })
    const proc = fakeProcess()

    installShutdownHandlers(deps, proc)
    proc.trigger('SIGTERM')
    proc.trigger('SIGINT')

    expect(deps.exit).toHaveBeenCalledTimes(1)
    expect(deps.exit).toHaveBeenCalledWith(1)
    expect(deps.closeDb).not.toHaveBeenCalled()
    releaseRun()
  })
})
