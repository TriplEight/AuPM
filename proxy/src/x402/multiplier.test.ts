// proxy/src/x402/multiplier.test.ts
import { describe, expect, test } from 'vitest'
import {
  DEFAULT_MULTIPLIER_TENTHS,
  parseMultiplier,
  priceReceipt,
  totalPriceMicro,
} from './multiplier.js'

describe('parseMultiplier', () => {
  test('a missing header gives x1, ten tenths', () => {
    expect(parseMultiplier(undefined)).toBe(DEFAULT_MULTIPLIER_TENTHS)
    expect(parseMultiplier(null)).toBe(10)
  })

  test.each([
    ['1', 1],
    ['9', 9],
    ['10', 10],
    ['100', 100],
    ['999', 999],
    ['1000', 1000],
  ])('accepts %s', (raw, tenths) => {
    expect(parseMultiplier(raw)).toBe(tenths)
  })

  test.each([
    '0',
    '1001',
    '9999',
    '01',
    '+5',
    '-5',
    '1.5',
    '1e2',
    '0x10',
    '',
    ' ',
    'abc',
    ' 10',
    '10 ',
    '10,10',
    '10000',
  ])('rejects %j', (raw) => {
    expect(parseMultiplier(raw)).toBeNull()
  })
})

describe('totalPriceMicro', () => {
  test('is 1,000 x tenths x count in integers', () => {
    expect(totalPriceMicro(1, DEFAULT_MULTIPLIER_TENTHS)).toBe(10_000)
    expect(totalPriceMicro(1, 1)).toBe(1_000)
    expect(totalPriceMicro(1, 10)).toBe(10_000)
    expect(totalPriceMicro(1, 1000)).toBe(1_000_000)
    expect(totalPriceMicro(7, 25)).toBe(175_000)
    expect(totalPriceMicro(512, 1000)).toBe(512_000_000)
  })

  test('the receipt carries base, multiplier and total', () => {
    expect(priceReceipt(3, 20)).toEqual({
      baseMicro: 10_000,
      multiplierTenths: 20,
      totalMicro: 60_000,
    })
  })
})
