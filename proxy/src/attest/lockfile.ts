// proxy/src/attest/lockfile.ts
//
// Parses and classifies a `package-lock.json` (lockfileVersion 2 or 3) for
// the POST /v1/attest/lockfile route. Pure logic, no HTTP and no signing —
// proxy/src/routes/attest.ts wires this into the request/response cycle.
//
// CAUTION: `sha256` below is computed over the exact raw request body bytes
// handed to `analyzeLockfile`. Never JSON.parse-then-re-serialise before
// hashing — the digest must match the file bytes on the caller's disk.

import { createHash } from 'node:crypto'
import { getStatusOrUnreviewed, isFree, reviewerIdentity } from '../status.js'

export const LOCKFILE_MAX_BYTES = 5 * 1024 * 1024
export const LOCKFILE_MAX_ENTRIES = 10_000

/** One entry in the signed statement's `predicate.packages` array. */
export interface LockfilePackageEntry {
  name: string
  version: string
  integrity: string | null
  tier: string
  /** "github:<login>" for the human reviewer (status.ts's reviewerIdentity()),
   * or null when unknown. Never an on-chain address — never fabricated. */
  reviewer: string | null
  reviewScope: string | null
  anchorTxid: string | null
  /** null when there is no known-good integrity to compare against. */
  integrityMatch: boolean | null
}

export interface LockfileSummary {
  total: number
  reviewed: number
  unreviewed: number
  unresolvable: number
  integrityMismatch: number
}

/** A reviewed package reference, carried through to attribution.ts. */
export interface ReviewedPackageRef {
  pkg: string
  version: string
  /** "github:<login>", or null when the row carries no reviewer login. */
  auditor: string | null
}

export interface LockfileAnalysis {
  lockfileVersion: 2 | 3
  sha256: string
  summary: LockfileSummary
  /** Reviewed, INTEGRITY_MISMATCH, and UNRESOLVABLE entries only — never the unreviewed majority. */
  packages: LockfilePackageEntry[]
  reviewedPackageRefs: ReviewedPackageRef[]
}

export type LockfileValidationResult =
  | { ok: true; analysis: LockfileAnalysis }
  | { ok: false; message: string }

/** Looks up a known-good tarball integrity for a reviewed (pkg, version). */
export type IntegrityLookup = (pkg: string, version: string) => string | null

/**
 * Default integrity lookup: reads the known-good tarball integrity stored
 * on the audit_status row itself (status.ts's `integrity` column). Returns
 * null when no row exists, or when the row exists but carries no stored
 * integrity — both cases mean "nothing to compare against", and the caller
 * below must never read that as a match. Tests inject a different lookup to
 * exercise the mismatch branch without touching the store.
 */
const defaultIntegrityLookup: IntegrityLookup = (pkg, version) =>
  getStatusOrUnreviewed(pkg, version).integrity

const NPM_TARBALL_RE = /^https?:\/\/registry\.npmjs\.org\/.+\.tgz(?:[?#].*)?$/i

const SSRI_ENTRY_RE = /^sha512-([A-Za-z0-9+/]+=*)$/

/**
 * Extracts the sha512 entry's base64 digest from an npm SSRI `integrity`
 * string. SSRI allows several space-separated hashes on one field, e.g.
 * `"sha512-<b64> sha1-<b64>"` — npm may list them in either order. Returns
 * null when no `sha512-` entry is present.
 *
 * CAUTION: never fall back to a weaker algorithm here. A `sha1-` entry must
 * never satisfy a comparison on its own.
 */
function extractSha512Digest(integrity: string): string | null {
  for (const entry of integrity.trim().split(/\s+/)) {
    const match = SSRI_ENTRY_RE.exec(entry)
    if (match?.[1]) return match[1]
  }
  return null
}

/**
 * True only when both sides carry a `sha512-` entry and those entries are
 * identical — never a raw-string `===` over the whole SSRI field, which
 * fails a genuine match whenever either side lists more than one hash.
 *
 * CAUTION: when either side has no sha512 entry, the comparison cannot be
 * made. That is unresolvable, not a match — reported as a mismatch (never
 * `integrityMatch: true`), since a signed attestation must never claim a
 * tarball matches a digest it cannot actually verify.
 */
function sha512Matches(knownIntegrity: string, observedIntegrity: string): boolean {
  const known = extractSha512Digest(knownIntegrity)
  const observed = extractSha512Digest(observedIntegrity)
  if (known === null || observed === null) return false
  return known === observed
}

function isNpmResolved(resolved: string | undefined): boolean {
  return typeof resolved === 'string' && NPM_TARBALL_RE.test(resolved)
}

/**
 * Extracts a package's own name from its `packages` object key.
 * `"node_modules/ms"` -> `"ms"`; `"node_modules/@babel/core"` -> `"@babel/core"`;
 * `"node_modules/foo/node_modules/@babel/core"` -> `"@babel/core"` (the
 * nested package's own name, not the path to it).
 */
function packageNameFromKey(key: string): string {
  const marker = 'node_modules/'
  const idx = key.lastIndexOf(marker)
  return idx === -1 ? key : key.slice(idx + marker.length)
}

interface RawLockfileEntry {
  version?: unknown
  resolved?: unknown
  integrity?: unknown
  link?: unknown
}

/**
 * Validates limits and `lockfileVersion`, classifies every entry, and
 * computes the sha256 of the raw body. Returns `{ ok: false, message }` for
 * every case the caller must never be charged for — the pre-middleware in
 * routes/attest.ts turns that into a 400 before the x402 payment gate runs.
 */
export function analyzeLockfile(
  rawBody: Uint8Array,
  integrityLookup: IntegrityLookup = defaultIntegrityLookup,
): LockfileValidationResult {
  if (rawBody.byteLength > LOCKFILE_MAX_BYTES) {
    return { ok: false, message: `lockfile exceeds the ${LOCKFILE_MAX_BYTES}-byte limit` }
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(Buffer.from(rawBody).toString('utf8'))
  } catch {
    return { ok: false, message: 'lockfile is not valid JSON' }
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: 'lockfile must be a JSON object' }
  }

  const doc = parsed as { lockfileVersion?: unknown; packages?: unknown }
  if (doc.lockfileVersion !== 2 && doc.lockfileVersion !== 3) {
    return { ok: false, message: 'lockfileVersion must be 2 or 3' }
  }
  const lockfileVersion = doc.lockfileVersion

  if (typeof doc.packages !== 'object' || doc.packages === null || Array.isArray(doc.packages)) {
    return { ok: false, message: 'lockfile is missing a "packages" object' }
  }

  const entries = Object.entries(doc.packages as Record<string, unknown>).filter(
    // "" is the root project entry, not a dependency.
    ([key]) => key !== '',
  )
  if (entries.length > LOCKFILE_MAX_ENTRIES) {
    return { ok: false, message: `lockfile exceeds the ${LOCKFILE_MAX_ENTRIES}-entry limit` }
  }

  const packages: LockfilePackageEntry[] = []
  const reviewedPackageRefs: ReviewedPackageRef[] = []
  const summary: LockfileSummary = {
    total: 0,
    reviewed: 0,
    unreviewed: 0,
    unresolvable: 0,
    integrityMismatch: 0,
  }

  // A lockfile can list the same package at more than one node_modules depth
  // (e.g. "node_modules/ms" and "node_modules/send/node_modules/ms"). Both
  // entries name the same reviewed tarball. Dedup here, at the point the
  // reviewed classification is decided — the earliest point that keeps
  // summary.reviewed, packages[] (the signed statement), reviewedPackageRefs
  // (the accrual split), and the per-package pro-rata share all consistent.
  // Keyed on name@version, never on name alone: the same package at two
  // different versions is two real entries and must stay two.
  const reviewedSeen = new Map<string, { integrity: string | null }>()

  for (const [key, rawEntry] of entries) {
    if (typeof rawEntry !== 'object' || rawEntry === null) continue
    const entry = rawEntry as RawLockfileEntry

    // A workspace symlink to another package in the same monorepo — not a
    // supply-chain dependency, so it is neither reviewed nor unresolvable.
    if (entry.link === true) continue

    summary.total += 1
    const name = packageNameFromKey(key)
    const version = typeof entry.version === 'string' ? entry.version : 'unknown'
    const integrity = typeof entry.integrity === 'string' ? entry.integrity : null
    const resolved = typeof entry.resolved === 'string' ? entry.resolved : undefined

    if (!isNpmResolved(resolved)) {
      // Git, tarball-URL, or non-npm `resolved` entries.
      summary.unresolvable += 1
      packages.push({
        name,
        version,
        integrity,
        tier: 'UNRESOLVABLE',
        reviewer: null,
        reviewScope: null,
        anchorTxid: null,
        integrityMatch: null,
      })
      continue
    }

    const status = getStatusOrUnreviewed(name, version)
    if (isFree(status.status)) {
      // Absent from `packages[]` by design — `summary.unreviewed` carries
      // the count. `predicate.absentMeans` tells verifiers why.
      summary.unreviewed += 1
      continue
    }

    const knownIntegrity = integrityLookup(name, version)
    if (knownIntegrity === null) {
      // A reviewed row with no stored integrity is an incomplete review —
      // SPM cannot say which tarball was read, so it must not claim one.
      // Bucket it with the unreviewed majority: absent from packages[],
      // counted in summary.unreviewed, never a fabricated match.
      summary.unreviewed += 1
      continue
    }
    // Compared on the parsed sha512 digest, never on the raw SSRI string —
    // a lockfile entry may list more than one hash space-separated (SPEC.md
    // §6.3), and a differing hash order or an extra weaker hash must never
    // turn a genuine match into a reported INTEGRITY_MISMATCH.
    const integrityMatch = integrity !== null && sha512Matches(knownIntegrity, integrity)

    if (!integrityMatch) {
      summary.integrityMismatch += 1
      packages.push({
        name,
        version,
        integrity,
        tier: 'INTEGRITY_MISMATCH',
        reviewer: reviewerIdentity(status),
        reviewScope: null,
        anchorTxid: status.anchor_txid,
        integrityMatch: false,
      })
      continue
    }

    const dedupeKey = `${name}\u0000${version}`
    const seen = reviewedSeen.get(dedupeKey)
    if (seen) {
      if (seen.integrity === integrity) {
        // A second node_modules entry for a name@version already accepted
        // as reviewed, with the same raw lockfile integrity: the same
        // tarball listed twice. Collapse it — never double-count, never
        // double-list it in the signed statement, never double-pay it.
        //
        // `summary.total` counts distinct packages, not raw lockfile
        // entries — the same invariant `summary.reviewed` already applies
        // to this exact case. Undo the unconditional `total += 1` above for
        // this entry: it is not a second package, so it must not be a
        // second unit in the total either. Every bucket below is a subset
        // of `total`; if this collapsed entry stayed counted in `total`
        // without landing in any bucket, the buckets would never sum to
        // `total` — an inconsistent signed statement (SPEC.md §12.3).
        summary.total -= 1
        continue
      }
      // Same name@version, already accepted as reviewed, but this entry's
      // raw integrity disagrees with the one already accepted. This is not
      // a harmless duplicate — two node_modules paths claim two different
      // tarballs for the identical name@version. Never merge this into the
      // reviewed count; the attestation must say what it can actually back.
      summary.integrityMismatch += 1
      packages.push({
        name,
        version,
        integrity,
        tier: 'INTEGRITY_MISMATCH',
        reviewer: reviewerIdentity(status),
        reviewScope: null,
        anchorTxid: status.anchor_txid,
        integrityMatch: false,
      })
      continue
    }

    reviewedSeen.set(dedupeKey, { integrity })
    summary.reviewed += 1
    packages.push({
      name,
      version,
      integrity,
      tier: status.status,
      reviewer: reviewerIdentity(status),
      reviewScope: null,
      anchorTxid: status.anchor_txid,
      integrityMatch: true,
    })
    reviewedPackageRefs.push({ pkg: name, version, auditor: reviewerIdentity(status) })
  }

  const sha256 = createHash('sha256').update(rawBody).digest('hex')

  return {
    ok: true,
    analysis: { lockfileVersion, sha256, summary, packages, reviewedPackageRefs },
  }
}
