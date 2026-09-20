// proxy/src/claims/reconcile.ts
//
// Nightly reconciliation (SPEC-v3.md 5.2). Lists USDC transfers into payTo
// via the indexer and compares them with ledger settle_txid values.
// Unmatched inflows — a crash between settle and write, or a direct
// deposit — are ledgered as `unassigned` so the ledger total never falls
// behind the pool balance.
//
// Reads the indexer through an injectable client, the same shape as
// ledger.ts's GithubClient: production code passes a real client, tests
// pass a stub, so no test in this directory performs a network call.

import { computeRoleShareMicro, ROLES, UNASSIGNED } from './attribution-rules.js'
import db from './schema.js'

export interface UsdcInflow {
  txid: string
  amountMicro: number
}

/** Reads confirmed USDC axfers into `payTo` from an Algorand indexer. */
export interface IndexerClient {
  listUsdcInflows(payTo: string): Promise<UsdcInflow[]>
}

const accrualExistsForTxid = db.prepare<[string], { n: number }>(
  'SELECT COUNT(*) as n FROM accruals WHERE settle_txid = ?',
)

const insertUnassignedAccrual = db.prepare<
  [string, string, string, string, string, string, number, number]
>(
  `INSERT INTO accruals
     (settle_txid, route, pkg, version, role, identity, amount_micro, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (settle_txid, role, pkg, version) DO NOTHING`,
)

/**
 * Find inflows with no matching ledger row at all. An inflow already
 * partially or fully ledgered (a real settlement that wrote accruals) is
 * never touched here — only a txid with zero accrual rows counts as
 * unmatched.
 */
export function findUnmatchedInflows(inflows: UsdcInflow[]): UsdcInflow[] {
  return inflows.filter((inflow) => (accrualExistsForTxid.get(inflow.txid)?.n ?? 0) === 0)
}

/**
 * Ledger one unmatched inflow as `unassigned` across the three ledgered
 * roles, using the same integer role-share split as a normal payment
 * (CLAUDE.md: money is always integer micro-units). route is recorded as
 * "unassigned" since no attribution data exists for a direct deposit or a
 * crash between settle and write.
 */
function ledgerUnassignedInflow(inflow: UsdcInflow): void {
  if (inflow.amountMicro <= 0 || inflow.amountMicro % 1000 !== 0) return
  const createdAt = Date.now()
  const runAll = db.transaction(() => {
    for (const role of ROLES) {
      const amountMicro = computeRoleShareMicro(inflow.amountMicro, role)
      insertUnassignedAccrual.run(
        inflow.txid,
        'unassigned',
        '(unassigned)',
        '',
        role,
        UNASSIGNED,
        amountMicro,
        createdAt,
      )
    }
  })
  runAll()
}

export interface ReconcileResult {
  inflowsChecked: number
  unmatchedLedgered: number
}

/** Run one reconciliation pass. Idempotent: a re-run over the same inflows ledgers nothing new. */
export async function reconcile(payTo: string, indexer: IndexerClient): Promise<ReconcileResult> {
  const inflows = await indexer.listUsdcInflows(payTo)
  const unmatched = findUnmatchedInflows(inflows)
  for (const inflow of unmatched) ledgerUnassignedInflow(inflow)
  return { inflowsChecked: inflows.length, unmatchedLedgered: unmatched.length }
}
