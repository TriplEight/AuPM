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

export function isTarballPath(path: string): boolean {
  return path.includes('/-/') && path.endsWith('.tgz')
}

/**
 * Parse npm's tarball path layout. Handles scoped package names explicitly
 * (`@scope/name`), since the `/` inside them breaks naive `:param` routing.
 */
export function parseTarballPath(urlPath: string): { name: string; version: string } {
  const parts = urlPath.replace(/^\//, '').split('/-/')
  const name = (parts[0] ?? '').replace(/%40/g, '@')
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
    price: '$0.001',
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      asset: USDC_ASA_ID,
      feePayer,
      tag: TAG,
    },
  }
}
