// proxy/src/routes/contract.ts
//
// GET /api/v1/contract: free, unauthenticated, never gated. Publishes the
// public coordinates the auditor CLI needs. Public values
// only: never a key, a mnemonic, or the crediter address.

import { Hono } from 'hono'
import { CAIP2_NETWORK, PAY_TO, USDC_ASA_ID } from '../config.js'

const POSITIVE_INTEGER = /^[1-9]\d*$/

const router = new Hono()

router.get('/', (c) => {
  const rawAppId = process.env.PAYMENT_ROUTER_APP_ID ?? ''
  const appId = Number(rawAppId)
  if (!POSITIVE_INTEGER.test(rawAppId) || !Number.isSafeInteger(appId)) {
    return c.json(
      {
        error:
          'PAYMENT_ROUTER_APP_ID is unset or not a positive integer; ' +
          'set it to the PaymentRouter application id',
      },
      503,
    )
  }
  if (!PAY_TO) {
    return c.json({ error: 'PAY_TO_ADDRESS is unset; set it to the payTo account' }, 503)
  }
  return c.json({
    network: CAIP2_NETWORK,
    appId,
    payTo: PAY_TO,
    usdcAssetId: Number(USDC_ASA_ID),
  })
})

export default router
