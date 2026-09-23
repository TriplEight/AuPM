// proxy/src/claims/schema.ts
//
// The off-chain ledger schema (SPEC.md §13.2): accruals, batches, payouts.
// Uses the shared better-sqlite3 handle exported by proxy/src/db.ts — this
// module never modifies db.ts, it only imports the handle it already
// exposes and creates its own tables on it.

import db from '../db.js'

db.exec(`
  CREATE TABLE IF NOT EXISTS accruals (
    settle_txid  TEXT NOT NULL,
    route        TEXT NOT NULL,
    pkg          TEXT NOT NULL,
    version      TEXT NOT NULL,
    role         TEXT NOT NULL,
    identity     TEXT NOT NULL,
    amount_micro INTEGER NOT NULL,
    created_at   INTEGER NOT NULL,
    PRIMARY KEY (settle_txid, role, pkg, version)
  )
`)

// Upgrade guard: an existing audit.db predates the `repo` and `batch_seq`
// columns (SPEC.md §13.2). Add them in place rather than recreating the
// table, so a deployed database upgrades without losing its rows. Safe to
// run on every boot — it only runs an ALTER when the column is still
// missing. `repo` is the GitHub `owner/repo` (or `npm:<name>`) key the
// accrual's package was reviewed under, resolved from `audit_status` at
// write time (see ledger.ts's resolveRepoForPackage); an unassigned row
// (no package) carries `''`. `batch_seq` is NULL until the nightly credit
// step assigns the row to a numbered batch (ADR 0005) — it is never set at
// write time.
const accrualColumns = db.prepare('PRAGMA table_info(accruals)').all() as { name: string }[]
if (!accrualColumns.some((column) => column.name === 'repo')) {
  db.exec('ALTER TABLE accruals ADD COLUMN repo TEXT')
}
if (!accrualColumns.some((column) => column.name === 'batch_seq')) {
  db.exec('ALTER TABLE accruals ADD COLUMN batch_seq INTEGER')
}

// One row per numbered credit() batch (SPEC.md §13.2, ADR 0005). A row
// with `credit_txid` still NULL means the crediter assigned accrual rows
// to this batch but the on-chain call has not yet confirmed — a crash in
// that window. The nightly credit step resends exactly that batch; it
// never opens a new one while one is pending (see credit.ts).
db.exec(`
  CREATE TABLE IF NOT EXISTS batches (
    batch_seq          INTEGER PRIMARY KEY,
    attributed_micro   INTEGER NOT NULL,
    unattributed_micro INTEGER NOT NULL,
    credit_txid        TEXT,
    created_at         INTEGER NOT NULL
  )
`)

// One row per manual, human-checked payout (SPEC.md 5.3 step 5). Signed
// locally from the cold pool key, never by the server.
db.exec(`
  CREATE TABLE IF NOT EXISTS payouts (
    identity     TEXT NOT NULL,
    role         TEXT NOT NULL,
    amount_micro INTEGER NOT NULL,
    txid         TEXT NOT NULL,
    paid_at      INTEGER NOT NULL,
    PRIMARY KEY (identity, role, txid)
  )
`)

export type AccrualRow = {
  settle_txid: string
  route: string
  pkg: string
  version: string
  /** GitHub `owner/repo`, `npm:<name>`, or `''` for an unassigned row. */
  repo: string | null
  role: string
  identity: string
  amount_micro: number
  /** NULL until the nightly credit step assigns this row to a batch. */
  batch_seq: number | null
  created_at: number
}

export type BatchRow = {
  batch_seq: number
  attributed_micro: number
  unattributed_micro: number
  /** NULL until the on-chain credit() call for this batch confirms. */
  credit_txid: string | null
  created_at: number
}

export type PayoutRow = {
  identity: string
  role: string
  amount_micro: number
  txid: string
  paid_at: number
}

export default db
