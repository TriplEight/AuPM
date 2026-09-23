// proxy/src/claims/nightly.ts
//
// The nightly job's testable orchestration (SPEC.md §13.2, ADR 0001, ADR
// 0005), in order: reconcile -> back up -> credit. A failed backup stops
// the job before the credit step: `runNightly` lets `deps.backup()`'s
// error propagate uncaught, so nothing after it ever runs.
//
// This module holds the logic; it performs no environment reads and no
// network I/O of its own — nightly-main.ts wires the real indexer, algod
// client, and SQLite backup step and is the process entry point a systemd
// timer runs (`docker compose run --rm proxy pnpm nightly`). This split
// mirrors reconcile.ts/reconcile-main.ts: runNightly() is what this
// directory's own tests exercise directly, with a stub indexer, a stub
// backup step, and a stub credit chain client — never a live network or
// chain call.

import { PAY_TO } from '../config.js'
import { type CreditChainClient, runCreditStep } from './credit.js'
import { type IndexerClient, reconcile } from './reconcile.js'

export interface NightlyDeps {
  indexer: IndexerClient
  /** Runs the backup step and returns the backup path. Throws on failure —
   * see this module's banner comment: that throw stops the job here. */
  backup: () => string
  /** null when CREDITER_MNEMONIC is unset — the credit step then logs why
   * and stops (SPEC.md §13.2 step 3), the same as an unset app id. */
  creditClient: CreditChainClient | null
  env?: NodeJS.ProcessEnv
  log?: (line: string) => void
}

/**
 * Runs the nightly job once: reconcile, then back up, then credit — always
 * in that order (SPEC.md §13.2).
 */
export async function runNightly(deps: NightlyDeps): Promise<void> {
  const log = deps.log ?? console.log
  const env = deps.env ?? process.env

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
}
