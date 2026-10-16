// proxy/src/claims/attribution-rules.ts
//
// Attribution rules for the off-chain claims ledger.
// Pure functions only — no I/O, no database access. proxy/src/claims/ledger.ts
// calls these to turn one paid request's attribution into accrual rows.

// ATTRIBUTION CONTRACT — owned by a separate work item, now landed at
// proxy/src/attest/attribution.ts. Re-exported from there so this module
// never drifts from the canonical shape.
export type { Attribution, AttributionEntry, Role } from '../attest/attribution.js'

import type { Attribution, AttributionEntry, Role } from '../attest/attribution.js'

/** Identity of the ops income. It is never a payee. */
export const OPS_IDENTITY = 'ops'

/** Identity of the treasury income. It is never a payee. */
export const TREASURY_IDENTITY = 'treasury'

/** Treasury share off the top, per 1,000 micro-USDC paid for one reviewed package. */
export const CUT_PER_1000 = 200

/** Ops share off the top, per 1,000 micro-USDC paid for one reviewed package. */
export const OPS_PER_1000 = 50

/** Roles that share the package pool. */
export type PoolRole = 'reviewer' | 'contributor' | 'maintainer'

/**
 * Share of each pool role, per 1,000 micro-USDC paid. The three shares sum to
 * 750: what is left after the cut and the ops share.
 */
export const POOL_SHARE_PER_1000: Readonly<Record<PoolRole, number>> = {
  reviewer: 400,
  contributor: 100,
  maintainer: 250,
}

export const POOL_ROLES: readonly PoolRole[] = ['reviewer', 'contributor', 'maintainer']

/** The four kinds of treasury income in the ledger. */
export type TreasuryKind = 'cut' | 'unallocated' | 'slash' | 'forfeit'

/**
 * The MVP split that the live contract still pays: the auditor gets 30%,
 * ops gets the rest. Only the public disclosure text uses it.
 */
export function mvpSplit(): {
  auditorPercent: number
  opsPercent: number
} {
  const auditorPercent = 30
  return { auditorPercent, opsPercent: 100 - auditorPercent }
}

/** Default hold of a pool share, in days. */
export const DEFAULT_HOLD_DAYS = 30

const MAX_HOLD_DAYS = 3650
const DAY_MS = 24 * 60 * 60 * 1000

/**
 * Reads the hold of a pool share from `POOL_HOLD_DAYS` and returns it in
 * milliseconds. An unset or empty value gives the default of 30 days.
 * Throws on a value that is not a whole number of days from 1 to 3650,
 * so a bad value stops the process at boot.
 */
export function holdMsFromEnv(env: NodeJS.ProcessEnv): number {
  const raw = env.POOL_HOLD_DAYS?.trim()
  if (raw === undefined || raw === '') return DEFAULT_HOLD_DAYS * DAY_MS
  const days = Number(raw)
  if (!/^\d+$/.test(raw) || days < 1 || days > MAX_HOLD_DAYS) {
    throw new Error(
      `POOL_HOLD_DAYS must be a whole number of days from 1 to ${MAX_HOLD_DAYS}, got "${raw}". ` +
        `Unset it to use the default of ${DEFAULT_HOLD_DAYS} days.`,
    )
  }
  return days * DAY_MS
}

/**
 * Canonical sort order for ledger writes: by package name, then version.
 * Deterministic so the same payment always writes its accrual rows in the
 * same order. No split depends on this order for correctness.
 */
export function sortPackages(packages: AttributionEntry[]): AttributionEntry[] {
  return [...packages].sort(
    (a, b) => a.pkg.localeCompare(b.pkg) || a.version.localeCompare(b.version),
  )
}

/** One row this module hands to the ledger writer — matches the `accruals` table. */
export interface AccrualInput {
  route: Attribution['route']
  pkg: string
  version: string
  role: Role
  identity: string
  amountMicro: number
  /** Set on a treasury income row, null on a payee row and on an ops row. */
  treasuryKind: TreasuryKind | null
  /** True for a pool share: it unlocks after the hold. Off-the-top rows are not held. */
  held: boolean
}

/** One share of a pool role: a payee, or treasury `unallocated`. */
export interface PoolShare {
  identity: string
  amountMicro: number
  treasuryKind: TreasuryKind | null
}

/**
 * Splits the share of one pool role equally between its `payees` with
 * integer division. The remainder goes to treasury as `unallocated`. A role
 * with no payee gives its whole share to treasury as `unallocated`.
 */
export function splitPoolShare(amountMicro: number, payees: string[]): PoolShare[] {
  const unallocated = (amount: number): PoolShare => ({
    identity: TREASURY_IDENTITY,
    amountMicro: amount,
    treasuryKind: 'unallocated',
  })
  if (payees.length === 0) return [unallocated(amountMicro)]
  const each = Math.floor(amountMicro / payees.length)
  const rest = amountMicro - each * payees.length
  const shares: PoolShare[] =
    each > 0 ? payees.map((identity) => ({ identity, amountMicro: each, treasuryKind: null })) : []
  if (rest > 0 || each === 0) shares.push(unallocated(rest))
  return shares
}

/**
 * The payees of one pool role of one package. Only the reviewer line has a
 * payee today: the reviewer of the review record. Never `ops` or `treasury`.
 * Contributor and maintainer are not onboarded, so they have no payee.
 */
function payeesOf(role: PoolRole, entry: AttributionEntry): string[] {
  if (role !== 'reviewer' || entry.auditor === null) return []
  const name = entry.auditor.toLowerCase()
  return name === OPS_IDENTITY || name === TREASURY_IDENTITY ? [] : [name]
}

/** Every accrual row of one reviewed package for one payment of 1,000 micro-USDC. */
function packageRows(route: Attribution['route'], entry: AttributionEntry): AccrualInput[] {
  const base = { route, pkg: entry.pkg, version: entry.version }
  const rows: AccrualInput[] = [
    {
      ...base,
      role: 'treasury',
      identity: TREASURY_IDENTITY,
      amountMicro: CUT_PER_1000,
      treasuryKind: 'cut',
      held: false,
    },
    {
      ...base,
      role: 'ops',
      identity: OPS_IDENTITY,
      amountMicro: OPS_PER_1000,
      treasuryKind: null,
      held: false,
    },
  ]
  for (const role of POOL_ROLES) {
    for (const share of splitPoolShare(POOL_SHARE_PER_1000[role], payeesOf(role, entry))) {
      rows.push({ ...base, role, ...share, held: true })
    }
  }
  return rows
}

/**
 * Build every accrual row for one settled, paid request.
 *
 * Every route prices each reviewed package at exactly 1,000 microUSDC, so
 * every package in `attribution.packages` gets its own exact shares: cut 200
 * and ops 50 off the top, then the pool of that exact `name@version`
 * (reviewer line 400, contributor 100, maintainer 250). A pool role with no
 * payee goes to treasury as `unallocated`. Money is integer micro-units.
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
  return packages.flatMap((entry) => packageRows(attribution.route, entry))
}
