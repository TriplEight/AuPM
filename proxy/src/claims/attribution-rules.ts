// proxy/src/claims/attribution-rules.ts
//
// Attribution rules for the off-chain claims ledger (SPEC-v3.md section 5.2).
// Pure functions only — no I/O, no database access. proxy/src/claims/ledger.ts
// calls these to turn one paid request's attribution into accrual rows.

// ATTRIBUTION CONTRACT — owned by a separate work item, now landed at
// proxy/src/attest/attribution.ts. Re-exported from there so this module
// never drifts from the canonical shape.
export type { Attribution, AttributionEntry, Role } from '../attest/attribution.js'

import type { Attribution, AttributionEntry, Role } from '../attest/attribution.js'

/** Identity used whenever a role cannot be mapped to a real contributor. */
export const UNASSIGNED = 'unassigned'

/**
 * The three ledgered roles and their share of every 1,000 micro-USDC paid
 * (CLAUDE.md "Canonical facts"). Treasury (100) and ops (50) are not
 * ledgered — distribute() pays them directly (SPEC-v3.md 5.2).
 */
export const ROLE_SHARE_PER_1000: Readonly<Record<Role, number>> = {
  auditor: 500,
  maintainer: 200,
  reviewer: 150,
}

export const ROLES: readonly Role[] = ['auditor', 'maintainer', 'reviewer']

/**
 * Integer micro-USDC owed to `role` out of the whole payment.
 *
 * CAUTION: money is always integer micro-units (CLAUDE.md). This relies on
 * the invariant that every price is a multiple of 1,000 microUSDC, so the
 * division below is always exact — no floating point, no remainder lost.
 */
export function computeRoleShareMicro(priceMicro: number, role: Role): number {
  if (!Number.isInteger(priceMicro) || priceMicro < 0) {
    throw new Error(
      `computeRoleShareMicro: priceMicro must be a non-negative integer, got ${priceMicro}`,
    )
  }
  if (priceMicro % 1000 !== 0) {
    throw new Error(
      `computeRoleShareMicro: priceMicro ${priceMicro} is not a multiple of 1,000 microUSDC`,
    )
  }
  return (priceMicro / 1000) * ROLE_SHARE_PER_1000[role]
}

/**
 * Split `totalMicro` across `count` packages with integer arithmetic only.
 * The remainder goes to index 0, so the caller must pass packages already
 * sorted into the canonical order (see `sortPackages`) before calling this.
 * The sum of the returned amounts always equals `totalMicro` exactly.
 */
export function splitProRata(totalMicro: number, count: number): number[] {
  if (count <= 0) return []
  const base = Math.floor(totalMicro / count)
  const remainder = totalMicro - base * count
  const amounts = new Array<number>(count).fill(base)
  amounts[0] = base + remainder
  return amounts
}

/**
 * Canonical sort order for pro-rata splits: by package name, then version.
 * Deterministic so the same lockfile always sends its remainder to the same
 * package (SPEC-v3.md 5.2: "the remainder goes to the first package in sort
 * order, so ledger sums equal pool inflows exactly").
 */
export function sortPackages(packages: AttributionEntry[]): AttributionEntry[] {
  return [...packages].sort(
    (a, b) => a.pkg.localeCompare(b.pkg) || a.version.localeCompare(b.version),
  )
}

/**
 * auditor -> `github:<reviewer>` from the review record, already resolved
 * onto AttributionEntry.auditor. A missing reviewer maps to `unassigned`.
 */
export function resolveAuditorIdentity(entry: AttributionEntry): string {
  return entry.auditor ?? UNASSIGNED
}

/**
 * maintainer -> `github:<owner>`, already resolved onto
 * AttributionEntry.maintainer by the packument parser. A non-GitHub or
 * missing repository maps to `unassigned`.
 */
export function resolveMaintainerIdentity(entry: AttributionEntry): string {
  return entry.maintainer ?? UNASSIGNED
}

/**
 * reviewer (the adversarial 15%) -> `unassigned` in the MVP. No adversarial
 * review exists yet; it stays in the reviewer pool as the future bounty
 * budget (SPEC-v3.md 5.2). This ignores the entry entirely on purpose.
 */
export function resolveReviewerIdentity(_entry: AttributionEntry): string {
  return UNASSIGNED
}

const IDENTITY_RESOLVERS: Readonly<Record<Role, (entry: AttributionEntry) => string>> = {
  auditor: resolveAuditorIdentity,
  maintainer: resolveMaintainerIdentity,
  reviewer: resolveReviewerIdentity,
}

export function resolveIdentity(role: Role, entry: AttributionEntry): string {
  return IDENTITY_RESOLVERS[role](entry)
}

/**
 * Parse a GitHub `owner` out of an npm packument's `repository.url` for one
 * version (SPEC-v3.md 5.2). Handles the common forms: `git+https://`,
 * `https://`, `git://`, and scp-style `git@github.com:owner/repo.git`. A
 * non-GitHub or unparsable URL returns null, which callers map to
 * `unassigned` — this mapping is self-declared by the publisher, so callers
 * must still mark it `repo_verified=false`.
 */
export function parseMaintainerIdentity(repositoryUrl: string | null | undefined): string | null {
  if (!repositoryUrl) return null
  const cleaned = repositoryUrl.replace(/^git\+/, '')

  const scpMatch = cleaned.match(/^git@github\.com:([^/]+)\/[^/]+?(?:\.git)?\/?$/)
  if (scpMatch) return `github:${scpMatch[1]}`

  try {
    const url = new URL(cleaned)
    if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null
    const parts = url.pathname
      .replace(/^\//, '')
      .replace(/\.git$/, '')
      .split('/')
    const owner = parts[0]
    if (!owner) return null
    return `github:${owner}`
  } catch {
    return null
  }
}

/** One row this module hands to the ledger writer — matches the `accruals` table. */
export interface AccrualInput {
  route: Attribution['route']
  pkg: string
  version: string
  role: Role
  identity: string
  amountMicro: number
}

/**
 * Build every accrual row for one settled, paid request.
 *
 * - Tarball / single attest: `packages` has one entry, so each role's whole
 *   share goes to that package's identities (SPEC-v3.md 5.2).
 * - Lockfile: each role's share splits pro-rata across the reviewed
 *   packages with integer division; the remainder lands on the first
 *   package in sort order.
 *
 * WARNING: never call this for a free request. Returns `[]` when
 * `priceMicro` is 0 or `packages` is empty, so the ledger writer never
 * accrues against an unpaid request.
 */
export function buildAccrualInputs(attribution: Attribution): AccrualInput[] {
  if (attribution.priceMicro === 0) return []
  const packages = sortPackages(attribution.packages)
  if (packages.length === 0) return []

  const rows: AccrualInput[] = []
  for (const role of ROLES) {
    const shareMicro = computeRoleShareMicro(attribution.priceMicro, role)
    const perPackage = splitProRata(shareMicro, packages.length)
    packages.forEach((entry, i) => {
      rows.push({
        route: attribution.route,
        pkg: entry.pkg,
        version: entry.version,
        role,
        identity: resolveIdentity(role, entry),
        amountMicro: perPackage[i] ?? 0,
      })
    })
  }
  return rows
}
