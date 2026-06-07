// proxy/src/status.ts
import { getStatus, upsertStatus, type StatusRow } from './db.js'

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
    }
  )
}

export function setStatus(
  pkg: string,
  version: string,
  status: string,
  auditorAddr: string | null = null,
  attestTxid: string | null = null,
): void {
  upsertStatus.run(pkg, version, status, auditorAddr, attestTxid, Date.now())
}
