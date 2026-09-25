// proxy/src/claims/nightly-main.ts
//
// The nightly job's manual, operator-run entry point (SPEC.md §13.2, ADR
// 0001, ADR 0005, ADR 0009). The proxy process itself now runs the job on
// its own schedule (proxy/src/index.ts, daily at 03:17 UTC plus a start-up
// catch-up run) — this file stays for a one-off, by-hand pass, for example
// right after a deploy or while debugging. It holds no scheduling,
// genesis-guard, reconcile, backup, or credit logic of its own: it wires
// the real indexer, algod client, SQLite backup step, and genesis check
// through nightly-wiring.ts's buildRealNightlyDeps (shared with
// proxy/src/index.ts, so the job is wired exactly one way), then calls
// runNightlyWithLease (nightly.ts) — the same lease-taking entry point the
// in-process scheduler calls, so the two paths never run at once (item
// N1.4). runNightlyWithLease's own tests exercise the actual behavior with
// stubs (nightly.test.ts, credit.test.ts, backup.test.ts) — this file is
// never imported by a test.
//
// Run with: pnpm -C proxy nightly

import { assertValidPayTo } from '../config.js'
import db from '../db.js'
import { runNightlyWithLease } from './nightly.js'
import { buildRealNightlyDeps } from './nightly-wiring.js'

async function main(): Promise<void> {
  // payTo guard: cheap, local, no I/O — checked before any network call.
  // Reuses proxy/src/config.ts's own boot guard rather than a second copy
  // of the same validation, and its error message names PAY_TO_ADDRESS.
  assertValidPayTo()

  const outcome = await runNightlyWithLease(buildRealNightlyDeps())
  if (outcome.status === 'failed') {
    // runNightlyWithLease already logged "spm-nightly: failed — <reason>"
    // (item N1.3) — this only sets the process's own exit code, for an
    // operator or a script checking `$?` after a manual run.
    process.exitCode = 1
  }
}

main()
  .catch((err: unknown) => {
    console.error('spm-nightly: failed —', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => {
    db.close()
  })
