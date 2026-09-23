// mcp/src/tools/attest.ts
import fs from 'node:fs'
import { fetchWithDonation, PRICE_PER_ENTRY_MICRO, USDC_ASSET_ID } from '../donor.js'
import { countLockfileEntries } from '../lockfile-entries.js'

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
      /** Set only when the server already answered with a partial attestation (SPEC.md §12.3). */
      withheld?: number
      summary?: unknown
      attestation?: unknown
    }

export type AttestLockfileResult = AttestLockfileOutcome

type LockfileAttestResponseBody = {
  summary: unknown
  attestation: unknown
}

function isLockfileAttestResponseBody(value: unknown): value is LockfileAttestResponseBody {
  return typeof value === 'object' && value !== null && 'summary' in value && 'attestation' in value
}

type DsseEnvelopeLike = { payload?: unknown }
type StatementLike = { predicate?: { withheld?: unknown } }

/**
 * Reads `predicate.withheld` out of a signed DSSE attestation without
 * verifying its signature — this is a display value only, never a trust
 * decision. `spm verify` (offline, ed25519) is the actual security check.
 * Returns 0 (report as fully attested) when the shape is not decodable,
 * so a malformed response never blocks a caller from seeing what it did
 * get back.
 */
function decodeWithheld(attestation: unknown): number {
  const envelope = attestation as DsseEnvelopeLike
  if (typeof envelope?.payload !== 'string') return 0
  let statement: StatementLike
  try {
    statement = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'))
  } catch {
    return 0
  }
  const withheld = statement?.predicate?.withheld
  return typeof withheld === 'number' && Number.isFinite(withheld) && withheld >= 0 ? withheld : 0
}

export const attestLockfileTool = {
  name: 'attest_lockfile',
  description:
    'Request a signed in-toto attestation for a whole package-lock.json via SPM. Free ' +
    'when the tree has zero reviewed packages. Pass allowDonation: true to pay for and ' +
    'receive the full attestation. Without allowDonation, the reviewed entries are ' +
    "withheld and the result reports status: 'donation_required' with the partial " +
    'attestation, the withheld count, the price, and the resource URL — never a 402.',

  async handler({
    lockfilePath,
    allowDonation = false,
  }: {
    lockfilePath: string
    allowDonation?: boolean
  }): Promise<AttestLockfileResult> {
    const lockfileBytes = fs.readFileSync(lockfilePath)
    const entryCount = countLockfileEntries(lockfileBytes)

    const result = await fetchWithDonation(
      LOCKFILE_ATTEST_URL,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: lockfileBytes,
      },
      allowDonation,
      entryCount,
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

    // Without the opt-in, the server already answered free (SPEC.md
    // §11.4, §12.3): X-SPM-Donate: 0 gets a 200 with a partial attestation
    // whenever any reviewed entry was withheld. `withheld: 0` still means
    // a genuinely full attestation (e.g. zero-coverage lockfiles), so only
    // a positive count is reported back as donation_required.
    if (!allowDonation) {
      const withheld = decodeWithheld(body.attestation)
      if (withheld > 0) {
        return {
          status: 'donation_required',
          priceMicro: withheld * PRICE_PER_ENTRY_MICRO,
          resourceUrl: LOCKFILE_ATTEST_URL,
          asset: USDC_ASSET_ID,
          withheld,
          summary: body.summary,
          attestation: body.attestation,
        }
      }
    }

    return { status: 'attested', summary: body.summary, attestation: body.attestation }
  },
}
