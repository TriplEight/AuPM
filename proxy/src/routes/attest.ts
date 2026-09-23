// proxy/src/routes/attest.ts
//
// Handlers for the two paid attestation routes:
//   POST /v1/attest/lockfile  — whole-tree attestation, $0.02, free when the
//                                tree has zero reviewed packages.
//   GET  /v1/attest           — single-package attestation, $0.001 (query:
//                                name, version). Free when the requested
//                                version resolves below COMMUNITY_REVIEWED,
//                                including a paid-tier row with no stored
//                                integrity (an incomplete review).
//
// Registration order in app.ts matters: the pre-middlewares here run
// *before* the x402 payment gate, so a malformed lockfile (400), a
// zero-coverage lockfile (free 200), or an unreviewed single-package lookup
// (free 200) never reaches — and is never charged by — the facilitator. The
// `*Handler`s run *after* the gate, only once payment has cleared.

import { getConnInfo } from '@hono/node-server/conninfo'
import type { Context, MiddlewareHandler } from 'hono'
import type { AppVariables } from '../app.js'
import type { AttributionEntry } from '../attest/attribution.js'
import type { SigningKeyLike, Statement } from '../attest/dsse.js'
import {
  buildLockfileStatement,
  buildSinglePackageStatement,
  signEnvelope,
} from '../attest/dsse.js'
import type { IntegrityLookup, LockfileAnalysis } from '../attest/lockfile.js'
import { analyzeLockfile, LOCKFILE_MAX_BYTES } from '../attest/lockfile.js'
import {
  createRateLimiter,
  DEFAULT_FREE_LOCKFILE_RATE_LIMIT,
  type RateLimiter,
} from '../attest/ratelimit.js'
import { CAIP2_NETWORK, ISSUER, LOCKFILE_PREDICATE_TYPE, SINGLE_PREDICATE_TYPE } from '../config.js'
import { getStatusOrUnreviewed, isReviewedWithIntegrity, reviewerIdentity } from '../status.js'

type AttestContext = Context<{ Variables: AppVariables }>

export const LOCKFILE_PRICE_MICRO = 20_000
export const SINGLE_ATTEST_PRICE_MICRO = 1_000

const PAYLOAD_TYPE = 'application/vnd.in-toto+json'

// The parsed, classified lockfile the pre-middleware hands to the paid
// handler once payment clears, so the body is parsed and hashed exactly
// once. The context variable key ('spmLockfileAnalysis') is declared on
// AppVariables in app.ts.
const ANALYSIS_KEY = 'spmLockfileAnalysis' as const

/**
 * True only when TRUST_PROXY says this server runs behind a known reverse
 * proxy. Read fresh on every call, never cached — tests toggle it per case.
 * Default: not trusted, so an unset TRUST_PROXY never trusts a caller
 * header.
 */
function isTrustProxyEnabled(): boolean {
  const raw = (process.env.TRUST_PROXY ?? '').trim().toLowerCase()
  return raw === '1' || raw === 'true'
}

/**
 * The real TCP peer address, via @hono/node-server's ConnInfo helper. A
 * caller cannot forge this — unlike a header — so it is the correct default
 * bucket key for the free-path rate limiter (SPEC.md §12.3).
 *
 * CAUTION: `getConnInfo` reads `c.env.incoming.socket`, which only exists
 * when this app runs under `@hono/node-server`'s `serve()`. A test harness
 * driven by Hono's `app.request()` without an injected `incoming` env has
 * no such socket and `getConnInfo` throws. Caught here and treated as
 * genuinely unavailable — never left to throw out of the handler.
 */
function socketAddress(c: AttestContext): string | null {
  try {
    const address = getConnInfo(c).remote.address
    return address && address.length > 0 ? address : null
  } catch {
    return null
  }
}

/**
 * Resolves the caller's IP for the free-path rate limiter. The single
 * decision point for every caller, so `X-Forwarded-For` and `X-Real-IP`
 * can never drift apart into two different trust rules again.
 *
 * WARNING: both `X-Forwarded-For` and `X-Real-IP` are attacker-controlled
 * input unless a known reverse proxy sits in front of this server. Trusting
 * either unconditionally lets a caller defeat the free-path rate limit —
 * the stated control against using SPM as an unpriced signing oracle
 * (SPEC.md §12.3) — by sending a different value on every request. Only
 * trust either header when TRUST_PROXY says so; otherwise ignore both and
 * fall back to the unspoofable socket address.
 *
 * Precedence when TRUST_PROXY is set and both headers are present:
 * `X-Forwarded-For`'s trusted last hop wins over `X-Real-IP`.
 *
 * WARNING: never fall back to one shared constant while the socket address
 * is available — one caller who exhausts the cap would then block the free
 * path for every other caller, trading the header-spoofing bypass for a
 * denial of service. The shared constant is only for a genuinely
 * unavailable socket address.
 */
function clientIp(c: AttestContext): string {
  if (isTrustProxyEnabled()) {
    const forwarded = c.req.header('x-forwarded-for')
    if (forwarded && forwarded.length > 0) {
      // Single trusted hop: this server sits behind exactly one reverse
      // proxy, which appends the connecting client's own address as the
      // last entry before forwarding the request on. Every entry to the
      // left of it came from the client (or further upstream) and is not
      // to be trusted — never take the leftmost entry.
      const hops = forwarded
        .split(',')
        .map((hop) => hop.trim())
        .filter((hop) => hop.length > 0)
      const lastHop = hops[hops.length - 1]
      if (lastHop) return lastHop
    }
    const realIp = c.req.header('x-real-ip')
    if (realIp && realIp.length > 0) return realIp
  }
  // Untrusted (TRUST_PROXY unset/false): ignore both headers, since neither
  // can be trusted without a known reverse proxy in front. Use the
  // unspoofable socket address; only when that is genuinely unavailable do
  // every caller share one bucket.
  return socketAddress(c) ?? 'unknown'
}

/**
 * True only when the caller explicitly asked for the free partial
 * attestation on a paid-tier package (SPEC.md §11.2, §12.3, ADR 0006).
 * `X-SPM-Donate: 0` — and only that exact value — triggers it; a missing
 * header or any other value falls through to standard x402 pricing.
 */
function requestedPartial(c: AttestContext): boolean {
  return c.req.header('X-SPM-Donate') === '0'
}

/**
 * Distinct from the 400 a malformed-but-bounded body gets. A caller can
 * tell "too big" from "not valid JSON" without parsing the response body.
 */
const BODY_TOO_LARGE_STATUS = 413

function bodyTooLargeResponse(c: AttestContext, maxBytes: number): Response {
  return c.json({ error: `request body exceeds the ${maxBytes}-byte limit` }, BODY_TOO_LARGE_STATUS)
}

/**
 * Reads `POST /v1/attest/lockfile`'s request body up to `maxBytes`, and no
 * further — this route is unauthenticated and runs before the payment gate
 * (see the module banner above), so an unbounded read here is a free
 * memory-exhaustion oracle.
 *
 * Two layers, neither sufficient alone:
 *   1. `Content-Length`, checked first, rejects an oversized declared body
 *      before a single byte is read. CAUTION: it is caller-supplied and may
 *      be absent (a chunked request) or false (a lying declared length) —
 *      a fast rejection, never the only defence.
 *   2. The stream itself is read in chunks and the running total is checked
 *      after every chunk. Reading stops — the reader is cancelled — the
 *      instant the total exceeds `maxBytes`, so a chunked request with no
 *      `Content-Length`, or one that understates its real size, still
 *      cannot buffer more than `maxBytes` (plus at most one in-flight
 *      chunk) before this function returns.
 *
 * Returns the exact bytes read, unmodified, when within the cap — the
 * sha256 `analyzeLockfile` computes over them is byte-for-byte the same
 * digest `c.req.arrayBuffer()` would have produced for a valid lockfile.
 */
async function readLimitedBody(
  c: AttestContext,
  maxBytes: number,
): Promise<{ ok: true; bytes: Uint8Array } | { ok: false; response: Response }> {
  const declaredLength = c.req.header('content-length')
  if (declaredLength !== undefined) {
    const declared = Number(declaredLength)
    if (Number.isFinite(declared) && declared > maxBytes) {
      return { ok: false, response: bodyTooLargeResponse(c, maxBytes) }
    }
  }

  const body = c.req.raw.body
  if (!body) {
    return { ok: true, bytes: new Uint8Array(0) }
  }

  const reader = body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value) continue
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel()
        return { ok: false, response: bodyTooLargeResponse(c, maxBytes) }
      }
      chunks.push(value)
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // Already released by cancel() above; never let cleanup mask the
      // real result.
    }
  }

  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { ok: true, bytes }
}

/**
 * Builds `predicate` for the lockfile statement. `partial` is true only for
 * the free `X-SPM-Donate: 0` path (SPEC.md §11.2, §12.3): every reviewed
 * entry whose integrity matches (`integrityMatch === true`) is left out of
 * `packages[]` and counted in `withheld`. An `INTEGRITY_MISMATCH`
 * (`integrityMatch === false`) or `UNRESOLVABLE` (`integrityMatch === null`)
 * entry is never filtered — SPM never charges for a security warning
 * (CLAUDE.md invariant 4).
 *
 * A full (paid, or genuinely zero-coverage) attestation always has
 * `withheld: 0`.
 */
function lockfilePredicate(analysis: LockfileAnalysis, partial: boolean): Record<string, unknown> {
  const packages = partial
    ? analysis.packages.filter((pkg) => pkg.integrityMatch !== true)
    : analysis.packages
  const withheld = analysis.packages.length - packages.length
  return {
    issuer: ISSUER,
    issuedAt: new Date().toISOString(),
    network: CAIP2_NETWORK,
    lockfileVersion: analysis.lockfileVersion,
    summary: analysis.summary,
    packages,
    withheld,
    // Absence from `packages[]` means UNREVIEWED on a full attestation, or
    // UNREVIEWED-or-withheld on a partial one — never the unreviewed
    // majority is listed either way (SPEC.md §12.3).
    absentMeans: partial ? 'UNREVIEWED_OR_WITHHELD' : 'UNREVIEWED',
  }
}

async function signLockfileStatement(
  analysis: LockfileAnalysis,
  key: SigningKeyLike,
  partial: boolean,
): ReturnType<typeof signEnvelope> {
  const statement = buildLockfileStatement({
    subjectName: 'package-lock.json',
    sha256: analysis.sha256,
    predicateType: LOCKFILE_PREDICATE_TYPE,
    predicate: lockfilePredicate(analysis, partial),
  })
  const payload = new TextEncoder().encode(JSON.stringify(statement))
  return signEnvelope(payload, PAYLOAD_TYPE, key)
}

/** A real sha512 digest is exactly 64 bytes. Anything else is not one. */
const SHA512_BYTE_LENGTH = 64

/**
 * Decodes an npm `integrity` string ("sha512-<base64>") to lowercase hex,
 * the digest shape the in-toto subject uses. Returns null for anything that
 * does not match that shape — never a placeholder digest.
 *
 * CAUTION: never widen this to accept `sha1-`. A weak digest must not back
 * a paid security attestation.
 *
 * WARNING: a truncated or padded base64 payload still decodes to *some*
 * bytes even when it is not a genuine sha512 digest. Requiring exactly 64
 * decoded bytes stops that value from being sold, signed, and presented as
 * `digest.sha512` with `integrityMatch: true` — a false security claim.
 */
function integrityToHex(integrity: string): string | null {
  const match = /^sha512-([A-Za-z0-9+/]+=*)$/.exec(integrity)
  const base64 = match?.[1]
  if (!base64) return null
  const decoded = Buffer.from(base64, 'base64')
  if (decoded.length !== SHA512_BYTE_LENGTH) return null
  return decoded.toString('hex')
}

/**
 * True only for a paid-tier row whose stored integrity this route can
 * actually turn into a digest (see integrityToHex()).
 *
 * `isReviewedWithIntegrity()` (status.ts) only checks that some non-null
 * integrity string is stored — it does not know this route only speaks
 * `sha512-`. A row carrying a legacy `sha1-` (or otherwise unusable)
 * integrity would otherwise be priced by the pre-middleware and then always
 * throw in the paid handler, charging the caller for a 500. Treat that row
 * as an incomplete review — the same free-and-honest resolution
 * status.ts's own isReviewedWithIntegrity() applies to a missing integrity
 * — never as paid-and-broken.
 */
function isPriceableSingleAttest(status: ReturnType<typeof getStatusOrUnreviewed>): boolean {
  return (
    isReviewedWithIntegrity(status) &&
    status.integrity !== null &&
    integrityToHex(status.integrity) !== null
  )
}

/**
 * Builds the free-path single-package statement for a package whose version
 * resolves below COMMUNITY_REVIEWED — including a paid-tier row with no
 * stored integrity, which is an incomplete review (status.ts's
 * isReviewedWithIntegrity()). No artifact digest is claimed here — an empty
 * digest map, never a placeholder sha512 value — because no reviewed
 * tarball backs it.
 */
function buildFreeSingleStatement(name: string, version: string): Statement {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: `pkg:npm/${name}@${version}`, digest: {} }],
    predicateType: SINGLE_PREDICATE_TYPE,
    predicate: {
      issuer: ISSUER,
      issuedAt: new Date().toISOString(),
      network: CAIP2_NETWORK,
      packages: [
        {
          name,
          version,
          integrity: null,
          tier: 'UNREVIEWED',
          reviewer: null,
          reviewScope: null,
          anchorTxid: null,
          integrityMatch: null,
        },
      ],
      withheld: 0,
      absentMeans: 'UNREVIEWED',
    },
  }
}

/**
 * Builds the free partial statement for a paid-tier package requested with
 * `X-SPM-Donate: 0` (SPEC.md §11.2, §12.3, ADR 0006). SPEC.md §12.3: a
 * partial attestation is "the same statement, with every reviewed entry
 * whose integrity matches left out of predicate.packages" — the subject is
 * not withheld. Only the one entry this route could otherwise sell (the
 * reviewer, the tier, the anchor txid) is left out of `packages[]`;
 * `subject.digest.sha512` still carries the real, known-good digest, same
 * as the paid statement. `withheld` is always 1 here: single-attest has
 * exactly one candidate entry, and reaching this path means it was priceable.
 */
function buildWithheldSingleStatement(name: string, version: string, sha512: string): Statement {
  return buildSinglePackageStatement({
    packageUrl: `pkg:npm/${name}@${version}`,
    sha512,
    predicateType: SINGLE_PREDICATE_TYPE,
    predicate: {
      issuer: ISSUER,
      issuedAt: new Date().toISOString(),
      network: CAIP2_NETWORK,
      packages: [],
      withheld: 1,
      absentMeans: 'UNREVIEWED_OR_WITHHELD',
    },
  })
}

export interface AttestRoutesOptions {
  /** Loads the SPM attestation signing key. Called lazily, per request. */
  getSigningKey: () => Promise<SigningKeyLike>
  /** Rate limiter for the free (zero-coverage) lockfile path. */
  rateLimiter?: RateLimiter
  /** Known-good tarball integrity lookup for reviewed packages. */
  integrityLookup?: IntegrityLookup
}

export interface AttestRoutes {
  lockfilePreMiddleware: MiddlewareHandler<{ Variables: AppVariables }>
  lockfileHandler: (c: AttestContext) => Promise<Response>
  singleAttestPreMiddleware: MiddlewareHandler<{ Variables: AppVariables }>
  singleAttestHandler: (c: AttestContext) => Promise<Response>
}

/**
 * Builds the four route pieces mounted by app.ts. `getSigningKey` is
 * injected (never called at module-import time), so a boot without
 * ATTEST_SIGNING_KEY set never crashes anything that doesn't reach a paid
 * attest handler.
 */
export function buildAttestRoutes(options: AttestRoutesOptions): AttestRoutes {
  const rateLimiter = options.rateLimiter ?? createRateLimiter(DEFAULT_FREE_LOCKFILE_RATE_LIMIT)

  const lockfilePreMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (c, next) => {
    const limited = await readLimitedBody(c, LOCKFILE_MAX_BYTES)
    if (!limited.ok) {
      return limited.response
    }
    const result = analyzeLockfile(limited.bytes, options.integrityLookup)

    if (!result.ok) {
      // WARNING: return before the payment gate runs — a caller must never
      // be asked to pay for a malformed lockfile.
      return c.json({ error: result.message }, 400)
    }

    const { analysis } = result
    const partial = requestedPartial(c)

    if (analysis.summary.reviewed === 0 || partial) {
      // Free path: charging for zero reviewed packages would charge for
      // nothing (CLAUDE.md free-tier invariant), and `X-SPM-Donate: 0`
      // opts into the free partial attestation (SPEC.md §11.2, §12.3,
      // ADR 0006). Both share this per-IP rate limiter so neither can be
      // used as an unpriced signing oracle (SPEC.md §12.3).
      const ip = clientIp(c)
      if (!rateLimiter.attempt(ip)) {
        return c.json({ error: 'rate limit exceeded for the free lockfile path' }, 429)
      }
      const key = await options.getSigningKey()
      const attestation = await signLockfileStatement(analysis, key, partial)
      c.set('attribution', { route: 'lockfile', priceMicro: 0, packages: [] })
      return c.json({ summary: analysis.summary, attestation })
    }

    // At least one reviewed package and no partial-attestation opt-out: the
    // route is genuinely priced. Hand the already-parsed analysis to the
    // paid handler so the body — already consumed above — is never re-read
    // or re-parsed.
    c.set(ANALYSIS_KEY, analysis)
    await next()
  }

  const lockfileHandler = async (c: AttestContext): Promise<Response> => {
    const analysis = c.get(ANALYSIS_KEY)
    if (!analysis) {
      // Defensive: the pre-middleware always sets this on the paid path.
      // Fail closed, not open, if the wiring is ever wrong.
      return c.json({ error: 'internal error: lockfile analysis missing' }, 500)
    }

    const key = await options.getSigningKey()
    const attestation = await signLockfileStatement(analysis, key, false)

    const packages: AttributionEntry[] = analysis.reviewedPackageRefs.map((ref) => ({
      pkg: ref.pkg,
      version: ref.version,
      auditor: ref.auditor,
      // Deriving the maintainer identity needs the npm packument's
      // repository field (SPEC.md §13.2) — that's the claims-ledger work
      // item's job, not this route's. Never fabricated here.
      maintainer: null,
    }))
    c.set('attribution', { route: 'lockfile', priceMicro: LOCKFILE_PRICE_MICRO, packages })

    return c.json({ summary: analysis.summary, attestation })
  }

  const singleAttestPreMiddleware: MiddlewareHandler<{ Variables: AppVariables }> = async (
    c,
    next,
  ) => {
    const name = c.req.query('name')
    const version = c.req.query('version')
    if (!name || !version) {
      return c.json({ error: 'query parameters "name" and "version" are required' }, 400)
    }

    const status = getStatusOrUnreviewed(name, version)
    if (!isPriceableSingleAttest(status)) {
      // Free tier: status < COMMUNITY_REVIEWED never returns 402 — and a
      // paid-tier row with no stored integrity, or with an integrity this
      // route cannot decode to a digest (e.g. a legacy `sha1-` value), is
      // an incomplete review, treated the same way (CLAUDE.md free-tier
      // invariant). Answered here,
      // before the x402 payment gate in app.ts runs at all: GET /v1/attest
      // is otherwise unconditionally priced, and the gate reads only the
      // path, not these query params, so it can never grant this itself.
      // Rate-limited per IP so it cannot be used as an unpriced signing
      // oracle, same reason as the zero-coverage lockfile free path.
      const ip = clientIp(c)
      if (!rateLimiter.attempt(ip)) {
        return c.json({ error: 'rate limit exceeded for the free single-attest path' }, 429)
      }
      const key = await options.getSigningKey()
      const statement = buildFreeSingleStatement(name, version)
      const payload = new TextEncoder().encode(JSON.stringify(statement))
      const attestation = await signEnvelope(payload, PAYLOAD_TYPE, key)
      c.set('attribution', { route: 'single-attest', priceMicro: 0, packages: [] })
      return c.json({ tier: 'UNREVIEWED', attestation })
    }

    if (requestedPartial(c)) {
      // Paid-tier package, but the caller opted into the free partial
      // attestation with `X-SPM-Donate: 0` (SPEC.md §11.2, §12.3, ADR
      // 0006). Only `packages[]` (the reviewer, the tier, the anchor txid)
      // is withheld — the subject digest is not (SPEC.md §12.3) — so the
      // same fail-closed guards as the paid handler below apply here too:
      // fail closed, not open, if the store changed since
      // isPriceableSingleAttest() above was checked.
      if (status.integrity === null) {
        return c.json({ error: 'internal error: reviewed package missing stored integrity' }, 500)
      }
      const partialHex = integrityToHex(status.integrity)
      if (partialHex === null) {
        return c.json(
          { error: 'internal error: stored integrity is not a valid sha512 value' },
          500,
        )
      }
      // Rate-limited per IP, same limiter as the free-tier path above, so
      // this cannot be used as an unpriced signing oracle either.
      const ip = clientIp(c)
      if (!rateLimiter.attempt(ip)) {
        return c.json({ error: 'rate limit exceeded for the free single-attest path' }, 429)
      }
      const key = await options.getSigningKey()
      const statement = buildWithheldSingleStatement(name, version, partialHex)
      const payload = new TextEncoder().encode(JSON.stringify(statement))
      const attestation = await signEnvelope(payload, PAYLOAD_TYPE, key)
      c.set('attribution', { route: 'single-attest', priceMicro: 0, packages: [] })
      return c.json({ tier: status.status, attestation })
    }

    await next()
  }

  const singleAttestHandler = async (c: AttestContext): Promise<Response> => {
    // Presence and the free-tier decision are already made by
    // singleAttestPreMiddleware, which always runs first in the registered
    // chain (see app.ts) — reaching this handler means the package resolved
    // to a paid tier with a stored integrity at that point.
    const name = c.req.query('name') as string
    const version = c.req.query('version') as string

    const status = getStatusOrUnreviewed(name, version)
    if (!isPriceableSingleAttest(status) || status.integrity === null) {
      // Defensive: fail closed, not open, if the store changed between the
      // pre-middleware's check and payment clearing.
      return c.json({ error: 'internal error: reviewed package missing stored integrity' }, 500)
    }
    const hex = integrityToHex(status.integrity)
    if (hex === null) {
      // Unreachable given isPriceableSingleAttest() above; kept as a
      // fail-closed guard, never removed.
      return c.json({ error: 'internal error: stored integrity is not a valid sha512 value' }, 500)
    }

    const key = await options.getSigningKey()

    const statement = buildSinglePackageStatement({
      packageUrl: `pkg:npm/${name}@${version}`,
      sha512: hex,
      predicateType: SINGLE_PREDICATE_TYPE,
      predicate: {
        issuer: ISSUER,
        issuedAt: new Date().toISOString(),
        network: CAIP2_NETWORK,
        packages: [
          {
            name,
            version,
            integrity: status.integrity,
            tier: status.status,
            reviewer: reviewerIdentity(status),
            reviewScope: null,
            anchorTxid: status.anchor_txid,
            integrityMatch: true,
          },
        ],
        withheld: 0,
        absentMeans: 'UNREVIEWED',
      },
    })
    const payload = new TextEncoder().encode(JSON.stringify(statement))
    const attestation = await signEnvelope(payload, PAYLOAD_TYPE, key)

    const packages: AttributionEntry[] = [
      { pkg: name, version, auditor: reviewerIdentity(status), maintainer: null },
    ]
    c.set('attribution', {
      route: 'single-attest',
      priceMicro: SINGLE_ATTEST_PRICE_MICRO,
      packages,
    })

    return c.json({ tier: status.status, attestation })
  }

  return { lockfilePreMiddleware, lockfileHandler, singleAttestPreMiddleware, singleAttestHandler }
}
