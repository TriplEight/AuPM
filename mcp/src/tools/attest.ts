// mcp/src/tools/attest.ts
import fs from 'node:fs'
import {
  fetchWithDonation,
  PRICE_PER_ENTRY_MICRO,
  type Settlement,
  USDC_ASSET_ID,
} from '../donor.js'
import {
  countEntriesForFile,
  isPnpmLockfilePath,
  PNPM_LOCKFILE_MAX_BYTES,
} from '../lockfile-entries.js'
import { proxyUrl } from '../proxy-url.js'

function lockfileAttestUrl(): string {
  return `${proxyUrl()}/v1/attest/lockfile`
}

export type AttestLockfileOutcome =
  | {
      status: 'attested'
      summary: unknown
      attestation: unknown
      /** The donation that paid for this attestation, or null when it was free. */
      settlement: Settlement | null
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

const DEFAULT_RETRY_AFTER_SECONDS = 2
const MAX_RETRY_AFTER_SECONDS = 30

function retryDelayMs(res: Response): number {
  const seconds = Number(res.headers.get('retry-after'))
  const valid = Number.isFinite(seconds) && seconds >= 0 && res.headers.has('retry-after')
  return Math.min(valid ? seconds : DEFAULT_RETRY_AFTER_SECONDS, MAX_RETRY_AFTER_SECONDS) * 1000
}

function failureMessage(status: number, isPnpm: boolean): string {
  const what = isPnpm ? 'pnpm-lock.yaml' : 'lockfile'
  if (status === 413)
    return `Lockfile attest failed: 413, the server refused the ${what} as too large`
  if (status === 422) {
    return `Lockfile attest failed: 422, the server could not parse the ${what} within its time limit`
  }
  if (status === 503) {
    return `Lockfile attest failed: 503, the server is busy parsing another ${what}; retry later`
  }
  return `Lockfile attest failed: ${status}`
}

type DsseEnvelopeLike = { payload?: unknown }
type StatementLike = { predicate?: { withheld?: unknown } }

/**
 * Reads `predicate.withheld` out of a signed DSSE attestation without
 * verifying its signature — this is a display value only, never a trust
 * decision. `aupm verify` (offline, ed25519) is the actual security check.
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
    'Request a signed in-toto attestation for a whole package-lock.json or pnpm-lock.yaml ' +
    '(lockfileVersion 9.0, chosen by file name) via AuPM. Free ' +
    'when the tree has zero reviewed packages. Pass allowDonation: true to pay for and ' +
    'receive the full attestation. Without allowDonation, the reviewed entries are ' +
    "withheld and the result reports status: 'donation_required' with the partial " +
    'attestation, the withheld count, the price, and the resource URL — never a 402. ' +
    'A paid attestation reports settlement: the settlement txid and the microUSDC amount paid.',

  async handler({
    lockfilePath,
    allowDonation = false,
  }: {
    lockfilePath: string
    allowDonation?: boolean
  }): Promise<AttestLockfileResult> {
    const lockfileBytes = fs.readFileSync(lockfilePath)
    const isPnpm = isPnpmLockfilePath(lockfilePath)
    if (isPnpm && lockfileBytes.byteLength > PNPM_LOCKFILE_MAX_BYTES) {
      throw new Error(
        `pnpm-lock.yaml is ${lockfileBytes.byteLength} bytes; the server accepts at most ` +
          `${PNPM_LOCKFILE_MAX_BYTES} bytes`,
      )
    }
    const entryCount = countEntriesForFile(lockfilePath, lockfileBytes)

    const post = () =>
      fetchWithDonation(
        lockfileAttestUrl(),
        {
          method: 'POST',
          headers: { 'content-type': isPnpm ? 'application/yaml' : 'application/json' },
          body: lockfileBytes,
        },
        allowDonation,
        entryCount,
      )
    let result = await post()
    // 503 means another YAML parse runs; the server sends it before any 402,
    // so no donation settled. Wait as told, once, then fail.
    if (result.kind === 'response' && result.response.status === 503) {
      const delayMs = retryDelayMs(result.response)
      await new Promise((resolve) => setTimeout(resolve, delayMs))
      result = await post()
    }

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
      throw new Error(failureMessage(res.status, isPnpm))
    }

    const body: unknown = await res.json()
    if (!isLockfileAttestResponseBody(body)) {
      throw new Error('Lockfile attest failed: malformed response body')
    }

    // Without the opt-in, the server already answered free (SPEC.md
    // §11.4, §12.3): X-AuPM-Donate: 0 gets a 200 with a partial attestation
    // whenever any reviewed entry was withheld. `withheld: 0` still means
    // a genuinely full attestation (e.g. zero-coverage lockfiles), so only
    // a positive count is reported back as donation_required.
    if (!allowDonation) {
      const withheld = decodeWithheld(body.attestation)
      if (withheld > 0) {
        return {
          status: 'donation_required',
          priceMicro: withheld * PRICE_PER_ENTRY_MICRO,
          resourceUrl: lockfileAttestUrl(),
          asset: USDC_ASSET_ID,
          withheld,
          summary: body.summary,
          attestation: body.attestation,
        }
      }
    }

    return {
      status: 'attested',
      summary: body.summary,
      attestation: body.attestation,
      settlement: result.settlement,
    }
  },
}
