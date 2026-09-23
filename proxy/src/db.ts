// proxy/src/db.ts

import path from 'node:path'
import BetterSqlite3 from 'better-sqlite3'

const DB_PATH = process.env.SQLITE_PATH ?? path.join(process.cwd(), 'audit.db')

const db = new BetterSqlite3(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_status (
    pkg          TEXT NOT NULL,
    version      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'UNREVIEWED',
    auditor_addr TEXT,
    anchor_txid  TEXT,
    ts           INTEGER,
    PRIMARY KEY (pkg, version)
  )
`)

// Upgrade guard: an existing audit.db predates the `integrity` column. Add
// it in place rather than recreating the table, so a deployed database
// upgrades without losing its rows. Safe to run on every boot — it only
// runs the ALTER when the column is still missing.
const existingColumns = db.prepare('PRAGMA table_info(audit_status)').all() as { name: string }[]
if (!existingColumns.some((column) => column.name === 'integrity')) {
  db.exec('ALTER TABLE audit_status ADD COLUMN integrity TEXT')
}

// Upgrade guard: an existing audit.db predates the `reviewer` column. Add it
// in place, same pattern as `integrity` above. `reviewer` is the human
// reviewer's bare GitHub login (e.g. "alice") — never "github:alice" and
// never an Algorand address. `auditor_addr` records a different fact (the
// on-chain attesting address) and stays untouched (CLAUDE.md). Without this
// column, the auditor revenue share has no GitHub identity to accrue
// against and is stranded.
if (!existingColumns.some((column) => column.name === 'reviewer')) {
  db.exec('ALTER TABLE audit_status ADD COLUMN reviewer TEXT')
}

export type StatusRow = {
  pkg: string
  version: string
  status: string
  auditor_addr: string | null
  anchor_txid: string | null
  ts: number | null
  /** The known-good npm `integrity` string for the reviewed tarball, or null
   * when no independent integrity has been stored — see status.ts's
   * isReviewedWithIntegrity(). Never fabricated. */
  integrity: string | null
  /** Bare GitHub login of the human reviewer (e.g. "alice"), or null when
   * unknown. Never "github:alice" here — status.ts's reviewerIdentity()
   * applies that prefix. Never an Algorand address; see auditor_addr. */
  reviewer: string | null
}

export const getStatus = db.prepare<[string, string], StatusRow>(
  'SELECT * FROM audit_status WHERE pkg = ? AND version = ?',
)

export const upsertStatus = db.prepare<
  [
    string,
    string,
    string,
    string | null,
    string | null,
    number | null,
    string | null,
    string | null,
  ]
>(
  `INSERT INTO audit_status (pkg, version, status, auditor_addr, anchor_txid, ts, integrity, reviewer)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT(pkg, version) DO UPDATE SET
     status       = excluded.status,
     auditor_addr = excluded.auditor_addr,
     anchor_txid  = excluded.anchor_txid,
     ts           = excluded.ts,
     integrity    = excluded.integrity,
     reviewer     = excluded.reviewer`,
)

export default db
