// proxy/src/claims/ledger.ts
//
// Read/write access to the ledger (accruals, payouts). This is the only
// module in proxy/src/claims that touches SQL directly, besides table
// creation in schema.ts.

import { getStatusOrUnreviewed } from '../status.js'
import {
  type Attribution,
  buildAccrualInputs,
  holdMsFromEnv,
  POOL_ROLES,
  type PoolRole,
} from './attribution-rules.js'
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
 * The repo-pool key for one reviewed package:
 * `audit_status.repo`, resolved and stored only by `scripts/record-review.mjs`
 * at review time. Never fetched here. Falls back to `''` when the row (or
 * its repo) is unknown, so a payment can never fail to accrue for a missing
 * repo key.
 */
function resolveRepoForPackage(pkg: string, version: string): string {
  return getStatusOrUnreviewed(pkg, version).repo ?? ''
}

// ON CONFLICT DO NOTHING makes a replayed settle_txid a no-op: the primary
// key (settle_txid, role, pkg, version, identity) already exists, so the row
// already written wins and no second accrual is written. The batch pointers
// stay NULL until the nightly credit step assigns the row.
const insertAccrual = db.prepare<
  [string, string, string, string, string, string, string, number, number, number, string | null]
>(
  `INSERT INTO accruals
     (settle_txid, route, pkg, version, repo, role, identity, amount_micro, created_at,
      unlock_at, treasury_kind)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (settle_txid, role, pkg, version, identity) DO NOTHING`,
)

const countAccrualsForTxid = db.prepare<[string], { n: number }>(
  'SELECT COUNT(*) as n FROM accruals WHERE settle_txid = ?',
)

/** How long a pool share stays locked after its settlement. Read once at boot. */
const HOLD_MS = holdMsFromEnv(process.env)

/**
 * Write every accrual row for one settled, paid request. Idempotent on
 * (settle_txid, role, pkg, version, identity): replaying the same settle_txid
 * writes no second accrual and leaves the ledger total unchanged. A pool share
 * unlocks `holdMs` after `now`. Cut and ops rows are not held.
 *
 * WARNING: never call this when `attribution.priceMicro` is 0 — the ledger
 * must not accrue against an unpaid request. `buildAccrualInputs` already
 * returns `[]` for a free request, so this is a no-op there, but callers
 * (the middleware) must still gate on a successful settlement first.
 *
 * Returns the number of rows this call newly wrote (0 on a pure replay).
 */
export function writeAccruals(
  attribution: Attribution,
  settleTxid: string,
  now: number = Date.now(),
  holdMs: number = HOLD_MS,
): number {
  const inputs = buildAccrualInputs(attribution)
  if (inputs.length === 0) return 0

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
        now,
        row.held ? now + holdMs : 0,
        row.treasuryKind,
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
  'SELECT role, SUM(amount_micro) as total FROM accruals ' +
    'WHERE identity = ? AND treasury_kind IS NULL GROUP BY role',
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
 * Public and free — reports only this identity's
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
// Freeze, release, slash, forfeit
// ---------------------------------------------------------------------------

/**
 * Selects the uncredited payee shares of one role of one package version.
 * `identity` narrows the selection to one payee, for example one reviewer.
 */
export interface ShareFilter {
  pkg: string
  version: string
  role: PoolRole
  identity?: string
}

function assertPoolRole(fn: string, role: string): void {
  if (!(POOL_ROLES as readonly string[]).includes(role)) {
    throw new Error(`${fn}: role must be one of ${POOL_ROLES.join(', ')}, got "${role}"`)
  }
}

// Every event touches only uncredited payee shares: `paid_seq IS NULL` leaves
// a credited share alone, and `treasury_kind IS NULL` leaves treasury income alone.
const SHARE_SCOPE =
  'pkg = ? AND version = ? AND role = ? AND (? IS NULL OR identity = ?) ' +
  'AND treasury_kind IS NULL AND paid_seq IS NULL'

function shareArgs(filter: ShareFilter): [string, string, string, string | null, string | null] {
  const identity = filter.identity === undefined ? null : canonicalizeIdentity(filter.identity)
  return [filter.pkg, filter.version, filter.role, identity, identity]
}

const freezeStmt = db.prepare(`UPDATE accruals SET frozen = 1 WHERE ${SHARE_SCOPE} AND frozen = 0`)
const releaseStmt = db.prepare(`UPDATE accruals SET frozen = 0 WHERE ${SHARE_SCOPE} AND frozen = 1`)
const convertStmt = db.prepare(
  `UPDATE accruals SET treasury_kind = ?, frozen = 0, unlock_at = 0
   WHERE ${SHARE_SCOPE} AND frozen = 1`,
)

/**
 * Freezes the uncredited payee shares that `filter` selects. A frozen share
 * is never credited. Returns the number of shares frozen.
 */
export function freezeShares(filter: ShareFilter): number {
  assertPoolRole('freezeShares', filter.role)
  return freezeStmt.run(...shareArgs(filter)).changes
}

/**
 * Releases the frozen shares that `filter` selects. A released share keeps its
 * unlock time and is credited once it has matured. Returns the number released.
 */
export function releaseShares(filter: ShareFilter): number {
  assertPoolRole('releaseShares', filter.role)
  return releaseStmt.run(...shareArgs(filter)).changes
}

/**
 * Slashes the frozen reviewer shares of `pkg@version`: each becomes treasury
 * income of kind `slash`, credited in the next batch with no hold. Returns the
 * number of shares slashed.
 */
export function slashShares(filter: Omit<ShareFilter, 'role'>): number {
  return convertStmt.run('slash', ...shareArgs({ ...filter, role: 'reviewer' })).changes
}

/**
 * Forfeits the frozen maintainer shares of `pkg@version`: each becomes
 * treasury income of kind `forfeit`, credited in the next batch with no hold.
 * Returns the number of shares forfeited.
 */
export function forfeitShares(filter: Omit<ShareFilter, 'role'>): number {
  return convertStmt.run('forfeit', ...shareArgs({ ...filter, role: 'maintainer' })).changes
}

// ---------------------------------------------------------------------------
// Batches (nightly credit step)
// ---------------------------------------------------------------------------

/** One `(repo, identity)` amount for `credit()`'s `entries` argument. */
export interface CreditEntry {
  repo: string
  identity: string
  amountMicro: number
}

/** The amounts one `credit()` call carries. */
export interface CreditTotals {
  /** Payments for reviewed resources that this batch counts. */
  newTotalMicro: number
  /** Inflows with no attribution. They go to treasury. */
  unattributedMicro: number
  /** Matured `unallocated`, `slash` and `forfeit` treasury income. */
  treasuryExtraMicro: number
  /** Payee shares, summed per `(repo, identity)`. */
  entries: CreditEntry[]
}

/** The rows one batch counts (`counted`) and credits (`paid`). */
export interface BatchPlan {
  counted: AccrualRow[]
  paid: AccrualRow[]
}

/** True for a share of a pool role, whether it has a payee or not. */
export function isPoolShare(row: AccrualRow): boolean {
  return (POOL_ROLES as readonly string[]).includes(row.role)
}

function addEntry(entries: Map<string, CreditEntry>, row: AccrualRow): void {
  const repo = row.repo ?? ''
  const key = `${repo}\u0000${row.identity}`
  const existing = entries.get(key)
  if (existing) existing.amountMicro += row.amount_micro
  else entries.set(key, { repo, identity: row.identity, amountMicro: row.amount_micro })
}

/**
 * Groups the rows of a batch into the shape `credit()` needs. `counted` rows
 * add to `newTotalMicro`, or to `unattributedMicro` when the row is an
 * unmatched inflow. `paid` rows add to `treasuryExtraMicro` when they carry a
 * treasury kind, and to `entries` otherwise. Entries sum per `(repo,
 * identity)`, never per payment.
 */
export function groupForCredit(plan: BatchPlan): CreditTotals {
  let newTotalMicro = 0
  let unattributedMicro = 0
  let treasuryExtraMicro = 0
  const entries = new Map<string, CreditEntry>()
  for (const row of plan.counted) {
    if (row.route === 'unassigned') unattributedMicro += row.amount_micro
    else newTotalMicro += row.amount_micro
  }
  for (const row of plan.paid) {
    if (row.treasury_kind !== null) treasuryExtraMicro += row.amount_micro
    else addEntry(entries, row)
  }
  return { newTotalMicro, unattributedMicro, treasuryExtraMicro, entries: [...entries.values()] }
}

const listCandidateRows = db.prepare<[], AccrualRow>(
  `SELECT * FROM accruals
   WHERE batch_seq IS NULL
      OR (paid_seq IS NULL AND role IN ('reviewer', 'contributor', 'maintainer'))
   ORDER BY created_at, settle_txid, pkg, version, role, identity`,
)

/**
 * Every row that still needs a batch: a payment no batch counted yet, or a
 * pool share no batch credited yet. Oldest payment first. The caller decides
 * which of them have matured.
 */
export function listCreditCandidates(): AccrualRow[] {
  return listCandidateRows.all()
}

const listPaidRowsForBatch = db.prepare<[number, number], AccrualRow>(
  'SELECT * FROM accruals WHERE paid_app_id = ? AND paid_seq = ? ORDER BY created_at, settle_txid',
)

/**
 * Rebuilds the `entries` of a batch from the rows it credited. A resend of a
 * batch that crashed before its credit txid was recorded uses exactly these
 * rows, never a fresh snapshot (see `getPendingBatch`).
 */
export function summarizeBatch(appId: number, batchSeq: number): CreditEntry[] {
  return groupForCredit({ counted: [], paid: listPaidRowsForBatch.all(appId, batchSeq) }).entries
}

const ROW_KEY = 'settle_txid = ? AND role = ? AND pkg = ? AND version = ? AND identity = ?'
const assignCounted = db.prepare(
  `UPDATE accruals SET batch_app_id = ?, batch_seq = ? WHERE ${ROW_KEY} AND batch_seq IS NULL`,
)
const assignPaid = db.prepare(
  `UPDATE accruals SET paid_app_id = ?, paid_seq = ?
   WHERE ${ROW_KEY} AND paid_seq IS NULL AND frozen = 0`,
)

const getLastBatchRow = db.prepare<[number], { batch_seq: number }>(
  'SELECT batch_seq FROM batches WHERE app_id = ? ORDER BY batch_seq DESC LIMIT 1',
)

/** The last batch number `appId` has a row for, or 0 before its first batch. */
export function getLastBatchSeq(appId: number): number {
  return getLastBatchRow.get(appId)?.batch_seq ?? 0
}

const getPendingBatchRow = db.prepare<[number], BatchRow>(
  'SELECT * FROM batches WHERE app_id = ? AND credit_txid IS NULL ' +
    'ORDER BY batch_seq DESC LIMIT 1',
)

/**
 * The one batch row of `appId` with an assigned `batch_seq` but no recorded
 * credit txid — a crash between "assign rows to a batch" and "record the
 * credit txid". Resend exactly this batch; never open a new one while it
 * exists.
 */
export function getPendingBatch(appId: number): BatchRow | null {
  return getPendingBatchRow.get(appId) ?? null
}

const insertBatch = db.prepare<[number, number, number, number, number, number]>(
  `INSERT INTO batches
     (app_id, batch_seq, new_total_micro, unattributed_micro, treasury_extra_micro, created_at)
   VALUES (?, ?, ?, ?, ?, ?)`,
)

function assignRows(
  stmt: typeof assignCounted,
  what: string,
  appId: number,
  batchSeq: number,
  rows: AccrualRow[],
): void {
  for (const row of rows) {
    const key = [row.settle_txid, row.role, row.pkg, row.version, row.identity]
    if (stmt.run(appId, batchSeq, ...key).changes !== 1) {
      throw new Error(
        `openBatch: accrual (${key.join(', ')}) is missing, frozen or already ${what}; ` +
          `batch ${batchSeq} was not opened (app ${appId})`,
      )
    }
  }
}

/**
 * Opens batch `batchSeq` of `appId` for `plan`, before `credit()` is called:
 * inserts the batch row with the totals of the plan, counts each `counted`
 * row and credits each `paid` row to the batch, in one SQLite transaction.
 * `credit_txid` starts NULL. Throws, and writes nothing, when a row is
 * missing, frozen, or already in a batch.
 *
 * @returns the totals and entries of the plan — what `credit()` must send.
 */
export const openBatch = db.transaction(
  (appId: number, batchSeq: number, plan: BatchPlan): CreditTotals => {
    const totals = groupForCredit(plan)
    insertBatch.run(
      appId,
      batchSeq,
      totals.newTotalMicro,
      totals.unattributedMicro,
      totals.treasuryExtraMicro,
      Date.now(),
    )
    assignRows(assignCounted, 'counted', appId, batchSeq, plan.counted)
    assignRows(assignPaid, 'credited', appId, batchSeq, plan.paid)
    return totals
  },
)

const unassignCounted = db.prepare<[number, number]>(
  'UPDATE accruals SET batch_app_id = NULL, batch_seq = NULL ' +
    'WHERE batch_app_id = ? AND batch_seq = ?',
)
const unassignPaid = db.prepare<[number, number]>(
  'UPDATE accruals SET paid_app_id = NULL, paid_seq = NULL WHERE paid_app_id = ? AND paid_seq = ?',
)
const deletePendingBatchRow = db.prepare<[number, number]>(
  'DELETE FROM batches WHERE app_id = ? AND batch_seq = ? AND credit_txid IS NULL',
)

/**
 * Undoes `openBatch` for a pending batch whose credit() call can never
 * confirm: returns its rows to uncounted and uncredited and deletes its batch
 * row, in one SQLite transaction. The caller proves first that the chain never
 * credited this batch (see `runCreditStep`). Throws, and writes nothing, when
 * the batch is missing or already has a credit txid.
 */
export const releaseBatch = db.transaction((appId: number, batchSeq: number): void => {
  unassignCounted.run(appId, batchSeq)
  unassignPaid.run(appId, batchSeq)
  const { changes } = deletePendingBatchRow.run(appId, batchSeq)
  if (changes !== 1) {
    throw new Error(
      `releaseBatch: batch ${batchSeq} is missing or already credited (app ${appId}); ` +
        'nothing was released',
    )
  }
})

const recordCreditTxidStmt = db.prepare<[string, number, number]>(
  'UPDATE batches SET credit_txid = ? WHERE app_id = ? AND batch_seq = ?',
)

/** Records the confirmed credit() txid on batch `batchSeq` of `appId`. A
 * batch row whose txid is recorded is never sent again. */
export function recordBatchCreditTxid(appId: number, batchSeq: number, txid: string): void {
  recordCreditTxidStmt.run(txid, appId, batchSeq)
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
 * Record a manual, human-checked payout.
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
