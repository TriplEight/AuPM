// proxy/src/claims/nightly.ts
//
// The nightly job's testable orchestration, in order: genesis guard -> reconcile -> back up -> credit (R3c). A
// failed genesis check or a failed backup stops the job before the next
// step: `runNightly` lets `deps.assertGenesisMatches()`'s and
// `deps.backup()`'s errors propagate uncaught, so nothing after either
// ever runs.
//
// This module holds the logic; it performs no environment reads and no
// network I/O of its own. Two real callers run it: proxy/src/index.ts's
// in-process scheduler (daily at 03:17 UTC, plus a start-up catch-up run)
// and nightly-main.ts, the operator's manual entry point. Both
// call runNightlyWithLease below, never runNightly directly, so the two
// paths take the same SQLite lease and never overlap (item N1.4). This
// split mirrors reconcile.ts/reconcile-main.ts: runNightly() is what this
// directory's own tests exercise directly, with a stub indexer, a stub
// backup step, and a stub credit chain client — never a live network or
// chain call.

import { NETWORK, PAY_TO } from '../config.js'
import { type CreditChainClient, runCreditStep } from './credit.js'
import { matureUnpaidTotal, recordBacklog } from './ledger.js'
import type { PushStatus } from './push.js'
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
   * and stops, the same as an unset app id. */
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
  /** The clock in ms. Defaults to `Date.now`. */
  now?: () => number
  /**
   * Called once per batch the credit step credited this run, in batch order.
   * Lets runNightlyWithLease record the last `batch_seq`/`credit_txid` on the
   * run's SQLite record (item N1.5) without runNightly itself returning a
   * value — nightly.test.ts's existing `.resolves.toBeUndefined()`
   * assertions stay unchanged.
   */
  onCredited?: (batchSeq: number, creditTxid: string) => void
  /**
   * Reports the run's status to an external monitor. Undefined when no push
   * URL is set. runNightlyWithLease calls it once per run that took the lease,
   * and it must not throw (push.ts's pushStatus never does).
   */
  push?: (status: PushStatus, msg: string) => Promise<void>
}

/** What one run found, for the status that runNightlyWithLease reports. */
export interface NightlyRunSummary {
  /** The reason the credit step could not run for lack of configuration, else null. */
  configSkip: string | null
  /** The backlog alert text when the alert fired tonight, else null. */
  alert: string | null
  /** Tonight's matured, unpaid payee total in micro-USDC; null when not computed. */
  backlog: number | null
}

/**
 * Runs the nightly job once: genesis guard, then reconcile, then back up,
 * then credit — always in that order (R3c).
 */
export async function runNightly(deps: NightlyDeps): Promise<NightlyRunSummary> {
  const log = deps.log ?? console.log
  const env = deps.env ?? process.env
  const clock = deps.now ?? Date.now

  await deps.assertGenesisMatches()

  const reconcileResult = await reconcile(PAY_TO, deps.indexer)
  log(`aupm-nightly: reconcile checked ${reconcileResult.inflowsChecked} inflow(s)`)
  log(`aupm-nightly: ledgered as unassigned: ${reconcileResult.unmatchedLedgered}`)
  for (const skipped of reconcileResult.skipped) {
    log(
      `aupm-nightly: reconcile skipped ${skipped.inflow.txid} ` +
        `amount_micro=${skipped.inflow.amountMicro} reason=${skipped.reason}`,
    )
  }

  const backupPath = deps.backup()
  log(`aupm-nightly: backed up to ${backupPath}`)

  if (!env.PAYMENT_ROUTER_APP_ID) {
    return skipForConfig(log, 'PAYMENT_ROUTER_APP_ID is unset')
  }
  if (!deps.creditClient) {
    return skipForConfig(log, 'CREDITER_MNEMONIC is unset')
  }

  await creditAllBatches(deps, env, log, clock)
  return { configSkip: null, ...checkBacklog(log, clock()) }
}

function skipForConfig(log: (line: string) => void, reason: string): NightlyRunSummary {
  log(`aupm-nightly: credit skipped — ${reason}`)
  return { configSkip: reason, alert: null, backlog: null }
}

/** Nights in a row of growth of the matured, unpaid total that raise the alert. */
export const BACKLOG_ALERT_NIGHTS = 7

/**
 * Records tonight's matured, unpaid payee total and alerts the operator, in the
 * run log, when it has grown for BACKLOG_ALERT_NIGHTS nights in a row. A
 * growing total means payees are not paid: an address that fails the opt-in
 * check, no address at all, or a payout cap that is too low.
 */
function checkBacklog(
  log: (line: string) => void,
  now: number,
): Pick<NightlyRunSummary, 'alert' | 'backlog'> {
  const total = matureUnpaidTotal(now)
  const nights = recordBacklog(total, now)
  if (nights < BACKLOG_ALERT_NIGHTS) return { alert: null, backlog: total }
  const alert = `ALERT matured unpaid payee total grew ${nights} nights in a row, now ${total} micro-USDC`
  log(`aupm-nightly: ${alert}`)
  return { alert, backlog: total }
}

/**
 * Credits batch after batch until the credit step has nothing left to do. One
 * batch holds at most MAX_PAYOUTS_PER_GROUP payees, so a large backlog needs
 * several batches. A failed batch throws and stops the run; the next run
 * continues from the on-chain batch number. Each credited batch closes the
 * pending batch or stamps at least one uncredited row, so this loop always ends.
 */
async function creditAllBatches(
  deps: NightlyDeps,
  env: NodeJS.ProcessEnv,
  log: (line: string) => void,
  clock: () => number,
): Promise<void> {
  const client = deps.creditClient
  if (!client) return
  let credited = 0
  for (;;) {
    const outcome = await runCreditStep(client, env, clock(), log)
    if (!outcome.ran) {
      if (credited === 0) log(`aupm-nightly: credit skipped — ${outcome.reason}`)
      return
    }
    credited += 1
    log(`aupm-nightly: credited batch ${outcome.batchSeq}, txid ${outcome.creditTxid}`)
    deps.onCredited?.(outcome.batchSeq, outcome.creditTxid)
  }
}

/** Why runNightlyWithLease did not attempt a run, beyond a normal success
 * or a caught failure. */
export type NightlyLeaseOutcome =
  | { status: 'lease-held' }
  | { status: 'success' }
  | { status: 'failed'; error: string }

/**
 * Runs the nightly job once, under the single SQLite lease (item N1.4):
 * acquires it first, records the run's start and end in
 * `nightly_runs` (item N1.5) regardless of outcome, and always releases
 * the lease in a `finally` block. `now` is the caller's own clock reading,
 * so a test never depends on a real wait.
 *
 * WARNING: this function never throws. A failed run logs
 * `aupm-nightly: failed — <reason>` and returns `{ status: 'failed', ...
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
  let report: { status: PushStatus; msg: string } | null = null

  try {
    holder = acquireNightlyLease(startedAt)
    if (!holder) {
      log('aupm-nightly: another run already holds the lease; exiting')
      return { status: 'lease-held' }
    }

    runId = recordNightlyRunStart(startedAt)

    const summary = await runNightly({
      ...deps,
      onCredited: (seq, txid) => {
        batchSeq = seq
        creditTxid = txid
        deps.onCredited?.(seq, txid)
      },
    })
    recordNightlyRunEnd(runId, now().getTime(), 'success', null, batchSeq, creditTxid)
    report = successReport(summary, batchSeq)
    return { status: 'success' }
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err)
    if (runId !== null) {
      recordNightlyRunEnd(runId, now().getTime(), 'failed', reason, batchSeq, creditTxid)
    }
    log(`aupm-nightly: failed — ${reason}`)
    report = { status: 'down', msg: `${NETWORK} failed — ${reason}` }
    return { status: 'failed', error: reason }
  } finally {
    if (holder !== null) {
      releaseNightlyLease(holder)
      if (report) await sendReport(deps, report, log)
    }
  }
}

/** Calls deps.push and swallows its failure: a monitor outage never changes a run's outcome. */
async function sendReport(
  deps: NightlyDeps,
  report: { status: PushStatus; msg: string },
  log: (line: string) => void,
): Promise<void> {
  try {
    await deps.push?.(report.status, report.msg)
  } catch (err) {
    log(`aupm-nightly: push failed — ${err instanceof Error ? err.name : 'error'}`)
  }
}

/** Maps a finished run to the status pushed to the monitor. */
function successReport(
  summary: NightlyRunSummary,
  batchSeq: number | null,
): { status: PushStatus; msg: string } {
  if (summary.configSkip) return { status: 'down', msg: `${NETWORK} ${summary.configSkip}` }
  if (summary.alert) return { status: 'down', msg: `${NETWORK} ${summary.alert}` }
  return {
    status: 'up',
    msg: `${NETWORK} ok batch=${batchSeq ?? 'none'} backlog=${summary.backlog}`,
  }
}
