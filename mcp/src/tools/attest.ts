// mcp/src/tools/attest.ts
import fs from 'node:fs'
import { fetchWithDonation } from '../donor.js'

const PROXY_URL = process.env.SPM_PROXY_URL ?? 'http://localhost:4873'
const LOCKFILE_ATTEST_URL = `${PROXY_URL}/v1/attest/lockfile`

export type AttestLockfileOutcome =
  | {
      status: 'attested'
      summary: unknown
      attestation: unknown
    }
  | {
      status: 'donation_required'
      priceMicro: number
      resourceUrl: string
      asset: string
    }

export type AttestLockfileResult = AttestLockfileOutcome

type LockfileAttestResponseBody = {
  summary: unknown
  attestation: unknown
}

function isLockfileAttestResponseBody(value: unknown): value is LockfileAttestResponseBody {
  return typeof value === 'object' && value !== null && 'summary' in value && 'attestation' in value
}

export const attestLockfileTool = {
  name: 'attest_lockfile',
  description:
    'Request a signed in-toto attestation for a whole package-lock.json via SPM. Free ' +
    'when the tree has zero reviewed packages. Otherwise this route returns 402. Pass ' +
    'allowDonation: true to donate for the attestation. Without allowDonation, a 402 is ' +
    "reported back as status: 'donation_required' with the price and resource URL, and " +
    'nothing is signed.',

  async handler({
    lockfilePath,
    allowDonation = false,
  }: {
    lockfilePath: string
    allowDonation?: boolean
  }): Promise<AttestLockfileResult> {
    const lockfileBytes = fs.readFileSync(lockfilePath)

    const result = await fetchWithDonation(
      LOCKFILE_ATTEST_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: lockfileBytes,
      },
      allowDonation,
    )

    if (result.kind === 'donation_required') {
      return {
        status: 'donation_required',
        priceMicro: result.requirement.priceMicro,
        resourceUrl: result.requirement.resourceUrl,
        asset: result.requirement.asset,
      }
    }

    const res = result.response
    if (!res.ok) {
      throw new Error(`Lockfile attest failed: ${res.status}`)
    }

    const body: unknown = await res.json()
    if (!isLockfileAttestResponseBody(body)) {
      throw new Error('Lockfile attest failed: malformed response body')
    }

    return { status: 'attested', summary: body.summary, attestation: body.attestation }
  },
}
