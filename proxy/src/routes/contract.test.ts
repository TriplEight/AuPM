// proxy/src/routes/contract.test.ts
import { afterEach, describe, expect, test } from 'vitest'

const PAY_TO = 'A'.repeat(58)
process.env.PAY_TO_ADDRESS = PAY_TO

const { default: contractRouter } = await import('./contract.js')
const { ALGORAND_MAINNET_CAIP2 } = await import('@x402-avm/avm')

afterEach(() => {
  delete process.env.PAYMENT_ROUTER_APP_ID
})

describe('GET /api/v1/contract', () => {
  test('200 with the exact public shape and integer ids', async () => {
    process.env.PAYMENT_ROUTER_APP_ID = '123456'
    const res = await contractRouter.request('/')
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body).toEqual({
      network: ALGORAND_MAINNET_CAIP2,
      appId: 123456,
      payTo: PAY_TO,
      usdcAssetId: 31566704,
      minClaim: 100000,
    })
    expect(Number.isInteger(body.appId)).toBe(true)
    expect(Number.isInteger(body.usdcAssetId)).toBe(true)
    expect(Number.isInteger(body.minClaim)).toBe(true)
  })

  test('carries no key, mnemonic, or crediter field', async () => {
    process.env.PAYMENT_ROUTER_APP_ID = '123456'
    const body = await (await contractRouter.request('/')).json()
    expect(Object.keys(body).sort()).toEqual(
      ['appId', 'minClaim', 'network', 'payTo', 'usdcAssetId'].sort(),
    )
    expect(JSON.stringify(body)).not.toMatch(/mnemonic|secret|crediter|private/i)
  })

  test('503 with an actionable message when PAYMENT_ROUTER_APP_ID is unset', async () => {
    const res = await contractRouter.request('/')
    expect(res.status).toBe(503)
    expect((await res.json()).error).toMatch(/PAYMENT_ROUTER_APP_ID/)
  })

  test.each(['abc', '0', '-5', '1.5', '12abc'])('503 for invalid app id %s', async (value) => {
    process.env.PAYMENT_ROUTER_APP_ID = value
    const res = await contractRouter.request('/')
    expect(res.status).toBe(503)
  })
})
