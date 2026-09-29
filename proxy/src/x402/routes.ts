// proxy/src/x402/routes.ts
//
// Route configuration for all three paid routes: price, the `extra` block,
// the Bazaar discovery declaration, description, and mime type. Handler
// ownership is split — see proxy/src/app.ts for the mount points.
import type { DynamicPrice, PaymentOption, RouteConfig } from '@x402-avm/core/http'
import type { Price } from '@x402-avm/core/types'
import { declareDiscoveryExtension } from '@x402-avm/extensions'
import { formatMicroUsd } from 'aupm-mcp/money'
import { mvpSplit, targetSplitRow } from '../claims/attribution-rules.js'
import { CAIP2_NETWORK, MAX_TIMEOUT_SECONDS, PAY_TO, TAG, USDC_ASA_ID } from '../config.js'
import { lockfileDynamicPrice, PRICE_PER_REVIEWED_PACKAGE_MICRO } from '../routes/attest.js'
import { TARBALL_ROUTE_KEY, tarballPaymentOption } from './tarball.js'

export const LOCKFILE_ROUTE_KEY = 'POST /v1/attest/lockfile'
export const SINGLE_ATTEST_ROUTE_KEY = 'GET /v1/attest'

// Dollar text for the description strings below, derived from the one
// integer micro-unit price (never a second hand-typed "$0.001" to drift
// out of sync — CLAUDE.md invariant 7, docs/TASK.md P3). The `accepts`
// price field stays a literal dollar string: that one is x402 protocol
// data the facilitator parses, not display text.
const PRICE_TEXT = formatMicroUsd(PRICE_PER_REVIEWED_PACKAGE_MICRO)

// SPEC §6.2 disclosure rule: every public text (README, `og:description`,
// Bazaar descriptions) shows both the target split and the MVP split — one
// split on every network (ADR 0011, docs/TASK.md P8d), never a literal, so
// the disclosed split can never drift from the one the ledger actually uses.
// Never claim the maintainer's target share is paid out today: in the MVP
// it is unclaimed ops income until that role onboards (CLAUDE.md invariant 8).
const { auditorPercent: MVP_AUDITOR_PERCENT, opsPercent: MVP_OPS_PERCENT } = mvpSplit()
const SPLIT_DISCLOSURE =
  `Target split ${targetSplitRow()}. In the MVP: ${MVP_AUDITOR_PERCENT}% to the auditor, ` +
  `${MVP_OPS_PERCENT}% to the operator until the other roles launch.`

// The canonical text for the `og:description` meta tag on the front page
// at `GET /` (SPEC §6.2, §11.2, proxy/src/front-page.ts). The app serves it
// for the Bazaar merchant card. This constant is the one place
// that text is authored, so the disclosure rule and the price stay in sync
// with the Bazaar route descriptions below.
export const OG_DESCRIPTION =
  'AuPM turns human code review into a paid, verifiable, on-chain-anchored ' +
  `public good on Algorand. ${PRICE_TEXT} per reviewed package. ${SPLIT_DISCLOSURE}`

export type AupmRouteKey =
  | typeof LOCKFILE_ROUTE_KEY
  | typeof SINGLE_ATTEST_ROUTE_KEY
  | typeof TARBALL_ROUTE_KEY

function accepts(price: Price | DynamicPrice, feePayer: string): PaymentOption {
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
export function buildRoutes(feePayer: string): Record<AupmRouteKey, RouteConfig> {
  return {
    [LOCKFILE_ROUTE_KEY]: {
      accepts: accepts(lockfileDynamicPrice, feePayer),
      description:
        'Signed in-toto attestation for every package in a package-lock.json: human ' +
        'review tier, reviewer, tarball integrity match, and the Algorand txid anchoring ' +
        `each review. ${PRICE_TEXT} per reviewed package; free when no package in the tree ` +
        `is reviewed. ${SPLIT_DISCLOSURE}`,
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
            // Buckets mirror LockfileSummary (proxy/src/attest/lockfile.ts):
            // reviewed + unreviewed + unresolvable + integrityMismatch must
            // sum to total. 14 + 497 + 1 + 0 = 512.
            example: {
              summary: {
                total: 512,
                reviewed: 14,
                unreviewed: 497,
                unresolvable: 1,
                integrityMismatch: 0,
              },
              attestation: { payloadType: 'application/vnd.in-toto+json' },
            },
          },
        }),
      },
    },
    [SINGLE_ATTEST_ROUTE_KEY]: {
      accepts: accepts('$0.001', feePayer),
      description:
        'Signed human-review attestation for one npm package version (query: name, ' +
        `version). ${PRICE_TEXT} per reviewed package; free when unreviewed. ${SPLIT_DISCLOSURE}`,
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
      description:
        'npm tarball download, gated for human-reviewed versions only. ' +
        `${PRICE_TEXT} per reviewed package; free when unreviewed. ${SPLIT_DISCLOSURE}`,
      mimeType: 'application/octet-stream',
      extensions: {
        ...declareDiscoveryExtension({
          output: { example: { note: 'binary tarball body' } },
        }),
      },
    },
  }
}
