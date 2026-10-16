// proxy/src/attest/attribution.ts
//
// Attribution contract, fixed by the orchestrator. A separate work item
// builds the claims ledger and reads this off the request context after
// `next()`, from the response set by the paid attest handlers below.
//
// CAUTION: `priceMicro` must be 0 and `packages` must be empty on the free
// zero-coverage lockfile path. The ledger must never accrue against an
// unpaid request.

/**
 * A role of the revenue split. Treasury and ops take their shares off the top.
 * The reviewer line, the contributor and the maintainer share the package pool.
 * A pool role with no payee pays its share to treasury as `unallocated`.
 */
export type Role = 'reviewer' | 'contributor' | 'maintainer' | 'treasury' | 'ops'

/** One reviewed package's identity data for a paid attest response. */
export interface AttributionEntry {
  pkg: string
  version: string
  /** "github:<login>", or null when unknown. */
  auditor: string | null
}

/** Attribution data a paid attest handler sets on the request context. */
export interface Attribution {
  route: 'tarball' | 'single-attest' | 'lockfile'
  /** Integer micro-USDC actually charged. */
  priceMicro: number
  /** Reviewed packages only — never the unreviewed majority. */
  packages: AttributionEntry[]
}
