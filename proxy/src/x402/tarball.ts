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
 * The single definition of a tarball path's canonical form. Every function
 * that classifies or parses a tarball path must call this — never repeat
 * its rules with a fresh `replace` call.
 *
 * This mirrors, step for step, the private `normalizePath` in the installed
 * `@x402-avm/core@2.6.1` route matcher (dist/esm/chunk-L5XMR4QC.mjs):
 * decode the whole path with `decodeURIComponent` (falling back to the raw
 * path if decoding throws), then collapse duplicate slashes, then strip a
 * trailing slash. The order is load-bearing: decoding first means a `%2F`
 * that decodes to `/` still takes part in slash-collapsing and
 * trailing-slash stripping, exactly as the matcher does. We additionally
 * strip a single leading `/`, since this module's callers (unlike the
 * matcher) work with the path name only.
 *
 * WARNING: Hono's `c.req.path` (proxy/src/app.ts) does not decode `%2F`,
 * collapse `//`, or strip a trailing `/` on its own. The x402 framework's
 * own route matcher normalises the raw path before testing it against
 * `TARBALL_ROUTE_KEY`. If `isTarballPath` and `parseTarballPath` do not
 * apply the identical normalisation, they disagree with the matcher on what
 * counts as a tarball path — in one direction that serves a reviewed
 * tarball for free, in the other it charges an unreviewed one, violating
 * "unreviewed never returns 402" (CLAUDE.md invariant 4).
 *
 * CAUTION: decode before collapsing slashes, never after — collapsing
 * first would miss slash-runs created by decoding (e.g. a `%2F` landing
 * next to a literal `/`), and decoding first can only ever reduce adjacent
 * slash runs to fewer slashes. It cannot introduce the literal characters
 * `/-/`, so collapsing can never merge a scope separator into the tarball
 * filename separator.
 */
export function normalizeTarballPath(urlPath: string): string {
  const pathWithoutQuery = urlPath.split(/[?#]/)[0] ?? ''
  let decoded: string
  try {
    decoded = decodeURIComponent(pathWithoutQuery)
  } catch {
    decoded = pathWithoutQuery
  }
  const canonical = decoded
    .replace(/\\/g, '/')
    .replace(/\/+/g, '/')
    .replace(/(.+?)\/+$/, '$1')
  return canonical.replace(/^\//, '')
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
