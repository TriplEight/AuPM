// proxy/src/claims/ledger.ts
//
// Read/write access to the claims ledger (accruals, claims, payouts). This
// is the only module in proxy/src/claims that touches SQL directly, besides
// table creation in schema.ts.

import { randomBytes } from 'node:crypto'
import { type Attribution, buildAccrualInputs, UNASSIGNED } from './attribution-rules.js'
import db, { type AccrualRow, type ClaimRow, type ClaimStatus, type PayoutRow } from './schema.js'

// ---------------------------------------------------------------------------
// Identity canonicalisation
// ---------------------------------------------------------------------------

/**
 * Canonical form for every stored identity string. Lower-cases the whole
 * string, so `github:Alice` and `github:alice` always collapse to the same
 * row and join key. Apply this everywhere an identity is written or looked
 * up: claim creation, claim lookup, accrual writes, and the earnings lookup.
 * That keeps a row from ever being written in a non-canonical form.
 *
 * WARNING: this only normalises case for storage and joins. It must never
 * replace the case-insensitive proof-owner comparison in
 * `requireProofOwnerMatchesIdentity` — that check stays independent, and
 * still accepts a proof owner differing only in case.
 */
function canonicalizeIdentity(identity: string): string {
  return identity.toLowerCase()
}

// ---------------------------------------------------------------------------
// Accruals
// ---------------------------------------------------------------------------

// ON CONFLICT DO NOTHING makes a replayed settle_txid a no-op: the primary
// key (settle_txid, role, pkg, version) already exists, so the row already
// written wins and no second accrual is written (SPEC-v3.md 5.2, CLAUDE.md
// invariant "idempotent").
const insertAccrual = db.prepare<[string, string, string, string, string, string, number, number]>(
  `INSERT INTO accruals
     (settle_txid, route, pkg, version, role, identity, amount_micro, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)
   ON CONFLICT (settle_txid, role, pkg, version) DO NOTHING`,
)

const countAccrualsForTxid = db.prepare<[string], { n: number }>(
  'SELECT COUNT(*) as n FROM accruals WHERE settle_txid = ?',
)

/**
 * Write every accrual row for one settled, paid request. Idempotent on
 * (settle_txid, role, pkg, version): replaying the same settle_txid writes
 * no second accrual and leaves the ledger total unchanged.
 *
 * WARNING: never call this when `attribution.priceMicro` is 0 — the ledger
 * must not accrue against an unpaid request. `buildAccrualInputs` already
 * returns `[]` for a free request, so this is a no-op there, but callers
 * (the middleware) must still gate on a successful settlement first.
 *
 * Returns the number of rows this call newly wrote (0 on a pure replay).
 */
export function writeAccruals(attribution: Attribution, settleTxid: string): number {
  const inputs = buildAccrualInputs(attribution)
  if (inputs.length === 0) return 0

  const createdAt = Date.now()
  let written = 0
  const runAll = db.transaction((rows: typeof inputs) => {
    for (const row of rows) {
      const result = insertAccrual.run(
        settleTxid,
        row.route,
        row.pkg,
        row.version,
        row.role,
        canonicalizeIdentity(row.identity),
        row.amountMicro,
        createdAt,
      )
      written += result.changes
    }
  })
  runAll(inputs)
  return written
}

export function accrualCountForTxid(settleTxid: string): number {
  return countAccrualsForTxid.get(settleTxid)?.n ?? 0
}

const listAccrualsForTxid = db.prepare<[string], AccrualRow>(
  'SELECT * FROM accruals WHERE settle_txid = ? ORDER BY pkg, version, role',
)

export function getAccrualsForTxid(settleTxid: string): AccrualRow[] {
  return listAccrualsForTxid.all(settleTxid)
}

const sumAccrualsByIdentityAndRole = db.prepare<[string], { role: string; total: number }>(
  'SELECT role, SUM(amount_micro) as total FROM accruals WHERE identity = ? GROUP BY role',
)

const sumPaidByIdentityAndRole = db.prepare<[string], { role: string; total: number }>(
  'SELECT role, SUM(amount_micro) as total FROM payouts WHERE identity = ? GROUP BY role',
)

export interface RoleEarnings {
  role: string
  accruedMicro: number
  claimedMicro: number
}

export interface Earnings {
  identity: string
  claimStatus: ClaimStatus | 'none'
  roles: RoleEarnings[]
  totalAccruedMicro: number
  totalClaimedMicro: number
}

/**
 * Accrued and claimed (paid out) totals per role for one GitHub login.
 * Public and free (SPEC-v3.md 5.3 step 1) — reports only this identity's
 * own data, never another identity's.
 */
export function getEarningsForLogin(login: string): Earnings {
  const identity = canonicalizeIdentity(`github:${login}`)
  const accrued = new Map<string, number>()
  for (const row of sumAccrualsByIdentityAndRole.all(identity)) accrued.set(row.role, row.total)

  const claimed = new Map<string, number>()
  for (const row of sumPaidByIdentityAndRole.all(identity)) claimed.set(row.role, row.total)

  const roles = new Set([...accrued.keys(), ...claimed.keys()])
  const roleEarnings: RoleEarnings[] = [...roles].sort().map((role) => ({
    role,
    accruedMicro: accrued.get(role) ?? 0,
    claimedMicro: claimed.get(role) ?? 0,
  }))

  const claim = getClaim(identity)

  return {
    identity,
    claimStatus: claim?.status ?? 'none',
    roles: roleEarnings,
    totalAccruedMicro: roleEarnings.reduce((sum, r) => sum + r.accruedMicro, 0),
    totalClaimedMicro: roleEarnings.reduce((sum, r) => sum + r.claimedMicro, 0),
  }
}

// ---------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------

const upsertClaim = db.prepare<[string, string, string, number]>(
  `INSERT INTO claims (identity, algorand_address, nonce, status, created_at)
   VALUES (?, ?, ?, 'pending', ?)
   ON CONFLICT (identity) DO UPDATE SET
     algorand_address = excluded.algorand_address,
     nonce            = excluded.nonce,
     status           = 'pending',
     proof_kind       = NULL,
     proof_ref        = NULL,
     verified_at      = NULL`,
)

const selectClaim = db.prepare<[string], ClaimRow>('SELECT * FROM claims WHERE identity = ?')

/**
 * Thrown by `createClaim` when a `verified` claim already exists for the
 * identity. `POST /api/v1/claims` is unauthenticated, so anyone who knows a
 * contributor's identity string could otherwise reset a verified claim back
 * to `pending`, replace the stored Algorand address with their own, and
 * block `scripts/payout.ts` (which pays only `status='verified'` rows)
 * indefinitely. Callers (routes.ts) must reject the HTTP request on this
 * error rather than silently reopen the claim.
 *
 * A `pending` or `failed` claim is still freely re-issuable — that is the
 * legitimate retry path for a claimant who lost their nonce. A verified
 * claimant who genuinely needs to move to a new Algorand address is not
 * served by this endpoint; that requires a manual, human-checked database
 * update (see the operator runbook), the same trust boundary
 * `recordPayout` already relies on.
 */
export class ClaimAlreadyVerifiedError extends Error {}

/**
 * Register a pending claim and return its nonce. A repeat POST for the same
 * identity issues a fresh nonce and resets it to pending (SPEC-v3.md 5.3
 * step 2) — the claimant re-proves with the new nonce.
 *
 * WARNING: throws `ClaimAlreadyVerifiedError` when the stored claim for this
 * identity is already `verified`. A verified claim is not reopened through
 * this endpoint — see the class doc above.
 */
export function createClaim(identity: string, algorandAddress: string): { nonce: string } {
  const canonicalIdentity = canonicalizeIdentity(identity)
  const existing = selectClaim.get(canonicalIdentity)
  if (existing?.status === 'verified') {
    throw new ClaimAlreadyVerifiedError(
      `identity "${canonicalIdentity}" is already verified; it cannot be re-claimed through this endpoint`,
    )
  }
  const nonce = randomBytes(16).toString('hex')
  upsertClaim.run(canonicalIdentity, algorandAddress, nonce, Date.now())
  return { nonce }
}

export function getClaim(identity: string): ClaimRow | undefined {
  return selectClaim.get(canonicalizeIdentity(identity))
}

export type ProofKind = 'well-known' | 'gist'

export interface ClaimProof {
  kind: ProofKind
  owner: string // repo owner for 'well-known'; gist-owning login for 'gist'
  repo?: string // required for 'well-known'
}

/**
 * Reads GitHub through an injectable client — CAUTION: production code
 * passes a real client; tests must always pass a stub so no test performs a
 * network call.
 */
export interface GithubClient {
  /** Raw text of `path` on the default branch of owner/repo, or null if missing. */
  getFile(owner: string, repo: string, path: string): Promise<string | null>
  /** Concatenated text of every file in a public gist owned by `login`, or null if none. */
  getGistContent(login: string): Promise<string | null>
}

/**
 * Thrown by `verifyClaim` when `proof.owner` does not bind to the identity
 * being claimed. Callers (routes.ts) must reject the HTTP request on this
 * error rather than record a `failed` claim — see the module-level defect
 * note above `verifyClaim`.
 */
export class ClaimIdentityMismatchError extends Error {}

/**
 * `identity` has the form `github:<login>`. Returns the login, or throws
 * `ClaimIdentityMismatchError` when `identity` does not parse, or is the
 * literal `unassigned`, which is never claimable.
 */
function requireLoginFromIdentity(identity: string): string {
  if (identity === UNASSIGNED) {
    throw new ClaimIdentityMismatchError(`identity "${identity}" is never claimable`)
  }
  const match = /^github:(.+)$/.exec(identity)
  if (!match?.[1]) {
    throw new ClaimIdentityMismatchError(
      `identity "${identity}" does not match the required form github:<login>`,
    )
  }
  return match[1]
}

/**
 * A proof must be published by the identity it claims to verify, or anyone
 * could publish a proof for anyone else's claim and steal their payouts.
 *
 * WARNING: call this before any GitHub API read (`proofContainsClaim`) and
 * before any database write. A mismatch must reject the request outright —
 * never fall through to a stored `failed` claim status — so an attacker
 * learns nothing about whether a claim exists and burns no GitHub quota.
 *
 * Login comparison is case-insensitive: GitHub logins are case-insensitive.
 * This applies to both proof kinds — for 'well-known' the repository must
 * belong to the claimed identity, exactly like the gist-owning login for
 * 'gist'.
 */
function requireProofOwnerMatchesIdentity(identity: string, proof: ClaimProof): void {
  const login = requireLoginFromIdentity(identity)
  if (proof.owner.toLowerCase() !== login.toLowerCase()) {
    throw new ClaimIdentityMismatchError(
      `proof owner "${proof.owner}" does not match the identity being claimed ("${identity}")`,
    )
  }
}

async function proofContainsClaim(
  claim: ClaimRow,
  proof: ClaimProof,
  github: GithubClient,
): Promise<boolean> {
  if (proof.kind === 'well-known') {
    if (!proof.repo) return false
    const raw = await github.getFile(proof.owner, proof.repo, '.well-known/spm-claim.json')
    if (!raw) return false
    try {
      const parsed = JSON.parse(raw) as { algorand?: string; nonce?: string }
      return parsed.algorand === claim.algorand_address && parsed.nonce === claim.nonce
    } catch {
      return false
    }
  }
  const content = await github.getGistContent(proof.owner)
  if (!content) return false
  const expected = `spm-claim:${claim.algorand_address}:${claim.nonce}`
  return content.includes(expected)
}

const updateClaimStatus = db.prepare<[ClaimStatus, string, string, number | null, string]>(
  `UPDATE claims SET status = ?, proof_kind = ?, proof_ref = ?, verified_at = ? WHERE identity = ?`,
)

/**
 * Verify a claim's published proof against its stored nonce, via GitHub API
 * reads through `github` (SPEC-v3.md 5.3 steps 3-4). Sets `status=verified`
 * on success, `status=failed` when the nonce does not match or the proof is
 * missing. Returns null when no pending claim exists for `identity`.
 *
 * WARNING: throws `ClaimIdentityMismatchError` when `proof.owner` does not
 * bind to `identity`, or when `identity` does not parse as `github:<login>`
 * (including the literal `unassigned`). This check runs first, before the
 * claim lookup and before any GitHub API read, so a hijack attempt — proving
 * ownership of someone else's claim from an attacker-owned gist or repo —
 * is rejected outright rather than recorded as a `failed` claim.
 */
export async function verifyClaim(
  identity: string,
  proof: ClaimProof,
  github: GithubClient,
): Promise<ClaimRow | null> {
  // Canonicalise first: every write and lookup below must use the same
  // stored form as createClaim, or a claim created as `github:Alice` would
  // never find its own row here.
  const canonicalIdentity = canonicalizeIdentity(identity)
  requireProofOwnerMatchesIdentity(canonicalIdentity, proof)

  const claim = getClaim(canonicalIdentity)
  if (!claim) return null

  const ok = await proofContainsClaim(claim, proof, github)
  const status: ClaimStatus = ok ? 'verified' : 'failed'
  const proofRef = proof.kind === 'well-known' ? `${proof.owner}/${proof.repo}` : proof.owner
  updateClaimStatus.run(status, proof.kind, proofRef, ok ? Date.now() : null, canonicalIdentity)
  return getClaim(canonicalIdentity) ?? null
}

// ---------------------------------------------------------------------------
// Payouts
// ---------------------------------------------------------------------------

const insertPayout = db.prepare<[string, string, number, string, number]>(
  `INSERT INTO payouts (identity, role, amount_micro, txid, paid_at)
   VALUES (?, ?, ?, ?, ?)
   ON CONFLICT (identity, role, txid) DO NOTHING`,
)

/**
 * Record a manual, human-checked payout (SPEC-v3.md 5.3 step 5).
 *
 * CAUTION: canonicalises `identity` on the way in, same as every other
 * write in this module, so a manually-typed mixed-case identity still joins
 * against the accruals this payout is settling.
 */
export function recordPayout(
  identity: string,
  role: string,
  amountMicro: number,
  txid: string,
): void {
  insertPayout.run(canonicalizeIdentity(identity), role, amountMicro, txid, Date.now())
}

export function listPayoutsForIdentity(identity: string): PayoutRow[] {
  return db
    .prepare<[string], PayoutRow>('SELECT * FROM payouts WHERE identity = ?')
    .all(canonicalizeIdentity(identity))
}
