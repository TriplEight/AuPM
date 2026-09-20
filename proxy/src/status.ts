// proxy/src/status.ts
import { getStatus, type StatusRow, upsertStatus } from './db.js'

export const PAID_STATUSES = new Set(['COMMUNITY_REVIEWED', 'PEER_REVIEWED'])

export function isFree(status: string): boolean {
  return !PAID_STATUSES.has(status)
}

export function getStatusOrUnreviewed(pkg: string, version: string): StatusRow {
  return (
    getStatus.get(pkg, version) ?? {
      pkg,
      version,
      status: 'UNREVIEWED',
      auditor_addr: null,
      attest_txid: null,
      ts: null,
      integrity: null,
      reviewer: null,
    }
  )
}

/**
 * "github:<login>" from the stored `reviewer` column, or null when no
 * reviewer login is recorded on this row.
 *
 * WARNING: never derive this from `auditor_addr` — that column is the
 * on-chain attesting Algorand address, a different fact. The ledger, the
 * earnings endpoint, and the payout script all key on `github:<login>`; an
 * Algorand address written into `AttributionEntry.auditor` can never be
 * looked up there, and the revenue accrued under it is stranded.
 */
export function reviewerIdentity(row: StatusRow): string | null {
  return row.reviewer ? `github:${row.reviewer}` : null
}

/**
 * True only for a paid-tier row that also carries a stored integrity.
 *
 * A paid-tier row with no stored integrity is an incomplete review: SPM
 * does not know which tarball a human read, so it must not sell a claim
 * about one. Callers that build or price a paid attestation (the lockfile
 * and single-package routes) must treat that row as UNREVIEWED, never as
 * its raw `status`.
 */
export function isReviewedWithIntegrity(row: StatusRow): boolean {
  return !isFree(row.status) && row.integrity !== null
}

export function setStatus(
  pkg: string,
  version: string,
  status: string,
  auditorAddr: string | null = null,
  attestTxid: string | null = null,
  integrity: string | null = null,
  /** Bare GitHub login of the human reviewer (e.g. "alice"), never "github:alice". */
  reviewer: string | null = null,
): void {
  upsertStatus.run(pkg, version, status, auditorAddr, attestTxid, Date.now(), integrity, reviewer)
}
