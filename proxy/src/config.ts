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

export type SupportedKind = SupportedResponse['kinds'][number]

export const NETWORK = (process.env.NETWORK ?? 'mainnet').toLowerCase()

export const CAIP2_NETWORK: Network =
  NETWORK === 'testnet' ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2

export const USDC_ASA_ID: string = NETWORK === 'testnet' ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID

export const FACILITATOR_URL = process.env.FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz'

// payTo is fixed for the whole competition — the SplitRouter app address.
// It is the leaderboard key (CLAUDE.md invariant 1). Never change it in code.
export const PAY_TO = process.env.SPLIT_APP_ADDRESS ?? ''

// Attribution tag, written at settlement time, not retroactive (CLAUDE.md).
export const TAG = 'x402-global-challenge'

export const MAX_TIMEOUT_SECONDS = 60

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
