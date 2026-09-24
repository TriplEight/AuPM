// proxy/src/config.ts
//
// MainNet is the target; TestNet is pre-flight rehearsal only (CLAUDE.md).
// NETWORK selects which CAIP-2 network id and USDC ASA id this proxy uses.
// Defaults to mainnet so an unset NETWORK never silently rehearses forever.
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from '@x402-avm/avm'
import { x402Version as X402_PROTOCOL_VERSION } from '@x402-avm/core'
import type { Network, SupportedResponse } from '@x402-avm/core/types'
import algosdk from 'algosdk'
import { loadSigningKey, type SigningKey } from './attest/keys.js'

export type SupportedKind = SupportedResponse['kinds'][number]

export const NETWORK = (process.env.NETWORK ?? 'mainnet').toLowerCase()

export const CAIP2_NETWORK: Network =
  NETWORK === 'testnet' ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2

export const USDC_ASA_ID: string = NETWORK === 'testnet' ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID

export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz'

// payTo is fixed for the whole competition — the rekeyed PaymentRouter payTo
// account, not the application address (SPEC.md). It is the leaderboard key
// (CLAUDE.md invariant 1). Never change it in code.
export const PAY_TO = process.env.PAY_TO_ADDRESS ?? ''

/**
 * Boot guard (pure function, no I/O). Follows the shape of resolveFeePayer
 * below: it throws instead of returning a boolean, so a single call inside
 * proxy/src/index.ts's existing try/catch is enough to stop boot and exit
 * non-zero. It never runs at module-import time — PAY_TO_ADDRESS is
 * unset or intentionally fake in most of the test suite (stubbed
 * facilitator clients never reach the network), so eager validation here
 * would break every one of those imports. Call it once, explicitly, from
 * main() in proxy/src/index.ts.
 *
 * Validates shape, not merely non-emptiness: payTo must decode as a valid
 * Algorand address (58-char base32, checksum included), via algosdk's own
 * `isValidAddress`. WARNING: payTo is the leaderboard key. A server that
 * advertises an empty or malformed one lets a caller build a payment that
 * can never settle.
 */
export function assertValidPayTo(payTo: string = PAY_TO): void {
  if (!payTo || !algosdk.isValidAddress(payTo)) {
    throw new Error(
      `x402 boot guard: PAY_TO is not a valid Algorand address (got ${JSON.stringify(payTo)}); ` +
        'set PAY_TO_ADDRESS to the rekeyed PaymentRouter payTo account',
    )
  }
}

// Attribution tag, written at settlement time, not retroactive (CLAUDE.md).
export const TAG = 'x402-global-challenge'

export const MAX_TIMEOUT_SECONDS = 60

/**
 * Boot guard (pure function, no I/O).
 *
 * Resolve the fee payer for `network` from a facilitator supported-kinds
 * response. Find the kind whose network matches, whose scheme is "exact",
 * and whose x402Version matches the installed middleware's protocol
 * version (X402_PROTOCOL_VERSION, re-exported as `x402Version` from
 * `@x402-avm/core`); read `extra.feePayer` off it.
 *
 * CAUTION: pass in a supported-kinds response object only — this function
 * must never perform a network call itself. Callers do the fetch (via
 * HTTPFacilitatorClient.getSupported()) and hand the result in here so
 * boot-guard logic stays unit-testable without touching the network.
 *
 * WARNING: throws when the facilitator does not advertise the configured
 * network's "exact" scheme with a feePayer. The server must not accept
 * paid-route traffic without a valid fee payer.
 *
 * WARNING: throws a distinct, named error when a kind matches network and
 * scheme but declares a different or missing x402Version. Without this
 * check the middleware's own route validation fails first, and the
 * operator reads a middleware error instead of this boot guard's message.
 */
export function resolveFeePayer(
  supported: SupportedResponse,
  network: string = CAIP2_NETWORK,
): string {
  const exactKinds = supported.kinds.filter((k) => k.network === network && k.scheme === 'exact')
  const kind = exactKinds.find((k) => k.x402Version === X402_PROTOCOL_VERSION)
  const versionMismatch = kind
    ? undefined
    : exactKinds.find((k) => k.x402Version !== X402_PROTOCOL_VERSION)
  if (versionMismatch) {
    throw new Error(
      `x402 boot guard: facilitator's "exact" kind on network "${network}" declares ` +
        `x402Version ${JSON.stringify(versionMismatch.x402Version)}; this proxy requires ` +
        `x402Version ${X402_PROTOCOL_VERSION}`,
    )
  }
  const feePayer = kind?.extra?.feePayer
  if (typeof feePayer !== 'string' || feePayer.length === 0) {
    throw new Error(
      `x402 boot guard: facilitator does not support scheme "exact" on network "${network}" with a feePayer`,
    )
  }
  return feePayer
}

// ---------------------------------------------------------------------------
// Attestation configuration: issuer, predicate types, signing key.
// ---------------------------------------------------------------------------

// ISSUER is `predicate.issuer` on every signed statement, and the base of
// the predicate-type URLs below (SPEC.md 12.3). Every signed statement
// carries it, so a wrong value can never be corrected after the fact — there
// is no safe placeholder domain, and the team does not own one. Defaults
// to '' so importing this module never throws (same lazy pattern as PAY_TO
// above); assertValidIssuerUrl() is the boot guard. It runs on every
// network — TestNet rehearsal proves the same public config MainNet will
// carry, so it never masks a broken value before the MainNet launch. Call it
// once, explicitly, from main() in proxy/src/index.ts.
export const ISSUER = process.env.SPM_ISSUER_URL ?? ''

export const LOCKFILE_PREDICATE_TYPE = `${ISSUER}/attestation/lockfile/v1`
export const SINGLE_PREDICATE_TYPE = `${ISSUER}/attestation/single/v1`

/**
 * Boot guard (pure function, no I/O). Follows the shape of assertValidPayTo
 * above.
 *
 * Accepts only a bare HTTPS origin: scheme "https:", no trailing slash, no
 * path, no query string, no fragment (for example "https://spm-example.org").
 * Comparing the raw input against the parsed URL's own `origin` catches all
 * four shape problems (trailing slash, path, query, fragment) in one check.
 */
export function assertValidIssuerUrl(issuer: string = ISSUER): void {
  const problem = describeIssuerUrlProblem(issuer)
  if (problem) {
    throw new Error(
      `x402 boot guard: SPM_ISSUER_URL ${problem}; ` +
        'set it to a bare https origin the team controls, e.g. https://spm-example.org',
    )
  }
}

function describeIssuerUrlProblem(value: string): string | undefined {
  if (!value) {
    return 'is not set'
  }
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return `is not a valid absolute URL (got ${JSON.stringify(value)})`
  }
  if (url.protocol !== 'https:') {
    return `must use "https:" (got ${JSON.stringify(value)})`
  }
  if (value !== url.origin) {
    return (
      'must be a bare origin, with no trailing slash, path, query, or fragment ' +
      `(got ${JSON.stringify(value)})`
    )
  }
  return undefined
}

// `validFrom` published on the configured attestation signing key's entry at
// GET /.well-known/spm-keys.json (SPEC.md 12.2). Defaults to '' so importing
// this module never throws (same lazy pattern as ISSUER above);
// assertValidKeyValidFrom() is the boot guard, called from main() alongside
// assertValidIssuerUrl(). Runs on every network, for the same reason.
export const ATTEST_SIGNING_KEY_VALID_FROM = process.env.SPM_KEY_VALID_FROM ?? ''

const ISO_8601_UTC_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$/

/**
 * Boot guard (pure function, no I/O). Follows the shape of
 * assertValidIssuerUrl above.
 */
export function assertValidKeyValidFrom(value: string = ATTEST_SIGNING_KEY_VALID_FROM): void {
  const problem = describeKeyValidFromProblem(value)
  if (problem) {
    throw new Error(
      `x402 boot guard: SPM_KEY_VALID_FROM ${problem}; ` +
        'set it to an ISO-8601 UTC timestamp, e.g. 2026-01-01T00:00:00Z',
    )
  }
}

function describeKeyValidFromProblem(value: string): string | undefined {
  if (!value) {
    return 'is not set'
  }
  if (!ISO_8601_UTC_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    return `is not a valid ISO-8601 UTC timestamp (got ${JSON.stringify(value)})`
  }
  return undefined
}

// The SPM attestation signing key (DSSE, ed25519). Hot on the server by
// necessity; never funded, never used on-chain, and separate from
// payTo/admin/pool keys (CLAUDE.md). ATTEST_SIGNING_KEY is either a 25-word
// Algorand mnemonic or a hex-encoded 32-byte seed. Loaded once and memoized
// — callers use getAttestationSigningKey(), never process.env directly, so
// the loading logic lives in exactly one place.
//
// CAUTION: this is lazy on purpose. Evaluating it at module-import time
// would make every module that imports proxy/src/config.ts (including the
// existing test suite, which never sets ATTEST_SIGNING_KEY) throw just by
// importing it.
let signingKeyPromise: Promise<SigningKey> | null = null

export function getAttestationSigningKey(): Promise<SigningKey> {
  if (!signingKeyPromise) {
    const source = process.env.ATTEST_SIGNING_KEY
    if (!source) {
      throw new Error('ATTEST_SIGNING_KEY is not set: cannot sign attestations')
    }
    const mnemonicOrSeed = /^[0-9a-fA-F]{64}$/.test(source)
      ? Uint8Array.from(Buffer.from(source, 'hex'))
      : source
    signingKeyPromise = loadSigningKey(mnemonicOrSeed)
  }
  return signingKeyPromise
}
