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
    }
  )
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
): void {
  upsertStatus.run(pkg, version, status, auditorAddr, attestTxid, Date.now(), integrity)
}
