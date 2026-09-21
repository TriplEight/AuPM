// proxy/src/attest/attribution.ts
//
// Attribution contract, fixed by the orchestrator. A separate work item
// builds the claims ledger and reads this off the request context after
// `next()`, from the response set by the paid attest handlers below.
//
// CAUTION: `priceMicro` must be 0 and `packages` must be empty on the free
// zero-coverage lockfile path. The ledger must never accrue against an
// unpaid request.

/** A revenue-share role. Reserved for the claims-ledger work item. */
export type Role = 'auditor' | 'maintainer' | 'reviewer'

/** One reviewed package's identity data for a paid attest response. */
export interface AttributionEntry {
  pkg: string
  version: string
  /** "github:<login>", or null when unknown. */
  auditor: string | null
  /** "github:<login>", or null when unknown. */
  maintainer: string | null
}

/** Attribution data a paid attest handler sets on the request context. */
export interface Attribution {
  route: 'tarball' | 'single-attest' | 'lockfile'
  /** Integer micro-USDC actually charged. */
  priceMicro: number
  /** Reviewed packages only — never the unreviewed majority. */
  packages: AttributionEntry[]
}
