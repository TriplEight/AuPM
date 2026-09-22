// proxy/src/claims/reconcile.ts
//
// Nightly reconciliation (SPEC.md 5.2). Lists USDC transfers into payTo
// via the indexer and compares them with ledger settle_txid values.
// Unmatched inflows — a crash between settle and write, or a direct
// deposit — are ledgered as `unassigned` so the ledger total never falls
// behind the pool balance.
//
// Reads the indexer through an injectable client: production code passes a
// real client, tests pass a stub, so no test in this directory performs a
// network call.

import { computeRoleShareMicro, ROLES, UNASSIGNED } from './attribution-rules.js'
import db from './schema.js'

export interface UsdcInflow {
  txid: string
  amountMicro: number
  /** Indexer round-time: unix seconds the confirming block landed. */
  confirmedAt: number
}

/** Reads confirmed USDC axfers into `payTo` from an Algorand indexer. */
export interface IndexerClient {
  listUsdcInflows(payTo: string): Promise<UsdcInflow[]>
}

/**
 * Minimum age, in seconds, an inflow must have before this pass considers
 * it at all. Closes the settle-to-write race: the claims middleware writes
 * accrual rows synchronously, right after settlement, in the same request —
 * a matter of seconds. A run landing inside that narrow window would see
 * the on-chain inflow but not yet the accrual row, and would wrongly
 * ledger it `unassigned`; the middleware then writes the real rows for the
 * same txid, and the inflow counts twice. 900 seconds is a wide margin
 * past that window, not a tuned constant — do not add an env var for it.
 */
export const MIN_INFLOW_AGE_SECONDS = 900

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

/** Why `ledgerUnassignedInflow` declined to ledger an inflow. */
export type SkipReason = 'not-a-multiple-of-1000-microusdc' | 'non-positive-amount'

export interface SkippedInflow {
  inflow: UsdcInflow
  reason: SkipReason
}

/**
 * Ledger one unmatched inflow as `unassigned` across the three ledgered
 * roles, using the same integer role-share split as a normal payment
 * (CLAUDE.md: money is always integer micro-units). route is recorded as
 * "unassigned" since no attribution data exists for a direct deposit or a
 * crash between settle and write.
 *
 * Returns the skip reason when the inflow was not ledgered (so the caller
 * can report it), or null when it was ledgered.
 */
function ledgerUnassignedInflow(inflow: UsdcInflow): SkipReason | null {
  if (inflow.amountMicro <= 0) return 'non-positive-amount'
  if (inflow.amountMicro % 1000 !== 0) return 'not-a-multiple-of-1000-microusdc'
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
  return null
}

export interface ReconcileResult {
  inflowsChecked: number
  /** Count of unmatched inflows actually written to the ledger this pass. */
  unmatchedLedgered: number
  /** Unmatched inflows this pass declined to ledger, with the reason why. */
  skipped: SkippedInflow[]
}

/**
 * True once `inflow` is at least `MIN_INFLOW_AGE_SECONDS` old, as of
 * `nowSeconds`. A young inflow is left for a later pass rather than
 * ledgered now — see `MIN_INFLOW_AGE_SECONDS`.
 */
function isMatureEnough(inflow: UsdcInflow, nowSeconds: number): boolean {
  return nowSeconds - inflow.confirmedAt >= MIN_INFLOW_AGE_SECONDS
}

/**
 * Run one reconciliation pass. Idempotent: a re-run over the same inflows
 * ledgers nothing new. `nowSeconds` defaults to the real clock; a caller
 * passes it explicitly only in tests.
 *
 * `inflowsChecked` counts every inflow the indexer returned this pass,
 * mature or not — it reports total volume seen, not just what this pass
 * acted on.
 */
export async function reconcile(
  payTo: string,
  indexer: IndexerClient,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): Promise<ReconcileResult> {
  const inflows = await indexer.listUsdcInflows(payTo)
  const mature = inflows.filter((inflow) => isMatureEnough(inflow, nowSeconds))
  const unmatched = findUnmatchedInflows(mature)

  let unmatchedLedgered = 0
  const skipped: SkippedInflow[] = []
  for (const inflow of unmatched) {
    const reason = ledgerUnassignedInflow(inflow)
    if (reason === null) unmatchedLedgered += 1
    else skipped.push({ inflow, reason })
  }

  return { inflowsChecked: inflows.length, unmatchedLedgered, skipped }
}
