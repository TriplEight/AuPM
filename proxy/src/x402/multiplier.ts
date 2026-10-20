// proxy/src/x402/multiplier.ts
//
// The donor multiplier. A donor may pay more than the minimum price for each
// reviewed package. The multiplier is an integer count of tenths. Tenths 10
// is x1. All money math is integer math, never floating point.
import type { HTTPRequestContext } from '@x402-avm/core/http'

/** Integer micro-USDC owed for one reviewed package at the minimum multiplier (x0.1). */
export const PRICE_PER_REVIEWED_PACKAGE_MICRO = 1_000

/** Request header that carries the multiplier, in tenths. */
export const MULTIPLIER_HEADER = 'x-aupm-multiplier'

export const MIN_MULTIPLIER_TENTHS = 1
export const MAX_MULTIPLIER_TENTHS = 1000
/** The multiplier a client without the header pays: the minimum. */
export const DEFAULT_MULTIPLIER_TENTHS = MIN_MULTIPLIER_TENTHS
/** The multiplier that the public texts suggest: x1. */
export const SUGGESTED_MULTIPLIER_TENTHS = 10

export const MULTIPLIER_ERROR =
  `${MULTIPLIER_HEADER} must be a whole number of tenths from ${MIN_MULTIPLIER_TENTHS} to ` +
  `${MAX_MULTIPLIER_TENTHS} (x0.1 to x100), for example 10 for x1`

/** What a paid response reports about its price. All fields are integers. */
export interface PriceReceipt {
  baseMicro: number
  multiplierTenths: number
  totalMicro: number
}

const CANONICAL_INTEGER = /^[1-9][0-9]{0,3}$/

/**
 * Parses a raw header value. A missing header gives the default. Any value
 * that is not a canonical decimal integer in range gives null. There is no
 * fallback to another price.
 */
export function parseMultiplier(raw: string | null | undefined): number | null {
  if (raw === null || raw === undefined) return DEFAULT_MULTIPLIER_TENTHS
  if (!CANONICAL_INTEGER.test(raw)) return null
  const tenths = Number(raw)
  return tenths >= MIN_MULTIPLIER_TENTHS && tenths <= MAX_MULTIPLIER_TENTHS ? tenths : null
}

/** Integer micro-USDC owed for `reviewedCount` packages at `multiplierTenths`. */
export function totalPriceMicro(reviewedCount: number, multiplierTenths: number): number {
  return PRICE_PER_REVIEWED_PACKAGE_MICRO * multiplierTenths * reviewedCount
}

export function priceReceipt(reviewedCount: number, multiplierTenths: number): PriceReceipt {
  return {
    baseMicro: PRICE_PER_REVIEWED_PACKAGE_MICRO,
    multiplierTenths,
    totalMicro: totalPriceMicro(reviewedCount, multiplierTenths),
  }
}

/**
 * Reads the multiplier off the request the payment gate prices. The
 * pre-middlewares answer a bad value with 400 before the gate runs, so a bad
 * value here means the wiring drifted. This fails closed and never prices
 * the request at another amount.
 */
export function multiplierFromContext(context: HTTPRequestContext): number {
  const tenths = parseMultiplier(context.adapter.getHeader(MULTIPLIER_HEADER))
  if (tenths === null) {
    throw new Error('internal error: invalid multiplier reached the x402 gate')
  }
  return tenths
}
