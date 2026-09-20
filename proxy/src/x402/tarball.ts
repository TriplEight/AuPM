// proxy/src/x402/tarball.ts
//
// The tarball route's free tier is the core invariant: anything below
// COMMUNITY_REVIEWED stays free, forever, with no wallet required. A static
// x402 route config cannot express that, so this module supplies the
// onProtectedRequest hook that grants access before payment is considered.
import type {
  HTTPRequestContext,
  PaymentOption,
  ProtectedRequestHook,
  RouteConfig,
} from '@x402-avm/core/http'
import { CAIP2_NETWORK, MAX_TIMEOUT_SECONDS, PAY_TO, TAG, USDC_ASA_ID } from '../config.js'
import { getStatusOrUnreviewed, isFree } from '../status.js'

// Route key for the paid tarball route. `*` is a multi-segment wildcard, so
// this matches both unscoped (`/lodash/-/lodash-4.17.21.tgz`) and scoped
// (`/@scope/pkg/-/pkg-1.0.0.tgz`) tarball paths.
export const TARBALL_ROUTE_KEY = 'GET /*/-/*'

/**
 * The single definition of a tarball path's canonical form. Strips the
 * leading `/` and decodes `%40` and `%2f` case-insensitively to `@` and `/`.
 * Every function that classifies or parses a tarball path must call this —
 * never repeat its decoding rules.
 *
 * WARNING: Hono's `c.req.path` (proxy/src/app.ts) does not decode `%2F` on
 * its own. This normalisation is load-bearing at runtime, not defensive: a
 * caller who percent-encodes the `/-/` separator itself (e.g.
 * `%2F-%2F`) still reaches the x402 framework's own route matcher, which
 * matches `TARBALL_ROUTE_KEY` regardless of that encoding. If
 * `isTarballPath` and `parseTarballPath` do not agree with that matcher on
 * what counts as a tarball path, an unreviewed package falls through to the
 * payment gate and returns 402 — a paywall-bypass in the other direction,
 * violating "unreviewed never returns 402" (CLAUDE.md invariant 4).
 *
 * WARNING: decode before splitting on `/-/`, never after — splitting first
 * would miss a `%2F`-encoded separator, mis-resolve the package name, and
 * hand a reviewed, paid tarball out for free.
 */
export function normalizeTarballPath(urlPath: string): string {
  return urlPath.replace(/^\//, '').replace(/%40/gi, '@').replace(/%2f/gi, '/')
}

export function isTarballPath(path: string): boolean {
  const normalized = normalizeTarballPath(path)
  return normalized.includes('/-/') && normalized.endsWith('.tgz')
}

/** Integer micro-USDC charged for one reviewed tarball download (CLAUDE.md: $0.001). */
export const TARBALL_PRICE_MICRO = 1_000

/**
 * Parse npm's tarball path layout. Handles scoped package names explicitly
 * (`@scope/name`), since the `/` inside them breaks naive `:param` routing.
 *
 * Normalises every accepted encoding of the scope separator to npm's own
 * canonical, unescaped layout (`/@scope/name/-/name-1.0.0.tgz`) before
 * splitting on the `/-/` tarball-filename separator: a literal `@scope/name`,
 * `%40scope/name`, `@scope%2Fname`, and `%40scope%2Fname` all resolve to the
 * same stored row, and so does an encoded `/-/` separator itself. Decoding
 * is case-insensitive, so `%2f` matches `%2F`. See normalizeTarballPath.
 */
export function parseTarballPath(urlPath: string): { name: string; version: string } {
  const decoded = normalizeTarballPath(urlPath)
  const parts = decoded.split('/-/')
  const name = parts[0] ?? ''
  const filename = parts[1] ?? ''
  const match = filename.match(/^.+?-(\d+\.\d+\.\d+.*)\.tgz$/)
  const version = match?.[1] ?? 'unknown'
  return { name, version }
}

/**
 * onProtectedRequest hook: grant access without payment when the requested
 * tarball's version is below COMMUNITY_REVIEWED. Every other protected
 * route falls through to the normal payment flow (returns undefined).
 */
export const tarballFreeTierHook: ProtectedRequestHook = async (
  context: HTTPRequestContext,
  _routeConfig: RouteConfig,
) => {
  if (!isTarballPath(context.path)) return undefined
  const { name, version } = parseTarballPath(context.path)
  const row = getStatusOrUnreviewed(name, version)
  return isFree(row.status) ? { grantAccess: true } : undefined
}

export function tarballPaymentOption(feePayer: string): PaymentOption {
  return {
    scheme: 'exact',
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    price: '$0.001', // TARBALL_PRICE_MICRO (1,000 microUSDC), kept in sync by hand
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      asset: USDC_ASA_ID,
      feePayer,
      tag: TAG,
    },
  }
}
