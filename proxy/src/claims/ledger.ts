// proxy/src/claims/ledger.ts
//
// Read/write access to the ledger (accruals, payouts). This is the only
// module in proxy/src/claims that touches SQL directly, besides table
// creation in schema.ts.

import { type Attribution, buildAccrualInputs } from './attribution-rules.js'
import db, { type AccrualRow, type PayoutRow } from './schema.js'

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

// ON CONFLICT DO NOTHING makes a replayed settle_txid a no-op: the primary
// key (settle_txid, role, pkg, version) already exists, so the row already
// written wins and no second accrual is written (SPEC.md 5.2, CLAUDE.md
// invariant "idempotent").
const insertAccrual = db.prepare<[string, string, string, string, string, string, number, number]>(
  `INSERT INTO accruals
     (settle_txid, route, pkg, version, role, identity, amount_micro, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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
