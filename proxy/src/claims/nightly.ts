// proxy/src/claims/nightly.ts
//
// The nightly job's testable orchestration (SPEC.md §13.2, ADR 0001, ADR
// 0005), in order: genesis guard -> reconcile -> back up -> credit (R3c). A
// failed genesis check or a failed backup stops the job before the next
// step: `runNightly` lets `deps.assertGenesisMatches()`'s and
// `deps.backup()`'s errors propagate uncaught, so nothing after either
// ever runs.
//
// This module holds the logic; it performs no environment reads and no
// network I/O of its own. Two real callers run it: proxy/src/index.ts's
// in-process scheduler (daily at 03:17 UTC, plus a start-up catch-up run —
// ADR 0009) and nightly-main.ts, the operator's manual entry point. Both
// call runNightlyWithLease below, never runNightly directly, so the two
// paths take the same SQLite lease and never overlap (item N1.4). This
// split mirrors reconcile.ts/reconcile-main.ts: runNightly() is what this
// directory's own tests exercise directly, with a stub indexer, a stub
// backup step, and a stub credit chain client — never a live network or
// chain call.

import { PAY_TO } from '../config.js'
import { type CreditChainClient, runCreditStep } from './credit.js'
import { type IndexerClient, reconcile } from './reconcile.js'
import {
  acquireNightlyLease,
  recordNightlyRunEnd,
  recordNightlyRunStart,
  releaseNightlyLease,
} from './schema.js'

export interface NightlyDeps {
  indexer: IndexerClient
  /** Runs the backup step and returns the backup path. Throws on failure —
   * see this module's banner comment: that throw stops the job here. */
  backup: () => string
  /** null when CREDITER_MNEMONIC is unset — the credit step then logs why
   * and stops (SPEC.md §13.2 step 3), the same as an unset app id. */
  creditClient: CreditChainClient | null
  /**
   * Throws when NETWORK does not match the connected algod's or indexer's
   * own reported genesis id (R3c genesis guard). Called first, before any
   * on-chain read — its throw stops the job here, the same as a backup
   * failure (this module's banner comment): no reconcile, no backup, no
   * credit. nightly-main.ts wires the real fetch + comparison
   * (genesis.ts's assertGenesisMatchesNetwork); tests stub it directly.
   */
  assertGenesisMatches: () => void | Promise<void>
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
  /**
   * Called once, only when the credit step actually credited a batch this
   * run. Lets runNightlyWithLease record `batch_seq`/`credit_txid` on the
   * run's SQLite record (item N1.5) without runNightly itself returning a
   * value — nightly.test.ts's existing `.resolves.toBeUndefined()`
   * assertions stay unchanged.
   */
  onCredited?: (batchSeq: number, creditTxid: string) => void
}

/**
 * Runs the nightly job once: genesis guard, then reconcile, then back up,
 * then credit — always in that order (SPEC.md §13.2, R3c).
 */
export async function runNightly(deps: NightlyDeps): Promise<void> {
  const log = deps.log ?? console.log
  const env = deps.env ?? process.env

  await deps.assertGenesisMatches()

  const reconcileResult = await reconcile(PAY_TO, deps.indexer)
  log(`spm-nightly: reconcile checked ${reconcileResult.inflowsChecked} inflow(s)`)
  log(`spm-nightly: ledgered as unassigned: ${reconcileResult.unmatchedLedgered}`)
  for (const skipped of reconcileResult.skipped) {
    log(
      `spm-nightly: reconcile skipped ${skipped.inflow.txid} ` +
        `amount_micro=${skipped.inflow.amountMicro} reason=${skipped.reason}`,
    )
  }

  const backupPath = deps.backup()
  log(`spm-nightly: backed up to ${backupPath}`)

  if (!env.PAYMENT_ROUTER_APP_ID) {
    log('spm-nightly: credit skipped — PAYMENT_ROUTER_APP_ID is unset')
    return
  }
  if (!deps.creditClient) {
    log('spm-nightly: credit skipped — CREDITER_MNEMONIC is unset')
    return
  }

  const outcome = await runCreditStep(deps.creditClient, env)
  if (!outcome.ran) {
    log(`spm-nightly: credit skipped — ${outcome.reason}`)
    return
  }
  log(`spm-nightly: credited batch ${outcome.batchSeq}, txid ${outcome.creditTxid}`)
  deps.onCredited?.(outcome.batchSeq, outcome.creditTxid)
}

/** Why runNightlyWithLease did not attempt a run, beyond a normal success
 * or a caught failure. */
export type NightlyLeaseOutcome =
  | { status: 'lease-held' }
  | { status: 'success' }
  | { status: 'failed'; error: string }

/**
 * Runs the nightly job once, under the single SQLite lease (item N1.4, ADR
 * 0009): acquires it first, records the run's start and end in
 * `nightly_runs` (item N1.5) regardless of outcome, and always releases
 * the lease in a `finally` block. `now` is the caller's own clock reading,
 * so a test never depends on a real wait.
 *
 * WARNING: this function never throws. A failed run logs
 * `spm-nightly: failed — <reason>` and returns `{ status: 'failed', ...
 * }` instead — the in-process scheduler relies on this to never stop the
 * server (item N1.3); nightly-main.ts, the manual entry point, reads the
 * returned status to decide its own process exit code.
 */
export async function runNightlyWithLease(
  deps: NightlyDeps,
  now: () => Date = () => new Date(),
): Promise<NightlyLeaseOutcome> {
  const log = deps.log ?? console.log
  const startedAt = now().getTime()

  // Both declared outside the try block, and both start unset: a throw from
  // acquireNightlyLease or recordNightlyRunStart itself (for example
  // SQLITE_BUSY, an operator's nightly-main.ts run against the same DB
  // file) must still resolve `failed`, never reject — the scheduler calls
  // this with `void`, so an unhandled rejection here would kill the server
  // (item N1.3). `holder` unset means the lease was never acquired, so the
  // `finally` below must not release someone else's; `runId` unset means no
  // row exists yet to record an end for.
  let holder: string | null = null
  let runId: number | null = null
  let batchSeq: number | null = null
  let creditTxid: string | null = null

  try {
    holder = acquireNightlyLease(startedAt)
    if (!holder) {
      log('spm-nightly: another run already holds the lease; exiting')
      return { status: 'lease-held' }
    }

    runId = recordNightlyRunStart(startedAt)

    await runNightly({
      ...deps,
      onCredited: (seq, txid) => {
        batchSeq = seq
        creditTxid = txid
        deps.onCredited?.(seq, txid)
      },
    })
    recordNightlyRunEnd(runId, now().getTime(), 'success', null, batchSeq, creditTxid)
    return { status: 'success' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (runId !== null) {
      recordNightlyRunEnd(runId, now().getTime(), 'failed', reason, batchSeq, creditTxid)
    }
    log(`spm-nightly: failed — ${reason}`)
    return { status: 'failed', error: reason }
  } finally {
    if (holder !== null) {
      releaseNightlyLease(holder)
    }
  }
}
