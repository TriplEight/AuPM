// proxy/src/claims/ledger.ts
//
// Read/write access to the ledger (accruals, payouts). This is the only
// module in proxy/src/claims that touches SQL directly, besides table
// creation in schema.ts.

import { getStatusOrUnreviewed } from '../status.js'
import { type Attribution, buildAccrualInputs } from './attribution-rules.js'
import db, { type AccrualRow, type BatchRow, type PayoutRow } from './schema.js'

// ---------------------------------------------------------------------------
// Identity canonicalisation
// ---------------------------------------------------------------------------

/**
 * Canonical form for every stored identity string. Lower-cases the whole
 * string, so `github:Alice` and `github:alice` always collapse to the same
 * row and join key. Apply this everywhere an identity is written or looked
 * up: accrual writes and the earnings lookup. That keeps a row from ever
 * being written in a non-canonical form.
 */
function canonicalizeIdentity(identity: string): string {
  return identity.toLowerCase()
}

// ---------------------------------------------------------------------------
// Accruals
// ---------------------------------------------------------------------------

/**
 * The repo-pool key for one reviewed package (SPEC.md §13.1, §13.2):
 * `audit_status.repo`, resolved and stored only by `scripts/record-review.mjs`
 * at review time. Never fetched here. Falls back to `''` when the row (or
 * its repo) is unknown, so a payment can never fail to accrue for a missing
 * repo key.
 */
function resolveRepoForPackage(pkg: string, version: string): string {
  return getStatusOrUnreviewed(pkg, version).repo ?? ''
}

// ON CONFLICT DO NOTHING makes a replayed settle_txid a no-op: the primary
// key (settle_txid, role, pkg, version) already exists, so the row already
// written wins and no second accrual is written (SPEC.md 5.2, CLAUDE.md
// invariant "idempotent"). batch_seq is never set here — NULL until the
// nightly credit step assigns this row to a batch (ADR 0005).
const insertAccrual = db.prepare<
  [string, string, string, string, string, string, string, number, number]
>(
  `INSERT INTO accruals
     (settle_txid, route, pkg, version, repo, role, identity, amount_micro, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (settle_txid, role, pkg, version) DO NOTHING`,
)

const countAccrualsForTxid = db.prepare<[string], { n: number }>(
  'SELECT COUNT(*) as n FROM accruals WHERE settle_txid = ?',
)

/**
 * Write every accrual row for one settled, paid request. Idempotent on
 * (settle_txid, role, pkg, version): replaying the same settle_txid writes
 * no second accrual and leaves the ledger total unchanged.
 *
 * WARNING: never call this when `attribution.priceMicro` is 0 — the ledger
 * must not accrue against an unpaid request. `buildAccrualInputs` already
 * returns `[]` for a free request, so this is a no-op there, but callers
 * (the middleware) must still gate on a successful settlement first.
 *
 * Returns the number of rows this call newly wrote (0 on a pure replay).
 */
export function writeAccruals(attribution: Attribution, settleTxid: string): number {
  const inputs = buildAccrualInputs(attribution)
  if (inputs.length === 0) return 0

  const createdAt = Date.now()
  let written = 0
  const runAll = db.transaction((rows: typeof inputs) => {
    for (const row of rows) {
      const result = insertAccrual.run(
        settleTxid,
        row.route,
        row.pkg,
        row.version,
        resolveRepoForPackage(row.pkg, row.version),
        row.role,
        canonicalizeIdentity(row.identity),
        row.amountMicro,
        createdAt,
      )
      written += result.changes
    }
  })
  runAll(inputs)
  return written
}

export function accrualCountForTxid(settleTxid: string): number {
  return countAccrualsForTxid.get(settleTxid)?.n ?? 0
}

const listAccrualsForTxid = db.prepare<[string], AccrualRow>(
  'SELECT * FROM accruals WHERE settle_txid = ? ORDER BY pkg, version, role',
)

export function getAccrualsForTxid(settleTxid: string): AccrualRow[] {
  return listAccrualsForTxid.all(settleTxid)
}

const sumAccrualsByIdentityAndRole = db.prepare<[string], { role: string; total: number }>(
  'SELECT role, SUM(amount_micro) as total FROM accruals WHERE identity = ? GROUP BY role',
)

const sumPaidByIdentityAndRole = db.prepare<[string], { role: string; total: number }>(
  'SELECT role, SUM(amount_micro) as total FROM payouts WHERE identity = ? GROUP BY role',
)

export interface RoleEarnings {
  role: string
  accruedMicro: number
  claimedMicro: number
}

export interface Earnings {
  identity: string
  roles: RoleEarnings[]
  totalAccruedMicro: number
  totalClaimedMicro: number
}

/**
 * Accrued and claimed (paid out) totals per role for one GitHub login.
 * Public and free (SPEC.md 5.3 step 1) — reports only this identity's
 * own data, never another identity's.
 */
export function getEarningsForLogin(login: string): Earnings {
  const identity = canonicalizeIdentity(`github:${login}`)
  const accrued = new Map<string, number>()
  for (const row of sumAccrualsByIdentityAndRole.all(identity)) accrued.set(row.role, row.total)

  const claimed = new Map<string, number>()
  for (const row of sumPaidByIdentityAndRole.all(identity)) claimed.set(row.role, row.total)

  const roles = new Set([...accrued.keys(), ...claimed.keys()])
  const roleEarnings: RoleEarnings[] = [...roles].sort().map((role) => ({
    role,
    accruedMicro: accrued.get(role) ?? 0,
    claimedMicro: claimed.get(role) ?? 0,
  }))

  return {
    identity,
    roles: roleEarnings,
    totalAccruedMicro: roleEarnings.reduce((sum, r) => sum + r.accruedMicro, 0),
    totalClaimedMicro: roleEarnings.reduce((sum, r) => sum + r.claimedMicro, 0),
  }
}

// ---------------------------------------------------------------------------
// Batches (nightly credit step, SPEC.md §13.2, ADR 0005)
// ---------------------------------------------------------------------------

/** One `(repo, identity)` amount for `credit()`'s `entries` argument. */
export interface CreditEntry {
  repo: string
  identity: string
  amountMicro: number
}

export interface UncreditedTotals {
  /** Sum of every non-`unassigned` row: `credit()`'s `attributedTotal`. */
  attributedMicro: number
  /** Sum of every `unassigned` row: `credit()`'s `unattributedTotal`. */
  unattributedMicro: number
  /** Auditor-role, non-`unassigned` rows, summed per `(repo, identity)`. */
  entries: CreditEntry[]
}

/**
 * Groups accrual rows into the shape `credit()` needs (ADR 0005):
 * `attributedMicro` sums every row from a real payment; `unattributedMicro`
 * sums every `unassigned` row (an unmatched inflow, SPEC.md §13.2);
 * `entries` are the auditor-role rows of a real payment, summed per
 * `(repo, identity)` — never split per payment, and never per package
 * within the same `(repo, identity)` pair.
 */
function groupForCredit(rows: AccrualRow[]): UncreditedTotals {
  let attributedMicro = 0
  let unattributedMicro = 0
  const entryTotals = new Map<string, CreditEntry>()

  for (const row of rows) {
    if (row.route === 'unassigned') {
      unattributedMicro += row.amount_micro
      continue
    }
    attributedMicro += row.amount_micro
    if (row.role !== 'auditor') continue
    const repo = row.repo ?? ''
    const key = `${repo}\u0000${row.identity}`
    const existing = entryTotals.get(key)
    if (existing) existing.amountMicro += row.amount_micro
    else entryTotals.set(key, { repo, identity: row.identity, amountMicro: row.amount_micro })
  }

  return { attributedMicro, unattributedMicro, entries: [...entryTotals.values()] }
}

const listUncreditedRows = db.prepare<[], AccrualRow>(
  'SELECT * FROM accruals WHERE batch_seq IS NULL',
)

/** Every accrual row not yet assigned to a batch, grouped for `credit()`. */
export function summarizeUncredited(): UncreditedTotals {
  return groupForCredit(listUncreditedRows.all())
}

const listRowsForBatch = db.prepare<[number], AccrualRow>(
  'SELECT * FROM accruals WHERE batch_seq = ?',
)

/**
 * Rebuilds the same `entries` for a batch's already-assigned rows — used to
 * resend a batch that crashed before its credit txid was recorded, so the
 * resend uses exactly the rows the first attempt assigned (see
 * `getPendingBatch`), never a fresh snapshot of "uncredited".
 */
export function summarizeBatch(batchSeq: number): UncreditedTotals {
  return groupForCredit(listRowsForBatch.all(batchSeq))
}

const assignBatchSeq = db.prepare<[number]>(
  'UPDATE accruals SET batch_seq = ? WHERE batch_seq IS NULL',
)

/** Assigns every still-uncredited accrual row to `batchSeq`. */
export function assignUncreditedToBatch(batchSeq: number): void {
  assignBatchSeq.run(batchSeq)
}

const getLastBatchRow = db.prepare<[], { batch_seq: number }>(
  'SELECT batch_seq FROM batches ORDER BY batch_seq DESC LIMIT 1',
)

/** The last batch number a row exists for, or 0 before the first batch. */
export function getLastBatchSeq(): number {
  return getLastBatchRow.get()?.batch_seq ?? 0
}

const getPendingBatchRow = db.prepare<[], BatchRow>(
  'SELECT * FROM batches WHERE credit_txid IS NULL ORDER BY batch_seq DESC LIMIT 1',
)

/**
 * The one batch row with an assigned `batch_seq` but no recorded credit
 * txid — a crash between "assign rows to a batch" and "record the credit
 * txid". Resend exactly this batch; never open a new one while it exists
 * (SPEC.md §13.2).
 */
export function getPendingBatch(): BatchRow | null {
  return getPendingBatchRow.get() ?? null
}

const insertBatch = db.prepare<[number, number, number, number]>(
  `INSERT INTO batches (batch_seq, attributed_micro, unattributed_micro, created_at)
   VALUES (?, ?, ?, ?)`,
)

/** Opens batch `batchSeq` with its totals, before its rows are stamped and
 * before `credit()` is called. `credit_txid` starts NULL. */
export function insertPendingBatch(
  batchSeq: number,
  attributedMicro: number,
  unattributedMicro: number,
): void {
  insertBatch.run(batchSeq, attributedMicro, unattributedMicro, Date.now())
}

const recordCreditTxidStmt = db.prepare<[string, number]>(
  'UPDATE batches SET credit_txid = ? WHERE batch_seq = ?',
)

/** Records the confirmed credit() txid on `batchSeq`. A batch row whose
 * txid is recorded is never sent again (SPEC.md §13.2). */
export function recordBatchCreditTxid(batchSeq: number, txid: string): void {
  recordCreditTxidStmt.run(txid, batchSeq)
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

const insertPayout = db.prepare<[string, string, number, string, number]>(
  `INSERT INTO payouts (identity, role, amount_micro, txid, paid_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (identity, role, txid) DO NOTHING`,
)

/**
 * Record a manual, human-checked payout (SPEC.md 5.3 step 5).
 *
 * CAUTION: canonicalises `identity` on the way in, same as every other
 * write in this module, so a manually-typed mixed-case identity still joins
 * against the accruals this payout is settling.
 */
export function recordPayout(
  identity: string,
  role: string,
  amountMicro: number,
  txid: string,
): void {
  insertPayout.run(canonicalizeIdentity(identity), role, amountMicro, txid, Date.now())
}

export function listPayoutsForIdentity(identity: string): PayoutRow[] {
  return db
    .prepare<[string], PayoutRow>('SELECT * FROM payouts WHERE identity = ?')
    .all(canonicalizeIdentity(identity))
}
