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
import db, {
  type AccrualRow,
  type BacklogRow,
  type BatchRow,
  type PayeeRow,
  type PayoutRow,
} from './schema.js'

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

// A freeze acts only on a held share: one whose hold has not ended (`unlock_at`
// after the clock). A matured share waits for its payout threshold, out of
// reach of a freeze. Release, slash and forfeit act on frozen shares only, and
// a share frozen before its hold ended stays under dispute after it.
const freezeStmt = db.prepare(
  `UPDATE accruals SET frozen = 1 WHERE ${SHARE_SCOPE} AND frozen = 0 AND unlock_at > ?`,
)
const releaseStmt = db.prepare(`UPDATE accruals SET frozen = 0 WHERE ${SHARE_SCOPE} AND frozen = 1`)
const convertStmt = db.prepare(
  `UPDATE accruals SET treasury_kind = ?, frozen = 0, unlock_at = 0
   WHERE ${SHARE_SCOPE} AND frozen = 1`,
)

/**
 * Freezes the held payee shares that `filter` selects: uncredited shares whose
 * hold has not ended at `now`. A frozen share is never credited. Returns the
 * number of shares frozen.
 */
export function freezeShares(filter: ShareFilter, now: number = Date.now()): number {
  assertPoolRole('freezeShares', filter.role)
  return freezeStmt.run(...shareArgs(filter), now).changes
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

/** One payee payout for `credit()`'s `payouts` argument. */
export interface CreditPayout {
  identity: string
  address: string
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
  /** Payee shares, summed per payee. */
  payouts: CreditPayout[]
}

/** The rows one batch counts (`counted`) and credits (`paid`). */
export interface BatchPlan {
  counted: AccrualRow[]
  paid: AccrualRow[]
  /** Payout address of each payee identity in `paid`. */
  addresses?: Readonly<Record<string, string>>
}

/** True for a share of a pool role, whether it has a payee or not. */
export function isPoolShare(row: AccrualRow): boolean {
  return (POOL_ROLES as readonly string[]).includes(row.role)
}

/**
 * Groups the rows of a batch into the shape `credit()` needs. `counted` rows
 * add to `newTotalMicro`, or to `unattributedMicro` when the row is an
 * unmatched inflow. `paid` rows add to `treasuryExtraMicro` when they carry a
 * treasury kind, and to `payouts` otherwise. Payouts sum per payee, never per
 * payment, sort by identity (the order of a stored batch) and each needs an address in `plan.addresses`.
 */
export function groupForCredit(plan: BatchPlan): CreditTotals {
  let newTotalMicro = 0
  let unattributedMicro = 0
  let treasuryExtraMicro = 0
  const payouts = new Map<string, CreditPayout>()
  for (const row of plan.counted) {
    if (row.route === 'unassigned') unattributedMicro += row.amount_micro
    else newTotalMicro += row.amount_micro
  }
  for (const row of plan.paid) {
    if (row.treasury_kind !== null) {
      treasuryExtraMicro += row.amount_micro
      continue
    }
    const existing = payouts.get(row.identity)
    if (existing) {
      existing.amountMicro += row.amount_micro
      continue
    }
    const address = plan.addresses?.[row.identity]
    if (address === undefined) {
      throw new Error(`groupForCredit: payee ${row.identity} has no payout address in the plan`)
    }
    payouts.set(row.identity, { identity: row.identity, address, amountMicro: row.amount_micro })
  }
  return {
    newTotalMicro,
    unattributedMicro,
    treasuryExtraMicro,
    payouts: [...payouts.values()].sort((a, b) => (a.identity < b.identity ? -1 : 1)),
  }
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

const listBatchPayoutRows = db.prepare<
  [number, number],
  { identity: string; address: string; amount_micro: number }
>(
  'SELECT identity, address, amount_micro FROM batch_payouts ' +
    'WHERE app_id = ? AND batch_seq = ? ORDER BY identity',
)

/**
 * The payouts of a batch, as stored when the batch opened. A resend of a batch
 * that crashed before its credit txid was recorded uses exactly these payouts,
 * never a fresh snapshot (see `getPendingBatch`).
 */
export function listBatchPayouts(appId: number, batchSeq: number): CreditPayout[] {
  return listBatchPayoutRows.all(appId, batchSeq).map((row) => ({
    identity: row.identity,
    address: row.address,
    amountMicro: row.amount_micro,
  }))
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
const insertBatchPayout = db.prepare<[number, number, string, string, number]>(
  `INSERT INTO batch_payouts (app_id, batch_seq, identity, address, amount_micro)
   VALUES (?, ?, ?, ?, ?)`,
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
 * @returns the totals and payouts of the plan — what `credit()` must send.
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
    for (const payout of totals.payouts) {
      insertBatchPayout.run(appId, batchSeq, payout.identity, payout.address, payout.amountMicro)
    }
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
const deleteBatchPayouts = db.prepare<[number, number]>(
  'DELETE FROM batch_payouts WHERE app_id = ? AND batch_seq = ?',
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
  deleteBatchPayouts.run(appId, batchSeq)
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
const stampPayeesStmt = db.prepare<[number, number, number]>(
  `UPDATE payees SET last_payout_at = ?
   WHERE identity IN (SELECT identity FROM batch_payouts WHERE app_id = ? AND batch_seq = ?)`,
)
const recordBatchPayoutsStmt = db.prepare<[string, number, number, number]>(
  `INSERT INTO payouts (identity, role, amount_micro, txid, paid_at)
   SELECT identity, role, SUM(amount_micro), ?, ? FROM accruals
   WHERE paid_app_id = ? AND paid_seq = ? AND treasury_kind IS NULL
     AND role IN ('reviewer', 'contributor', 'maintainer')
   GROUP BY identity, role
   ON CONFLICT (identity, role, txid) DO NOTHING`,
)

/**
 * Records the confirmed credit() txid on batch `batchSeq` of `appId`, in one
 * SQLite transaction. A batch row whose txid is recorded is never sent again.
 * It also stamps `last_payout_at` of every payee the batch paid with `now`,
 * and records what each payee received per role in `payouts`.
 */
export const recordBatchCreditTxid = db.transaction(
  (appId: number, batchSeq: number, txid: string, now: number = Date.now()): void => {
    recordCreditTxidStmt.run(txid, appId, batchSeq)
    stampPayeesStmt.run(now, appId, batchSeq)
    recordBatchPayoutsStmt.run(txid, now, appId, batchSeq)
  },
)

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

// ---------------------------------------------------------------------------
// Payees and payout balances
// ---------------------------------------------------------------------------

const upsertPayeeStmt = db.prepare<[string, string, number, number]>(
  `INSERT INTO payees (identity, payout_address, onboarded_at, last_optin_check)
   VALUES (?, ?, ?, ?)
   ON CONFLICT (identity) DO UPDATE
     SET payout_address = excluded.payout_address, last_optin_check = excluded.last_optin_check`,
)

/**
 * Adds a payee, or changes the payout address of an existing one. A change keeps
 * `onboarded_at` and `last_payout_at`. `checkedAt` is the time (ms) of the algod
 * check that approved the address. An ops action: no multisig is involved.
 */
export function upsertPayee(
  identity: string,
  payoutAddress: string,
  onboardedAt: number,
  checkedAt: number,
): void {
  upsertPayeeStmt.run(canonicalizeIdentity(identity), payoutAddress, onboardedAt, checkedAt)
}

export function getPayee(identity: string): PayeeRow | undefined {
  return db
    .prepare<[string], PayeeRow>('SELECT * FROM payees WHERE identity = ?')
    .get(canonicalizeIdentity(identity))
}

export function listPayees(): PayeeRow[] {
  return db.prepare<[], PayeeRow>('SELECT * FROM payees ORDER BY identity').all()
}

const touchPayeeStmt = db.prepare<[number, string]>(
  'UPDATE payees SET last_optin_check = ? WHERE identity = ?',
)

/** Records the time (ms) of the last opt-in check of a payee's address. */
export function touchPayeeOptInCheck(identity: string, checkedAt: number): void {
  touchPayeeStmt.run(checkedAt, canonicalizeIdentity(identity))
}

/** A payee's matured, unfrozen, unpaid pool balance in micro-USDC. */
export interface PayeeBalance {
  identity: string
  balanceMicro: number
}

const listBalancesStmt = db.prepare<[number], { identity: string; total: number }>(
  `SELECT identity, SUM(amount_micro) AS total FROM accruals
   WHERE paid_seq IS NULL AND treasury_kind IS NULL AND frozen = 0 AND unlock_at <= ?
     AND role IN ('reviewer', 'contributor', 'maintainer')
   GROUP BY identity ORDER BY identity`,
)

/**
 * The matured, unfrozen, unpaid balance of every payee identity at `now`. A
 * share inside its hold, a frozen share and a credited share do not count.
 */
export function listPayeeBalances(now: number): PayeeBalance[] {
  return listBalancesStmt
    .all(now)
    .map((row) => ({ identity: row.identity, balanceMicro: row.total }))
}

const selectPreviousDayStmt = db.prepare<[number], BacklogRow>(
  'SELECT * FROM backlog_days WHERE day < ? ORDER BY day DESC LIMIT 1',
)
const upsertDayStmt = db.prepare<[number, number, number]>(
  `INSERT INTO backlog_days (day, total_micro, grew_streak) VALUES (?, ?, ?)
   ON CONFLICT (day) DO UPDATE
     SET total_micro = excluded.total_micro, grew_streak = excluded.grew_streak`,
)

const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Records the matured, unpaid payee total of the UTC day of `now` and returns
 * how many days in a row it grew. A day grows when its total is above the total
 * of the previous recorded day (0 before the first record). A second record on
 * the same day replaces the first. Any day without growth resets the count to 0.
 */
export function recordBacklog(totalMicro: number, now: number): number {
  const day = Math.floor(now / DAY_MS)
  const previous = selectPreviousDayStmt.get(day)
  const grew = totalMicro > (previous?.total_micro ?? 0)
  const streak = grew ? (previous?.grew_streak ?? 0) + 1 : 0
  upsertDayStmt.run(day, totalMicro, streak)
  return streak
}

/** The sum of `listPayeeBalances(now)`: the backlog the payout rules have not paid. */
export function matureUnpaidTotal(now: number): number {
  return listPayeeBalances(now).reduce((sum, row) => sum + row.balanceMicro, 0)
}
