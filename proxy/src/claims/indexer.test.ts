// proxy/src/claims/indexer.test.ts
//
// CAUTION: every test here stubs `fetch` — no test in this file performs a
// real network call. `createIndexerClient` is the only module in
// proxy/src/claims that talks to an Algorand indexer directly.

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { createIndexerClient } from './indexer.js'

const PAY_TO = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const SENDER = 'SENDERADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
const USDC_ASA_ID = '31566704'

/** A minimally valid indexer transaction JSON body, with overridable fields. */
function makeTxn(overrides: Record<string, unknown> = {}) {
  return {
    id: 'TXID-DEFAULT',
    fee: 1000,
    'first-valid': 1_000,
    'last-valid': 2_000,
    sender: SENDER,
    'confirmed-round': 1_500,
    'round-time': 1_700_000_000,
    'tx-type': 'axfer',
    'asset-transfer-transaction': {
      amount: 1000,
      'asset-id': Number(USDC_ASA_ID),
      receiver: PAY_TO,
    },
    ...overrides,
  }
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createIndexerClient', () => {
  test('pages through next-token across at least two pages', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const parsed = new URL(url.toString())
      if (!parsed.searchParams.has('next')) {
        return jsonResponse({
          'current-round': 1500,
          transactions: [makeTxn({ id: 'TXID-PAGE1' })],
          'next-token': 'page-2-token',
        })
      }
      expect(parsed.searchParams.get('next')).toBe('page-2-token')
      return jsonResponse({
        'current-round': 1501,
        transactions: [makeTxn({ id: 'TXID-PAGE2' })],
      })
    })

    const indexer = createIndexerClient('https://mainnet-idx.algonode.cloud', USDC_ASA_ID)
    const inflows = await indexer.listUsdcInflows(PAY_TO)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(inflows.map((i) => i.txid)).toEqual(['TXID-PAGE1', 'TXID-PAGE2'])
    expect(inflows.every((i) => i.amountMicro === 1000)).toBe(true)
    expect(inflows.every((i) => i.confirmedAt === 1_700_000_000)).toBe(true)
  })

  test('every request filters on receiver=payTo, tx-type=axfer, and the configured asset', async () => {
    fetchMock.mockImplementation(async (url: string | URL) => {
      const parsed = new URL(url.toString())
      expect(parsed.searchParams.get('address')).toBe(PAY_TO)
      expect(parsed.searchParams.get('address-role')).toBe('receiver')
      expect(parsed.searchParams.get('tx-type')).toBe('axfer')
      expect(parsed.searchParams.get('asset-id')).toBe(USDC_ASA_ID)
      return jsonResponse({ 'current-round': 1, transactions: [] })
    })

    const indexer = createIndexerClient('https://mainnet-idx.algonode.cloud', USDC_ASA_ID)
    await indexer.listUsdcInflows(PAY_TO)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  test('a transaction with no asset-transfer body, or a mismatched receiver, is skipped', async () => {
    fetchMock.mockImplementation(async () =>
      jsonResponse({
        'current-round': 1,
        transactions: [
          {
            id: 'TXID-NO-TRANSFER-BODY',
            fee: 0,
            'first-valid': 1,
            'last-valid': 2,
            sender: SENDER,
            'tx-type': 'axfer',
          },
          makeTxn({
            id: 'TXID-WRONG-RECEIVER',
            'asset-transfer-transaction': {
              amount: 1000,
              'asset-id': Number(USDC_ASA_ID),
              receiver: SENDER,
            },
          }),
        ],
      }),
    )

    const indexer = createIndexerClient('https://mainnet-idx.algonode.cloud', USDC_ASA_ID)
    const inflows = await indexer.listUsdcInflows(PAY_TO)
    expect(inflows).toEqual([])
  })
})
