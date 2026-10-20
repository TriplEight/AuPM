// mcp/src/tools/attest.ts
import fs from 'node:fs'
import path from 'node:path'
import {
  DONATION_SETTING_TEXT,
  type MultiplierSetting,
  resolveDonate,
  resolveMultiplier,
} from '../config.js'
import {
  DonationFailure,
  type DonationFailureReport,
  type DonationFetchResult,
  type DonationReceipt,
  donationReceipt,
  entryPriceMicro,
  fetchWithDonation,
  type Settlement,
  USDC_ASSET_ID,
} from '../donor.js'
import {
  countEntriesForFile,
  isPnpmLockfilePath,
  isYarnLockfilePath,
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
      /** Base price, multiplier and total of the donation. Set when a donation paid. */
      receipt?: DonationReceipt
      /** Set when a donation was asked for and failed. The result is then the free one. */
      donationFailure?: DonationFailureReport
    }
  | {
      status: 'donation_required'
      priceMicro: number
      resourceUrl: string
      asset: string
      /** Base price, multiplier and the total that the donation would cost. */
      receipt?: DonationReceipt
      /** Set only when the server already answered with a partial attestation. */
      withheld?: number
      summary?: unknown
      attestation?: unknown
      /** Set when a donation was asked for and failed. The result is then the free one. */
      donationFailure?: DonationFailureReport
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

type LockfileKind = 'json' | 'pnpm' | 'yarn'

const CONTENT_TYPES: Record<LockfileKind, string> = {
  json: 'application/json',
  pnpm: 'application/yaml',
  yarn: 'text/plain',
}

function lockfileKind(lockfilePath: string): LockfileKind {
  if (isPnpmLockfilePath(lockfilePath)) return 'pnpm'
  return isYarnLockfilePath(lockfilePath) ? 'yarn' : 'json'
}

function failureMessage(status: number, kind: LockfileKind): string {
  const what = kind === 'json' ? 'lockfile' : kind === 'pnpm' ? 'pnpm-lock.yaml' : 'yarn.lock'
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

type AttestRequest = {
  url: string
  kind: LockfileKind
  lockfileBytes: Buffer
  entryCount: number
}

async function postWithRetry(
  request: AttestRequest,
  donate: boolean,
  tenths: number,
): Promise<DonationFetchResult> {
  const post = () =>
    fetchWithDonation(
      request.url,
      {
        method: 'POST',
        headers: { 'content-type': CONTENT_TYPES[request.kind] },
        body: request.lockfileBytes,
      },
      donate,
      request.entryCount,
      tenths,
    )
  const result = await post()
  // 503 means another YAML parse runs; the server sends it before any 402,
  // so no donation settled. Wait as told, once, then fail.
  if (result.kind === 'response' && result.response.status === 503) {
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs(result.response)))
    return post()
  }
  return result
}

async function outcomeFromResult(
  result: DonationFetchResult,
  donate: boolean,
  kind: LockfileKind,
  multiplier: MultiplierSetting,
): Promise<AttestLockfileOutcome> {
  if (result.kind === 'donation_required') {
    return {
      status: 'donation_required',
      priceMicro: result.requirement.priceMicro,
      resourceUrl: result.requirement.resourceUrl,
      asset: result.requirement.asset,
      receipt: donationReceipt(multiplier, result.requirement.priceMicro),
    }
  }
  const res = result.response
  if (!res.ok) {
    throw new Error(failureMessage(res.status, kind))
  }

  const body: unknown = await res.json()
  if (!isLockfileAttestResponseBody(body)) {
    throw new Error('Lockfile attest failed: malformed response body')
  }

  // Without the opt-in, the server already answered free: X-AuPM-Donate: 0 gets a 200 with a partial attestation
  // whenever any reviewed entry was withheld. `withheld: 0` still means
  // a genuinely full attestation (e.g. zero-coverage lockfiles), so only
  // a positive count is reported back as donation_required.
  if (!donate) {
    const withheld = decodeWithheld(body.attestation)
    if (withheld > 0) {
      return {
        status: 'donation_required',
        priceMicro: withheld * entryPriceMicro(multiplier.tenths),
        resourceUrl: lockfileAttestUrl(),
        asset: USDC_ASSET_ID,
        receipt: donationReceipt(multiplier, withheld * entryPriceMicro(multiplier.tenths)),
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
    ...(result.settlement
      ? { receipt: donationReceipt(multiplier, result.settlement.amountMicro) }
      : {}),
  }
}

export const attestLockfileTool = {
  name: 'attest_lockfile',
  description:
    'Request a signed in-toto attestation for a whole package-lock.json, pnpm-lock.yaml ' +
    '(lockfileVersion 9.0) or yarn.lock (yarn classic v1; chosen by file name) via AuPM. Free ' +
    'when the tree has zero reviewed packages. Opt in to donate to pay for and ' +
    'receive the full attestation. Without a donation opt-in, the reviewed entries are ' +
    "withheld and the result reports status: 'donation_required' with the partial " +
    'attestation, the withheld count, the price, and the resource URL — never a 402. ' +
    'A paid attestation reports settlement: the settlement txid and the microUSDC amount paid, ' +
    'and receipt: { baseMicro, multiplier, totalMicro }. ' +
    'When a donation was asked for and failed, the result is the free one and carries ' +
    'donationFailure: { code, reason }. Nothing was paid. ' +
    DONATION_SETTING_TEXT,

  async handler({
    lockfilePath,
    allowDonation,
  }: {
    lockfilePath: string
    allowDonation?: boolean
  }): Promise<AttestLockfileResult> {
    const donate = resolveDonate(allowDonation).value
    const multiplier = resolveMultiplier()
    const lockfileBytes = fs.readFileSync(lockfilePath)
    const kind = lockfileKind(lockfilePath)
    if (kind !== 'json' && lockfileBytes.byteLength > PNPM_LOCKFILE_MAX_BYTES) {
      throw new Error(
        `${path.basename(lockfilePath)} is ${lockfileBytes.byteLength} bytes; the server accepts at most ` +
          `${PNPM_LOCKFILE_MAX_BYTES} bytes`,
      )
    }
    const entryCount = countEntriesForFile(lockfilePath, lockfileBytes)

    const request = { url: lockfileAttestUrl(), kind, lockfileBytes, entryCount }
    let failure: DonationFailureReport | undefined
    let result: DonationFetchResult
    try {
      result = await postWithRetry(request, donate, multiplier.tenths)
    } catch (error) {
      if (!donate || !(error instanceof DonationFailure)) throw error
      // The paid attempt failed. The free request below sends X-AuPM-Donate: 0 and cannot pay.
      failure = error.report()
      result = await postWithRetry(request, false, multiplier.tenths)
    }
    const outcome = await outcomeFromResult(result, donate && !failure, kind, multiplier)
    return failure ? { ...outcome, donationFailure: failure } : outcome
  },
}
