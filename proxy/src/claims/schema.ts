// proxy/src/claims/schema.ts
//
// The off-chain claims ledger schema (SPEC.md section 5.2): accruals,
// claims, payouts. Uses the shared better-sqlite3 handle exported by
// proxy/src/db.ts — this module never modifies db.ts, it only imports the
// handle it already exposes and creates its own tables on it.

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

// One pending or resolved claim per identity. `nonce` is issued by
// POST /api/v1/claims and re-checked against the claimant's published proof
// at verification time (SPEC.md 5.3).
db.exec(`
  CREATE TABLE IF NOT EXISTS claims (
    identity         TEXT PRIMARY KEY,
    algorand_address TEXT NOT NULL,
    nonce            TEXT NOT NULL,
    proof_kind       TEXT,
    proof_ref        TEXT,
    status           TEXT NOT NULL DEFAULT 'pending',
    created_at       INTEGER NOT NULL,
    verified_at      INTEGER
  )
`)

// One row per manual, human-checked payout (SPEC.md 5.3 step 5). Signed
// locally from the cold pool key by scripts/payout.ts, never by the server.
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

export type ClaimStatus = 'pending' | 'verified' | 'failed'

export type ClaimRow = {
  identity: string
  algorand_address: string
  nonce: string
  proof_kind: string | null
  proof_ref: string | null
  status: ClaimStatus
  created_at: number
  verified_at: number | null
}

export type PayoutRow = {
  identity: string
  role: string
  amount_micro: number
  txid: string
  paid_at: number
}

export default db
