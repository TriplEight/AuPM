// proxy/src/claims/middleware.test.ts
//
// CAUTION: no network calls here. `encodePaymentResponseHeader` builds the
// exact header shape the installed @x402-avm/hono middleware produces on a
// real settlement (verified in proxy/src/x402/*.test.ts) — this test drives
// that shape directly instead of exercising the real facilitator.
//
// This file gets its own SQLite file via SQLITE_PATH, set before the
// dynamic import below (same trick as proxy/src/app.test.ts and this
// directory's ledger.test.ts) — the claims tables are shared across several
// test files here, so per-file isolation stops vitest's parallel test files
// from racing on the same physical database.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { encodePaymentResponseHeader } from '@x402-avm/core/http'
import { Hono } from 'hono'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-claims-middleware-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { getAccrualsForTxid } = await import('./ledger.js')
const { claimsLedgerMiddleware } = await import('./middleware.js')
type Attribution = import('./attribution-rules.js').Attribution
type ClaimsVariables = import('./middleware.js').ClaimsVariables

beforeEach(() => {
  db.exec('DELETE FROM accruals')
})

const ATTRIBUTION: Attribution = {
  route: 'single-attest',
  priceMicro: 1000,
  packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:bob' }],
}

function buildApp(options: {
  attribution?: Attribution
  settleSuccess?: boolean
  settleTxid?: string
  omitHeader?: boolean
}) {
  const app = new Hono<{ Variables: ClaimsVariables }>()
  // Registered outside (before) the fake payment middleware, matching
  // app.ts's intended mount order.
  app.use('*', claimsLedgerMiddleware)
  app.use('*', async (c, next) => {
    if (options.attribution) c.set('attribution', options.attribution)
    await next()
    if (!options.omitHeader) {
      const header = encodePaymentResponseHeader({
        success: options.settleSuccess ?? true,
        transaction: options.settleTxid ?? 'TXID-MW',
        network: 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
        payer: 'PAYERADDRESS',
      })
      c.res.headers.set('PAYMENT-RESPONSE', header)
    }
  })
  app.get('/x', (c) => c.text('ok'))
  return app
}

describe('claimsLedgerMiddleware', () => {
  test('writes accruals after a successful settlement with attribution on the context', async () => {
    const app = buildApp({ attribution: ATTRIBUTION, settleSuccess: true, settleTxid: 'TXID-MW-1' })
    const res = await app.request('/x')
    expect(res.status).toBe(200)
    expect(getAccrualsForTxid('TXID-MW-1')).toHaveLength(6)
  })

  test('writes nothing when PAYMENT-RESPONSE reports success: false', async () => {
    const app = buildApp({
      attribution: ATTRIBUTION,
      settleSuccess: false,
      settleTxid: 'TXID-MW-2',
    })
    await app.request('/x')
    expect(getAccrualsForTxid('TXID-MW-2')).toHaveLength(0)
  })

  test('writes nothing when there is no PAYMENT-RESPONSE header at all', async () => {
    const app = buildApp({
      attribution: ATTRIBUTION,
      omitHeader: true,
      settleTxid: 'TXID-MW-NO-HEADER',
    })
    await app.request('/x')
    expect(getAccrualsForTxid('TXID-MW-NO-HEADER')).toHaveLength(0)
  })

  test('writes nothing when no attribution was set on the context', async () => {
    const app = buildApp({ settleSuccess: true, settleTxid: 'TXID-MW-3' })
    await app.request('/x')
    expect(getAccrualsForTxid('TXID-MW-3')).toHaveLength(0)
  })

  test('writes nothing for a free request (priceMicro 0), even on a successful settlement', async () => {
    const freeAttribution: Attribution = { ...ATTRIBUTION, priceMicro: 0 }
    const app = buildApp({
      attribution: freeAttribution,
      settleSuccess: true,
      settleTxid: 'TXID-MW-4',
    })
    await app.request('/x')
    expect(getAccrualsForTxid('TXID-MW-4')).toHaveLength(0)
  })
})
