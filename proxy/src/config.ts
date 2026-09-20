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
import type { Network, SupportedResponse } from '@x402-avm/core/types'
import algosdk from 'algosdk'
import { loadSigningKey, type SigningKey } from './attest/keys.js'

export type SupportedKind = SupportedResponse['kinds'][number]

export const NETWORK = (process.env.NETWORK ?? 'mainnet').toLowerCase()

export const CAIP2_NETWORK: Network =
  NETWORK === 'testnet' ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2

export const USDC_ASA_ID: string = NETWORK === 'testnet' ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID

export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz'

// payTo is fixed for the whole competition — the SplitRouter app address.
// It is the leaderboard key (CLAUDE.md invariant 1). Never change it in code.
export const PAY_TO = process.env.SPLIT_APP_ADDRESS ?? ''

/**
 * Boot guard (pure function, no I/O). Follows the shape of resolveFeePayer
 * below: it throws instead of returning a boolean, so a single call inside
 * proxy/src/index.ts's existing try/catch is enough to stop boot and exit
 * non-zero. It never runs at module-import time — SPLIT_APP_ADDRESS is
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
        'set SPLIT_APP_ADDRESS to the SplitRouter app address',
    )
  }
}

// Attribution tag, written at settlement time, not retroactive (CLAUDE.md).
export const TAG = 'x402-global-challenge'

export const MAX_TIMEOUT_SECONDS = 60

// Read-only GitHub token for claim-proof verification
// (POST /api/v1/claims/verify). It reads only public repo files and public
// gists to check a claimant's published proof. WARNING: never log this
// value (CLAUDE.md). Empty when unset; proxy/src/claims/github.ts fails
// each call cleanly in that case, instead of the server crashing.
export const GITHUB_READONLY_TOKEN = process.env.GITHUB_READONLY_TOKEN ?? ''

/**
 * Boot guard (pure function, no I/O).
 *
 * Resolve the fee payer for `network` from a facilitator supported-kinds
 * response. Find the kind whose network matches and whose scheme is
 * "exact"; read `extra.feePayer` off it.
 *
 * CAUTION: pass in a supported-kinds response object only — this function
 * must never perform a network call itself. Callers do the fetch (via
 * HTTPFacilitatorClient.getSupported()) and hand the result in here so
 * boot-guard logic stays unit-testable without touching the network.
 *
 * WARNING: throws when the facilitator does not advertise the configured
 * network's "exact" scheme with a feePayer. The server must not accept
 * paid-route traffic without a valid fee payer.
 */
export function resolveFeePayer(
  supported: SupportedResponse,
  network: string = CAIP2_NETWORK,
): string {
  const kind = supported.kinds.find((k) => k.network === network && k.scheme === 'exact')
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
// the predicate-type URLs below. Defaults to a placeholder so local dev and
// the test suite never need it set; production sets SPM_ISSUER_URL to the
// real HTTPS domain before the first MainNet attestation.
export const ISSUER = process.env.SPM_ISSUER_URL ?? 'https://spm.dev'

export const LOCKFILE_PREDICATE_TYPE = `${ISSUER}/attestation/lockfile/v1`
export const SINGLE_PREDICATE_TYPE = `${ISSUER}/attestation/single/v1`

// `validFrom` published on the configured attestation signing key's entry
// at GET /.well-known/spm-keys.json (SPEC-v3.md 6.2). SPM_KEY_VALID_FROM
// lets ops record the real provisioning date; the default is a placeholder,
// same pattern as ISSUER above.
export const ATTEST_SIGNING_KEY_VALID_FROM =
  process.env.SPM_KEY_VALID_FROM ?? '2026-01-01T00:00:00Z'

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
