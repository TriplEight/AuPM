// proxy/src/claims/middleware.ts
//
// Claims ledger write path (SPEC.md 5.2). A Hono middleware registered
// *outside* the payment middleware — i.e. before it in app.use() order, so
// it wraps the payment middleware's next() call. After next() returns, it
// inspects the response for a successful PAYMENT-RESPONSE header, decodes
// the settle transaction id, and writes accruals from the attribution data
// the route handler put on the context with `c.set('attribution', …)`.
//
// No dependency on undocumented resource-server hooks — this reads only the
// standard PAYMENT-RESPONSE header the installed @x402-avm/hono middleware
// already sets on settlement (verified in proxy/src/x402/*).
//
// This module is exported, not mounted. A follow-up step wires it into
// proxy/src/app.ts, registered before paymentMiddlewareFromHTTPServer.

import { decodePaymentResponseHeader } from '@x402-avm/core/http'
import type { MiddlewareHandler } from 'hono'
import type { Attribution } from './attribution-rules.js'
import { writeAccruals } from './ledger.js'

export type ClaimsVariables = {
  attribution?: Attribution
}

type DecodedSettleResponse = {
  success: boolean
  transaction: string
}

function isDecodedSettleResponse(value: unknown): value is DecodedSettleResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as { success: unknown }).success === 'boolean' &&
    'transaction' in value &&
    typeof (value as { transaction: unknown }).transaction === 'string'
  )
}

export const claimsLedgerMiddleware: MiddlewareHandler<{ Variables: ClaimsVariables }> = async (
  c,
  next,
) => {
  await next()

  const header = c.res.headers.get('PAYMENT-RESPONSE') ?? c.res.headers.get('X-PAYMENT-RESPONSE')
  if (!header) return

  let decoded: unknown
  try {
    decoded = decodePaymentResponseHeader(header)
  } catch {
    return
  }
  if (!isDecodedSettleResponse(decoded) || !decoded.success || !decoded.transaction) return

  const attribution = c.get('attribution')
  if (!attribution) return

  // writeAccruals is idempotent and itself no-ops on priceMicro === 0
  // (CLAUDE.md: "never write an accrual when priceMicro is 0").
  writeAccruals(attribution, decoded.transaction)
}
