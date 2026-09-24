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
}
