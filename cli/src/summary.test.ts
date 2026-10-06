// cli/src/summary.test.ts
import fs from 'node:fs'
import { describe, expect, it } from 'vitest'
import { countsFromSummary, summaryLines } from './summary.js'

const base = { reviewed: 3, unreviewed: 4, integrityMismatch: 1, unresolvable: 2 }

describe('countsFromSummary', () => {
  it('reads the four counts', () => {
    expect(countsFromSummary({ total: 10, ...base })).toEqual(base)
  })

  it('treats missing, negative, fractional and non-numeric counts as unknown, never 0', () => {
    expect(countsFromSummary({ reviewed: -1, unreviewed: 1.5, integrityMismatch: '2' })).toEqual({
      reviewed: 'unknown',
      unreviewed: 'unknown',
      integrityMismatch: 'unknown',
      unresolvable: 'unknown',
    })
    expect(countsFromSummary(undefined).reviewed).toBe('unknown')
  })

  it('prints unknown counts and no donation or offer line for an unknown reviewed count', () => {
    const counts = countsFromSummary({ unreviewed: 1 })
    for (const donate of [false, true]) {
      expect(summaryLines({ counts, donate, settlement: null })).toEqual([
        'Audited: unknown. Not audited: 1. Integrity mismatch: unknown. Unresolvable: unknown.',
      ])
    }
  })
})

describe('summaryLines', () => {
  const countsLine = 'Audited: 3. Not audited: 4. Integrity mismatch: 1. Unresolvable: 2.'

  it('without donate: counts, the amount on offer, and the whole-lockfile note', () => {
    const lines = summaryLines({ counts: base, donate: false, settlement: null })
    expect(lines[0]).toBe(countsLine)
    expect(lines[1]).toBe(
      'A donation would be 0.003 USDC for 3 audited packages. Add --donate to send it.',
    )
    expect(lines[2]).toContain('whole lockfile')
  })

  it('with donate: counts, the amount donated, the txid and the explorer link', () => {
    const lines = summaryLines({
      counts: base,
      donate: true,
      settlement: { txid: 'TXID', amountMicro: 3_000 },
    })
    expect(lines[0]).toBe(countsLine)
    expect(lines[1]).toBe('Donated 0.003 USDC for 3 audited packages.')
    expect(lines[2]).toMatch(
      /^Settlement txid: TXID https:\/\/lora\.algokit\.io\/\w+\/transaction\/TXID$/,
    )
    expect(lines[3]).toContain('whole lockfile')
  })

  it('says "package" for one, and shows mismatch and unresolvable with 0 audited', () => {
    const one = summaryLines({
      counts: { ...base, reviewed: 1 },
      donate: false,
      settlement: null,
    })
    expect(one[1]).toContain('for 1 audited package.')
    const none = summaryLines({
      counts: { reviewed: 0, unreviewed: 0, integrityMismatch: 2, unresolvable: 1 },
      donate: true,
      settlement: null,
    })
    expect(none).toEqual(['Audited: 0. Not audited: 0. Integrity mismatch: 2. Unresolvable: 1.'])
  })

  it('with donate but no settlement, says no donation settled', () => {
    const lines = summaryLines({ counts: base, donate: true, settlement: null })
    expect(lines[1]).toBe('No donation settled.')
    expect(lines.join('\n')).not.toContain('Donated')
  })

  it('formats an amount above 2^53 microUSDC exactly, so no float touches it', () => {
    const lines = summaryLines({
      counts: { ...base, reviewed: 1 },
      donate: true,
      settlement: { txid: 'T', amountMicro: 9_007_199_254_740_991 },
    })
    expect(lines[1]).toBe('Donated 9007199254.740991 USDC for 1 audited package.')
  })

  it('the source uses no float arithmetic on amounts', () => {
    const source = fs.readFileSync(new URL('./summary.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/parseFloat|toFixed|Math\.(round|floor|ceil)|\d\.\d/)
  })
})
