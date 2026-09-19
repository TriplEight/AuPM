// proxy/src/x402/routes.ts
//
// Route configuration for all three paid routes: price, the `extra` block,
// the Bazaar discovery declaration, description, and mime type. Handler
// ownership is split — see proxy/src/app.ts for the mount points.
import type { PaymentOption, RouteConfig } from '@x402-avm/core/http'
import { declareDiscoveryExtension } from '@x402-avm/extensions'
import { CAIP2_NETWORK, MAX_TIMEOUT_SECONDS, PAY_TO, TAG, USDC_ASA_ID } from '../config.js'
import { TARBALL_ROUTE_KEY, tarballPaymentOption } from './tarball.js'

export const LOCKFILE_ROUTE_KEY = 'POST /v1/attest/lockfile'
export const SINGLE_ATTEST_ROUTE_KEY = 'GET /v1/attest'

export type SpmRouteKey =
  | typeof LOCKFILE_ROUTE_KEY
  | typeof SINGLE_ATTEST_ROUTE_KEY
  | typeof TARBALL_ROUTE_KEY

function accepts(price: string, feePayer: string): PaymentOption {
  return {
    scheme: 'exact',
    network: CAIP2_NETWORK,
    payTo: PAY_TO,
    price,
    maxTimeoutSeconds: MAX_TIMEOUT_SECONDS,
    extra: {
      asset: USDC_ASA_ID,
      feePayer,
      tag: TAG,
    },
  }
}

/**
 * Build the RoutesConfig for the three paid routes. `feePayer` must come
 * from the boot guard (proxy/src/config.ts#resolveFeePayer) — never
 * hardcoded.
 */
export function buildRoutes(feePayer: string): Record<SpmRouteKey, RouteConfig> {
  return {
    [LOCKFILE_ROUTE_KEY]: {
      accepts: accepts('$0.02', feePayer),
      description:
        'Signed in-toto attestation for every package in a package-lock.json: human ' +
        'review tier, reviewer, tarball integrity match, and the Algorand txid anchoring ' +
        'each review. Free when no package in the tree is reviewed.',
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          bodyType: 'json',
          input: {
            lockfileVersion: 3,
            packages: { 'node_modules/ms': { version: '2.1.3' } },
          },
          inputSchema: {
            properties: { lockfileVersion: { type: 'integer' }, packages: { type: 'object' } },
            required: ['lockfileVersion', 'packages'],
          },
          output: {
            example: {
              summary: { total: 512, reviewed: 14, unreviewed: 497, integrityMismatch: 0 },
              attestation: { payloadType: 'application/vnd.in-toto+json' },
            },
          },
        }),
      },
    },
    [SINGLE_ATTEST_ROUTE_KEY]: {
      accepts: accepts('$0.001', feePayer),
      description:
        'Signed human-review attestation for one npm package version (query: name, version).',
      mimeType: 'application/json',
      extensions: {
        ...declareDiscoveryExtension({
          input: { name: 'ms', version: '2.1.3' },
          inputSchema: {
            properties: { name: { type: 'string' }, version: { type: 'string' } },
            required: ['name', 'version'],
          },
          output: { example: { tier: 'COMMUNITY_REVIEWED' } },
        }),
      },
    },
    [TARBALL_ROUTE_KEY]: {
      accepts: tarballPaymentOption(feePayer),
      description: 'npm tarball download, gated for human-reviewed versions only.',
      mimeType: 'application/octet-stream',
      extensions: {
        ...declareDiscoveryExtension({
          output: { example: { note: 'binary tarball body' } },
        }),
      },
    },
  }
}
