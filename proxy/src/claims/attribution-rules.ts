// proxy/src/claims/attribution-rules.ts
//
// Attribution rules for the off-chain claims ledger (SPEC.md section 5.2).
// Pure functions only — no I/O, no database access. proxy/src/claims/ledger.ts
// calls these to turn one paid request's attribution into accrual rows.

// ATTRIBUTION CONTRACT — owned by a separate work item, now landed at
// proxy/src/attest/attribution.ts. Re-exported from there so this module
// never drifts from the canonical shape.
export type { Attribution, AttributionEntry, Role } from '../attest/attribution.js'

import type { Attribution, AttributionEntry, Role } from '../attest/attribution.js'

/** Identity used whenever a role cannot be mapped to a real contributor. */
export const UNASSIGNED = 'unassigned'

/** Identity recorded for the ops role — never `UNASSIGNED` (SPEC.md §13.2). */
export const OPS_IDENTITY = 'ops'

/**
 * All six target roles' share of every 1,000 micro-USDC paid for one
 * reviewed package (SPEC.md §13.2, CLAUDE.md "Canonical facts"). The
 * ledger records all six for every payment, so Phase 2 can add attributed
 * identities for contributor, treasury, and ops with no data loss, even
 * though the MVP resolves all three (plus maintainer and the adversarial
 * reviewer) to `unassigned` today.
 */
export const ROLE_SHARE_PER_1000: Readonly<Record<Role, number>> = {
  auditor: 400,
  contributor: 100,
  maintainer: 200,
  reviewer: 150,
  treasury: 100,
  ops: 50,
}

export const ROLES: readonly Role[] = [
  'auditor',
  'contributor',
  'maintainer',
  'reviewer',
  'treasury',
  'ops',
]

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
 * Canonical sort order for ledger writes: by package name, then version.
 * Deterministic so the same payment always writes its accrual rows in the
 * same order — a debugging and snapshot-testing convenience only; every
 * reviewed package now carries its own exact role shares (SPEC.md §13.2),
 * so no split ever depends on this order for correctness.
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
 * maintainer -> `unassigned`, always (SPEC.md §13.2). No maintainer
 * identity is onboarded yet, so this ignores the entry entirely on purpose
 * — never derived from a packument's self-declared `repository` field.
 */
export function resolveMaintainerIdentity(_entry: AttributionEntry): string {
  return UNASSIGNED
}

/**
 * contributor -> `unassigned`, always (SPEC.md §13.2). No contributor
 * identity is onboarded yet.
 */
export function resolveContributorIdentity(_entry: AttributionEntry): string {
  return UNASSIGNED
}

/**
 * reviewer (the adversarial reviewer) -> `unassigned` in the MVP. No
 * adversarial review exists yet; it stays in the reviewer pool as the
 * future bounty budget (SPEC.md §13.2). This ignores the entry entirely on
 * purpose.
 */
export function resolveReviewerIdentity(_entry: AttributionEntry): string {
  return UNASSIGNED
}

/**
 * treasury -> `unassigned`, always (SPEC.md §13.2). No treasury identity is
 * onboarded yet.
 */
export function resolveTreasuryIdentity(_entry: AttributionEntry): string {
  return UNASSIGNED
}

/**
 * ops -> `ops`, always (SPEC.md §13.2) — the one non-`unassigned` MVP
 * identity, credited on-chain to the ops balance.
 */
export function resolveOpsIdentity(_entry: AttributionEntry): string {
  return OPS_IDENTITY
}

const IDENTITY_RESOLVERS: Readonly<Record<Role, (entry: AttributionEntry) => string>> = {
  auditor: resolveAuditorIdentity,
  contributor: resolveContributorIdentity,
  maintainer: resolveMaintainerIdentity,
  reviewer: resolveReviewerIdentity,
  treasury: resolveTreasuryIdentity,
  ops: resolveOpsIdentity,
}

export function resolveIdentity(role: Role, entry: AttributionEntry): string {
  return IDENTITY_RESOLVERS[role](entry)
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
 * Every route prices each reviewed package at exactly 1,000 microUSDC
 * (SPEC.md §11.2), so every package in `attribution.packages` gets its own
 * full set of exact role shares (400 / 100 / 200 / 150 / 100 / 50) —
 * tarball and single-attest (one package) the same way lockfile (N
 * packages) does. No division, no remainder, and no cross-package split
 * (SPEC.md §13.2).
 *
 * WARNING: never call this for a free request. Returns `[]` when
 * `priceMicro` is 0 or `packages` is empty, so the ledger writer never
 * accrues against an unpaid request.
 *
 * WARNING: throws if `priceMicro` does not equal `packages.length * 1000` —
 * the one invariant that keeps the charged amount and the ledgered amount
 * from ever disagreeing. A caller with a mismatched price has a bug
 * upstream; this never silently reconciles it.
 */
export function buildAccrualInputs(attribution: Attribution): AccrualInput[] {
  if (attribution.priceMicro === 0) return []
  const packages = sortPackages(attribution.packages)
  if (packages.length === 0) return []

  const expectedPriceMicro = packages.length * 1000
  if (attribution.priceMicro !== expectedPriceMicro) {
    throw new Error(
      `buildAccrualInputs: priceMicro ${attribution.priceMicro} does not match ` +
        `${packages.length} reviewed package(s) at 1,000 microUSDC each ` +
        `(expected ${expectedPriceMicro})`,
    )
  }

  const rows: AccrualInput[] = []
  for (const entry of packages) {
    for (const role of ROLES) {
      rows.push({
        route: attribution.route,
        pkg: entry.pkg,
        version: entry.version,
        role,
        identity: resolveIdentity(role, entry),
        amountMicro: ROLE_SHARE_PER_1000[role],
      })
    }
  }
  return rows
}
