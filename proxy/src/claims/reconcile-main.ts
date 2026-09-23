// proxy/src/claims/reconcile-main.ts
//
// Nightly claims-ledger reconciliation runner (SPEC.md 5.2, CLAUDE.md
// invariant 2). An external cron or systemd timer starts this script — it
// holds no scheduling logic of its own. It imports reconcile() and
// createIndexerClient() from this directory and
// adds no reconciliation logic of its own; the unit tests for those two
// modules (indexer.test.ts, reconcile.test.ts) are the ones that exercise
// this behavior.
//
// Run with: pnpm -C proxy reconcile

import { assertValidPayTo, PAY_TO, USDC_ASA_ID } from '../config.js'
import db from '../db.js'
import { createIndexerClient } from './indexer.js'
import { type ReconcileResult, reconcile } from './reconcile.js'

// INDEXER_URL is read here, not from proxy/src/config.ts — the running
// proxy never talks to an indexer, only this offline runner does (see
// indexer.ts's createIndexerClient doc comment).
const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud'

function printResult(result: ReconcileResult): void {
  console.log(`spm-reconcile: checked ${result.inflowsChecked} inflow(s)`)
  console.log(`  ledgered as unassigned: ${result.unmatchedLedgered}`)
  if (result.skipped.length > 0) {
    console.log(`  skipped: ${result.skipped.length}`)
    for (const s of result.skipped) {
      console.log(`    ${s.inflow.txid}\tamount_micro=${s.inflow.amountMicro}\treason=${s.reason}`)
    }
  }
}

async function main(): Promise<void> {
  // payTo guard: cheap, local, no I/O — checked before the indexer call.
  // Reuses proxy/src/config.ts's own boot guard rather than a second copy
  // of the same validation, and its error message names PAY_TO_ADDRESS.
  assertValidPayTo()

  const indexerUrl = process.env.INDEXER_URL ?? DEFAULT_INDEXER_URL
  const indexer = createIndexerClient(indexerUrl, USDC_ASA_ID)

  printResult(await reconcile(PAY_TO, indexer))
}

main()
  .catch((err: unknown) => {
    console.error('spm-reconcile: failed —', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => {
    db.close()
  })
