// mcp/src/money.test.ts
import { describe, expect, it } from 'vitest'
import { formatMicroUsd } from './money.js'

describe('formatMicroUsd', () => {
  it.each([
    [0, '$0.00'],
    [1, '$0.000001'],
    [999, '$0.000999'],
    [1_000, '$0.001'],
    [1_000_000, '$1.00'],
    [123_456_789, '$123.456789'],
  ])('formats %i microUSDC as %s', (microUsd, expected) => {
    expect(formatMicroUsd(microUsd)).toBe(expected)
  })

  it('rejects a negative amount', () => {
    expect(() => formatMicroUsd(-1)).toThrow(/non-negative integer/)
  })

  it('rejects a non-integer amount', () => {
    expect(() => formatMicroUsd(1.5)).toThrow(/non-negative integer/)
  })
})
