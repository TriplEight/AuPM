// proxy/src/claims/schema.ts
//
// The off-chain ledger schema (SPEC.md §13.2): accruals, batches, payouts,
// plus the nightly job's own run history and lease (ADR 0009). Uses the
// shared better-sqlite3 handle exported by proxy/src/db.ts — this module
// never modifies db.ts, it only imports the handle it already exposes and
// creates its own tables on it.

import { randomUUID } from 'node:crypto'
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

// ---------------------------------------------------------------------------
// Nightly job run history and lease (ADR 0009, item N1). One row per run
// attempt (`nightly_runs`) and a single-row lease (`nightly_lease`) that
// stops two runs from overlapping — proxy/src/index.ts's in-process
// scheduler and proxy/src/claims/nightly-main.ts's manual entry point both
// take this same lease before a run and release it after.
// ---------------------------------------------------------------------------

db.exec(`
  CREATE TABLE IF NOT EXISTS nightly_runs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at  INTEGER NOT NULL,
    ended_at    INTEGER,
    result      TEXT,
    error       TEXT,
    batch_seq   INTEGER,
    credit_txid TEXT
  )
`)

// One row, id fixed at 1. `acquired_at` is the lease holder's own clock
// reading at acquire time (caller-supplied — never `Date.now()` read here —
// so a test never depends on a real clock). A lease older than
// NIGHTLY_LEASE_STALE_MS counts as released: a crashed run's lease does not
// block every later run forever.
db.exec(`
  CREATE TABLE IF NOT EXISTS nightly_lease (
    id          INTEGER PRIMARY KEY CHECK (id = 1),
    holder      TEXT NOT NULL,
    acquired_at INTEGER NOT NULL
  )
`)

export type NightlyRunResult = 'success' | 'failed'

export type NightlyRunRow = {
  id: number
  started_at: number
  /** NULL while the run is still in progress. */
  ended_at: number | null
  /** NULL while the run is still in progress. */
  result: NightlyRunResult | null
  /** The failure reason, or NULL on a successful (or still in-progress) run. */
  error: string | null
  /** The batch this run credited, or NULL when it did not reach or complete
   * the credit step. */
  batch_seq: number | null
  /** The credit() txid for `batch_seq`, or NULL on the same terms. */
  credit_txid: string | null
}

const insertNightlyRunStart = db.prepare<[number]>(
  'INSERT INTO nightly_runs (started_at) VALUES (?)',
)

/** Records a run's start; returns the new row's id, for recordNightlyRunEnd. */
export function recordNightlyRunStart(startedAt: number): number {
  const result = insertNightlyRunStart.run(startedAt)
  return Number(result.lastInsertRowid)
}

const updateNightlyRunEnd = db.prepare<
  [number, NightlyRunResult, string | null, number | null, string | null, number]
>(
  `UPDATE nightly_runs
     SET ended_at = ?, result = ?, error = ?, batch_seq = ?, credit_txid = ?
   WHERE id = ?`,
)

/** Records a run's end (item N1.5). `error`, `batchSeq` and `creditTxid` are
 * each NULL when the run never produced that fact. */
export function recordNightlyRunEnd(
  id: number,
  endedAt: number,
  result: NightlyRunResult,
  error: string | null,
  batchSeq: number | null,
  creditTxid: string | null,
): void {
  updateNightlyRunEnd.run(endedAt, result, error, batchSeq, creditTxid, id)
}

const selectLastNightlyRun = db.prepare<[], NightlyRunRow>(
  'SELECT * FROM nightly_runs ORDER BY id DESC LIMIT 1',
)

/** The most recent run, success or failure — for GET /api/v1/health. */
export function getLastNightlyRun(): NightlyRunRow | undefined {
  return selectLastNightlyRun.get()
}

const selectLastSuccessfulNightlyRun = db.prepare<[], NightlyRunRow>(
  "SELECT * FROM nightly_runs WHERE result = 'success' ORDER BY id DESC LIMIT 1",
)

/** The most recent successful run — drives both the start-up catch-up check
 * (item N1.2) and GET /api/v1/health's 200/503 decision (item N1.6). */
export function getLastSuccessfulNightlyRun(): NightlyRunRow | undefined {
  return selectLastSuccessfulNightlyRun.get()
}

/** A lease older than this counts as released (item N1.4). */
export const NIGHTLY_LEASE_STALE_MS = 60 * 60 * 1000

// Inserts the lease row if none exists yet, or steals it in place when the
// existing row is older than NIGHTLY_LEASE_STALE_MS — otherwise (a live
// lease held by someone else) this is a no-op: SQLite skips the DO UPDATE
// when its WHERE clause is false, and no row already exists to insert, so
// `changes` stays 0. One statement, no read-then-write race between two
// processes.
const acquireNightlyLeaseStmt = db.prepare<[string, number, number]>(
  `INSERT INTO nightly_lease (id, holder, acquired_at)
   VALUES (1, ?, ?)
   ON CONFLICT (id) DO UPDATE SET holder = excluded.holder, acquired_at = excluded.acquired_at
   WHERE nightly_lease.acquired_at < ?`,
)

/**
 * Tries to acquire the single nightly-job lease. `now` is the caller's own
 * clock reading (milliseconds), never read from `Date.now()` here, so a
 * test controls staleness without a real wait. Returns a holder token to
 * pass to releaseNightlyLease on success, or null when the lease is
 * already held by a run less than NIGHTLY_LEASE_STALE_MS old.
 */
export function acquireNightlyLease(now: number): string | null {
  const holder = randomUUID()
  const staleBefore = now - NIGHTLY_LEASE_STALE_MS
  const result = acquireNightlyLeaseStmt.run(holder, now, staleBefore)
  return result.changes === 1 ? holder : null
}

const releaseNightlyLeaseStmt = db.prepare<[string]>(
  'DELETE FROM nightly_lease WHERE id = 1 AND holder = ?',
)

/** Releases the lease, only when `holder` still matches the current row —
 * so a run that held a since-stolen (stale) lease never deletes the new
 * holder's fresh one. */
export function releaseNightlyLease(holder: string): void {
  releaseNightlyLeaseStmt.run(holder)
}

export default db
