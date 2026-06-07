// proxy/src/db.ts
import BetterSqlite3 from 'better-sqlite3'
import path from 'node:path'

const DB_PATH = process.env['SQLITE_PATH'] ?? path.join(process.cwd(), 'audit.db')

const db = new BetterSqlite3(DB_PATH)

db.exec(`
  CREATE TABLE IF NOT EXISTS audit_status (
    pkg          TEXT NOT NULL,
    version      TEXT NOT NULL,
    status       TEXT NOT NULL DEFAULT 'UNREVIEWED',
    auditor_addr TEXT,
    attest_txid  TEXT,
    ts           INTEGER,
    PRIMARY KEY (pkg, version)
  )
`)

export type StatusRow = {
  pkg: string
  version: string
  status: string
  auditor_addr: string | null
  attest_txid: string | null
  ts: number | null
}

export const getStatus = db.prepare<[string, string], StatusRow>(
  'SELECT * FROM audit_status WHERE pkg = ? AND version = ?',
)

export const upsertStatus = db.prepare<
  [string, string, string, string | null, string | null, number | null]
>(
  `INSERT INTO audit_status (pkg, version, status, auditor_addr, attest_txid, ts)
   VALUES (?, ?, ?, ?, ?, ?)
   ON CONFLICT(pkg, version) DO UPDATE SET
     status       = excluded.status,
     auditor_addr = excluded.auditor_addr,
     attest_txid  = excluded.attest_txid,
     ts           = excluded.ts`,
)

export default db
