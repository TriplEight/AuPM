#!/usr/bin/env node

// SPM operator preflight — confirms a live proxy's 402 response is safe to
// donate against, before anyone runs `--donate` (CLAUDE.md invariants 3
// and 6; SPEC.md §11.3; docs/HANDOFF-next-session.md step 3). Read-only:
// this script never signs or sends a transaction, so it needs no
// --confirm-mainnet gate (scripts/network.mjs).
//
// Usage: node scripts/check-402.mjs <url> [--network testnet|mainnet]
// Example: node scripts/check-402.mjs "https://<domain>/v1/attest?name=ms&version=2.1.3"
// NETWORK defaults to mainnet, same as proxy/src/config.ts.
//
// The 402 body is always `{}`. Requirements travel only in the
// PAYMENT-REQUIRED response header (base64-encoded). This script decodes
// that header and checks accepts[0] against the values a proxy on the
// selected network must advertise: the attribution tag, the network's
// explicit USDC asset, the network's CAIP-2 id, and the feePayer the
// facilitator itself advertises for that network.
//
// Exit 0: every field PASSed. Exit 1: a field FAILed, or a network error
// stopped the check from running. Exit 2: no url argument.

import { createRequire } from 'node:module'
import { caip2NetworkId, parseNetworkFlag, usdcAssetId } from './network.mjs'

// Anchors a CJS `require()` at the proxy workspace's own node_modules —
// scripts/ has no node_modules of its own (mirrors scripts/e2e.mjs:16-23).
const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))

const FACILITATOR_URL = 'https://facilitator.goplausible.xyz'

/**
 * Reads the feePayer the facilitator advertises for one network's "exact"
 * scheme (proxy/src/config.ts#resolveFeePayer extraction shape: filter by
 * network and scheme, then read extra.feePayer). Never hardcoded.
 *
 * @param {{kinds: Array<{network: string, scheme: string, extra?: {feePayer?: string}}>}} supported
 * @param {string} network - CAIP-2 network id to filter on.
 * @returns {string} the advertised feePayer.
 */
export function resolveExpectedFeePayer(supported, network) {
  const kind = supported?.kinds?.find((k) => k.network === network && k.scheme === 'exact')
  const feePayer = kind?.extra?.feePayer
  if (typeof feePayer !== 'string' || feePayer.length === 0) {
    throw new Error(
      `facilitator does not advertise a feePayer for network "${network}" scheme "exact"`,
    )
  }
  return feePayer
}

function field(name, actual, expected) {
  return { field: name, ok: actual === expected, actual, expected }
}

/**
 * Checks a decoded PAYMENT-REQUIRED header's accepts[0] against the
 * invariants a proxy on `network` must hold before anyone donates. Pure:
 * no I/O. Missing accepts[0] fails every field rather than throwing, so
 * the CLI can still print one PASS/FAIL line per field.
 *
 * @param {{accepts?: Array<object>}} decoded - decodePaymentRequiredHeader(...) result.
 * @param {string} expectedFeePayer - feePayer the facilitator advertises.
 * @param {'testnet'|'mainnet'} [network] - defaults to mainnet.
 * @returns {Array<{field: string, ok: boolean, actual: unknown, expected: unknown}>}
 */
export function checkRequirements(decoded, expectedFeePayer, network = 'mainnet') {
  const expectedAsset = usdcAssetId(network)
  const expectedNetwork = caip2NetworkId(network)
  const accept = decoded?.accepts?.[0]
  const extra = accept?.extra ?? {}
  const rawAsset = extra.asset
  const assetActual = rawAsset === undefined || rawAsset === null ? undefined : String(rawAsset)

  return [
    field('extra.tag', extra.tag, 'x402-global-challenge'),
    field('extra.asset', assetActual, expectedAsset),
    field('network', accept?.network, expectedNetwork),
    field('extra.feePayer', extra.feePayer, expectedFeePayer),
  ]
}

function fmt(value) {
  return value === undefined ? '<missing>' : JSON.stringify(value)
}

function printUsage() {
  console.error('Usage: node scripts/check-402.mjs <url> [--network testnet|mainnet]')
  console.error(
    'Example: node scripts/check-402.mjs "https://<domain>/v1/attest?name=ms&version=2.1.3"',
  )
}

async function fetchPaymentRequiredHeader(url) {
  let res
  try {
    res = await fetch(url)
  } catch (e) {
    throw new Error(`request to ${url} failed: ${e.message}`)
  }
  if (res.status !== 402) {
    throw new Error(`expected HTTP 402 from ${url}, got ${res.status}`)
  }
  const headerB64 = res.headers.get('PAYMENT-REQUIRED')
  if (!headerB64) {
    throw new Error(`${url} returned 402 with no PAYMENT-REQUIRED response header`)
  }
  return headerB64
}

async function resolveFeePayerFromFacilitator(caip2Network) {
  const { HTTPFacilitatorClient } = requireFromProxy('@x402-avm/core/server')
  const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
  const supported = await facilitator.getSupported()
  return resolveExpectedFeePayer(supported, caip2Network)
}

async function main() {
  const argv = process.argv.slice(2)
  const url = argv[0]
  if (!url || url.startsWith('--')) {
    printUsage()
    process.exit(2)
  }

  let network
  try {
    network = parseNetworkFlag(argv)
  } catch (e) {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
    return
  }

  const { decodePaymentRequiredHeader } = requireFromProxy('@x402-avm/core/http')

  let headerB64
  let expectedFeePayer
  try {
    headerB64 = await fetchPaymentRequiredHeader(url)
    expectedFeePayer = await resolveFeePayerFromFacilitator(caip2NetworkId(network))
  } catch (e) {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
  }

  const decoded = decodePaymentRequiredHeader(headerB64)
  const results = checkRequirements(decoded, expectedFeePayer, network)

  let allOk = true
  for (const { field: name, ok, actual, expected } of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}: actual=${fmt(actual)} expected=${fmt(expected)}`)
    if (!ok) allOk = false
  }
  process.exit(allOk ? 0 : 1)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
