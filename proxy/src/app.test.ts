// proxy/src/app.test.ts
import { beforeEach, describe, expect, test } from 'vitest'
import app from './app.js'
import db from './db.js'
import { setStatus } from './status.js'

const FAKE_APP_ADDRESS = 'FAKEADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

beforeEach(() => {
  db.exec('DELETE FROM audit_status')
  process.env['SPLIT_APP_ADDRESS'] = FAKE_APP_ADDRESS
  process.env['SPLIT_APP_ID'] = '999'
})

describe('x402 gate', () => {
  test('non-tarball request: proxied without 402 check', async () => {
    // Metadata requests should never return 402 regardless of status
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash')
    // Should not be 402 (may be 200 or any other code from npm passthrough)
    expect(res.status).not.toBe(402)
  })

  test('free package tarball: no 402', async () => {
    // UNREVIEWED = free
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz')
    expect(res.status).not.toBe(402)
  })

  test('paid package tarball: returns 402 without payment header', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz')
    expect(res.status).toBe(402)
    const body = (await res.json()) as {
      x402Version: number
      accepts: Array<{
        scheme: string
        asset: string
        maxAmountRequired: string
        payTo: string
      }>
    }
    expect(body.x402Version).toBe(2)
    expect(body.accepts[0]?.scheme).toBe('exact')
    expect(body.accepts[0]?.asset).toBe('10458941')
    expect(body.accepts[0]?.maxAmountRequired).toBe('1000')
    expect(body.accepts[0]?.payTo).toBe(FAKE_APP_ADDRESS)
  })

  test('paid package tarball with payment header: passes through gate', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/lodash/-/lodash-4.17.21.tgz', {
      headers: { 'PAYMENT-SIGNATURE': 'placeholder-payment' },
    })
    // Should not be 402 — settlement is handled in A4, for now just passes through
    expect(res.status).not.toBe(402)
  })

  test('scoped package tarball: returns 402', async () => {
    setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const res = await app.request('/@scope/pkg/-/pkg-1.0.0.tgz')
    expect(res.status).toBe(402)
  })
})
