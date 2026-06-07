// mcp/src/tools/check.ts
const PROXY_URL = process.env['SPM_PROXY_URL'] ?? 'http://localhost:4873'

export type AuditStatusResult = {
  pkg: string
  version: string
  status: string
  auditor_addr: string | null
  attest_txid: string | null
  ts: number | null
}

export const checkTool = {
  name: 'check_audit_status',
  description:
    'Check the audit status of an npm package version via the SPM proxy. ' +
    'Returns status (UNREVIEWED/COMMUNITY_REVIEWED/PEER_REVIEWED), auditor address, and attestation txid. ' +
    'Free — no payment required.',
  async handler({ pkg, version }: { pkg: string; version: string }): Promise<AuditStatusResult> {
    const encodedPkg = pkg.startsWith('@')
      ? pkg.replace('@', '%40')
      : encodeURIComponent(pkg)
    const url = `${PROXY_URL}/api/v1/status/${encodedPkg}/${version}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Status check failed: ${res.status} ${await res.text()}`)
    return res.json() as Promise<AuditStatusResult>
  },
}
