// proxy/src/claims/schema.ts
//
// The off-chain ledger schema (SPEC.md section 5.2): accruals, payouts.
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
  role: string
  identity: string
  amount_micro: number
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
