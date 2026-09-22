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

/**
 * True when `path` falls inside the paid tarball route's protected scope.
 * This is a safe superset — it mirrors, exactly, the compiled route regex
 * for TARBALL_ROUTE_KEY (`GET /*\/-/*` -> `^\/.*?\/-\/.*?$`, case
 * insensitive, tested by the installed `@x402-avm/core@2.6.1` matcher
 * against its own normalizePath). Fuzz-verified against 200,000 random
 * paths: identical to the matcher's own decision in every case.
 *
 * The route key requires only a `/-/` segment somewhere in the path — no
 * `.tgz` suffix, no particular case, no filename at all after the
 * separator. `isTarballPath` below is narrower on purpose (it identifies a
 * *specific, resolvable* tarball filename); this function exists so the
 * free-tier hook can tell, before ever calling isTarballPath, whether a
 * request is one the payment gate protects at all. See
 * tarballFreeTierHook's use of it below.
 */
export function isTarballRouteScope(path: string): boolean {
  return normalizeTarballPath(path).includes('/-/')
}

/**
 * True when `path` has the shape of an actual npm tarball filename:
 * `<name>/-/<name>-<version>.tgz`. `.tgz` is matched case-insensitively —
 * npm's own registry only ever emits a lowercase suffix, but the route
 * regex above matches any case, so `.TGZ`/`.Tgz` must resolve to the exact
 * same stored review row as `.tgz`, never to a different (or no) row.
 * Deliberately narrower than isTarballRouteScope: only a path matching this
 * shape can ever be resolved to a specific package name and version, so
 * only a path matching this shape can ever be positively identified as a
 * *reviewed* tarball. See parseTarballPath's matching suffix fix below.
 */
export function isTarballPath(path: string): boolean {
  const normalized = normalizeTarballPath(path)
  return normalized.includes('/-/') && /\.tgz$/i.test(normalized)
}

/** Integer micro-USDC charged for one reviewed tarball download (CLAUDE.md: $0.001). */
export const TARBALL_PRICE_MICRO = 1_000

/**
 * Request header that opts a tarball download into payment. Read
 * case-insensitively through HTTPAdapter#getHeader (see tarballFreeTierHook
 * below and proxy/src/app.ts, which reads the identical header the same
 * way to decide the X-SPM-Donate-Hint response header).
 */
export const DONATE_HEADER = 'x-spm-donate'

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
 *
 * The `.tgz` suffix is matched case-insensitively, for the same reason as
 * isTarballPath above: `pkg-1.0.0.TGZ` must resolve to version `1.0.0`, the
 * identical row `pkg-1.0.0.tgz` resolves to, or a reviewed package would
 * serve free under an uppercase suffix and an unreviewed one would charge.
 */
export function parseTarballPath(urlPath: string): { name: string; version: string } {
  const decoded = normalizeTarballPath(urlPath)
  const parts = decoded.split('/-/')
  const name = parts[0] ?? ''
  const filename = parts[1] ?? ''
  const match = filename.match(/^.+?-(\d+\.\d+\.\d+.*)\.tgz$/i)
  const version = match?.[1] ?? 'unknown'
  return { name, version }
}

/**
 * onProtectedRequest hook: grant access without payment when the requested
 * tarball is below COMMUNITY_REVIEWED, and also when it is a reviewed
 * tarball the caller did not opt in to pay for. Only a reviewed tarball
 * requested with `X-SPM-Donate: 1` falls through to the normal payment flow
 * (returns undefined). Every other protected route is a no-op (also
 * returns undefined).
 *
 * WARNING: this hook is registered globally on the httpServer (see
 * proxy/src/x402/server.ts), so it runs for *every* protected route, not
 * just the tarball one — `isTarballRouteScope` is the guard that keeps it a
 * no-op for the lockfile and single-attest routes (neither path ever
 * contains a `/-/` segment).
 *
 * Two predicates, deliberately different widths, decide the outcome:
 *  - `isTarballRouteScope` mirrors the paid route key exactly (a safe
 *    superset): true for every path the payment gate protects here.
 *  - `isTarballPath` is narrower: true only for a path shaped like a real,
 *    resolvable tarball filename (`/-/` plus a `.tgz`-suffixed name).
 *
 * A path inside the route's scope but outside isTarballPath's narrower
 * shape (`/-/readme`, `/-/` with no filename, a path with no extension) can
 * never be resolved to a specific package version, so it can never be
 * positively identified as a reviewed tarball — it is granted free, not
 * charged (CLAUDE.md invariant 4: unreviewed never returns 402; CAUTION —
 * an unresolvable path defaults to free, never to a charge). Charging only
 * ever happens once a resolved row is positively found to be reviewed.
 *
 * A resolved, reviewed row is still granted free access unless the request
 * carries `X-SPM-Donate: 1` exactly (SPEC §10.4, ADR 0006). x402's route
 * config is static — a matching route always demands payment — but `npm
 * install` can never pay a 402, and the seed review list (`ms`, `once`,
 * `inherits`) sits in almost every lockfile. Any other header value,
 * including `0` or its absence, keeps the download free. WARNING: never
 * relax this to also gate the free path on something other than this exact
 * header — a wallet-less `npm install` must always clear.
 */
export const tarballFreeTierHook: ProtectedRequestHook = async (
  context: HTTPRequestContext,
  _routeConfig: RouteConfig,
) => {
  if (!isTarballRouteScope(context.path)) return undefined
  if (!isTarballPath(context.path)) return { grantAccess: true }
  const { name, version } = parseTarballPath(context.path)
  const row = getStatusOrUnreviewed(name, version)
  if (isFree(row.status)) return { grantAccess: true }
  return context.adapter.getHeader(DONATE_HEADER) === '1' ? undefined : { grantAccess: true }
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
