// cli/src/summary.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { countsFromSummary, donorKeyExists, summaryLines } from './summary.js'

const base = { reviewed: 3, unreviewed: 4, integrityMismatch: 1, unresolvable: 2 }
const clean = { ...base, integrityMismatch: 0 }
const noKey = { hasDonorKey: false }

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

  it('prints unknown counts, the cause, and no donation or offer line for an unknown reviewed count', () => {
    const counts = countsFromSummary({ unreviewed: 1 })
    for (const donate of [false, true]) {
      expect(summaryLines({ counts, donate, settlement: null, ...noKey })).toEqual([
        'Reviewed: unknown. Not reviewed: 1. Integrity mismatch: unknown. Unresolvable: unknown.',
        'AuPM could not read the counts from the server answer. ' +
          'The install is not affected. Try again later.',
      ])
    }
  })
})

describe('summaryLines', () => {
  const countsLine = 'Reviewed: 3. Not reviewed: 4. Integrity mismatch: 0. Unresolvable: 2.'
  const mismatchLine = 'Reviewed: 3. Not reviewed: 4. Integrity mismatch: 1. Unresolvable: 2.'

  it('without donate and without a donor key: the offer says to run donor init first', () => {
    const lines = summaryLines({ counts: clean, donate: false, settlement: null, ...noKey })
    expect(lines).toEqual([
      countsLine,
      'You can donate 0.003 USDC for 3 reviewed packages. This is optional. ' +
        'To donate, run `aupm donor init` once, then add --donate.',
      '--donate pays for all reviewed packages in the lockfile, not only the package you named.',
      'Base 0.001 USDC (x0.1). Multiplier x0.1 (not set; aupm config set multiplier <x>). Total 0.003 USDC.',
    ])
  })

  it('without donate and with a donor key: the offer skips donor init', () => {
    const lines = summaryLines({
      counts: clean,
      donate: false,
      settlement: null,
      hasDonorKey: true,
    })
    expect(lines[1]).toBe(
      'You can donate 0.003 USDC for 3 reviewed packages. This is optional. ' +
        'To donate, add --donate.',
    )
    expect(lines.join('\n')).not.toContain('donor init')
  })

  it('with donate: counts, the amount donated, the txid and the explorer link, no offer note', () => {
    const lines = summaryLines({
      counts: clean,
      donate: true,
      settlement: { txid: 'TXID', amountMicro: 3_000 },
      ...noKey,
    })
    expect(lines[0]).toBe(countsLine)
    expect(lines[1]).toBe('Donated 0.003 USDC for 3 reviewed packages.')
    expect(lines[2]).toBe(
      'Base 0.001 USDC (x0.1). Multiplier x0.1 (not set; aupm config set multiplier <x>). Total 0.003 USDC.',
    )
    expect(lines[3]).toMatch(
      /^Settlement txid: TXID https:\/\/lora\.algokit\.io\/\w+\/transaction\/TXID$/,
    )
    expect(lines).toHaveLength(4)
  })

  it.each([
    [10, 30_000, '0.03'],
    [1000, 3_000_000, '3'],
  ])('at tenths %i the offer and the receipt show the multiplied total', (tenths, micro, usdc) => {
    const multiplier = { tenths, source: 'file' as const }
    const offer = summaryLines({
      counts: clean,
      donate: false,
      settlement: null,
      multiplier,
      ...noKey,
    })
    expect(offer[1]).toContain(`You can donate ${usdc} USDC for 3 reviewed packages.`)
    const paid = summaryLines({
      counts: clean,
      donate: true,
      settlement: { txid: 'T', amountMicro: micro },
      multiplier,
      ...noKey,
    })
    expect(paid[2]).toBe(`Base 0.001 USDC (x0.1). Multiplier x${tenths / 10}. Total ${usdc} USDC.`)
  })

  it('tells the user not to use a package with an integrity mismatch', () => {
    const lines = summaryLines({ counts: base, donate: false, settlement: null, ...noKey })
    expect(lines[0]).toBe(mismatchLine)
    expect(lines[1]).toContain('Do not use packages with an integrity mismatch.')
    expect(lines[1]).toContain('Run `aupm attest <lockfile>`')
    const none = summaryLines({ counts: clean, donate: false, settlement: null, ...noKey })
    expect(none.join('\n')).not.toContain('integrity mismatch.')
  })

  it('says "package" for one, and shows mismatch and unresolvable with 0 reviewed', () => {
    const one = summaryLines({
      counts: { ...clean, reviewed: 1 },
      donate: false,
      settlement: null,
      ...noKey,
    })
    expect(one[1]).toContain('for 1 reviewed package.')
    const none = summaryLines({
      counts: { reviewed: 0, unreviewed: 0, integrityMismatch: 2, unresolvable: 1 },
      donate: true,
      settlement: null,
      ...noKey,
    })
    expect(none[0]).toBe('Reviewed: 0. Not reviewed: 0. Integrity mismatch: 2. Unresolvable: 1.')
    expect(none).toHaveLength(2)
    expect(none[1]).toContain('Do not use packages with an integrity mismatch.')
  })

  it('with donate but no settlement, says no donation was paid and what to check', () => {
    const lines = summaryLines({ counts: clean, donate: true, settlement: null, ...noKey })
    expect(lines).toEqual([
      countsLine,
      'No donation was paid. The install is not affected. ' +
        'Run `aupm donor status` to check your donor wallet.',
    ])
    expect(lines.join('\n')).not.toContain('Donated')
  })

  it('formats an amount above 2^53 microUSDC exactly, so no float touches it', () => {
    const lines = summaryLines({
      counts: { ...clean, reviewed: 1 },
      donate: true,
      settlement: { txid: 'T', amountMicro: 9_007_199_254_740_991 },
      ...noKey,
    })
    expect(lines[1]).toBe('Donated 9007199254.740991 USDC for 1 reviewed package.')
  })

  it('the source uses no float arithmetic on amounts', () => {
    const source = fs.readFileSync(new URL('./summary.ts', import.meta.url), 'utf8')
    expect(source).not.toMatch(/parseFloat|toFixed|Math\.(round|floor|ceil)|\d\.\d/)
  })
})

describe('donorKeyExists', () => {
  afterEach(() => vi.unstubAllEnvs())

  it('is false with no variable and no key file, true with either', () => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-summary-test-'))
    vi.stubEnv('XDG_CONFIG_HOME', home)
    vi.stubEnv('AUPM_DONOR_MNEMONIC', '')
    expect(donorKeyExists()).toBe(false)
    vi.stubEnv('AUPM_DONOR_MNEMONIC', 'a placeholder value')
    expect(donorKeyExists()).toBe(true)
    vi.stubEnv('AUPM_DONOR_MNEMONIC', '')
    fs.mkdirSync(path.join(home, 'aupm'))
    fs.writeFileSync(path.join(home, 'aupm', 'donor.key'), 'not read here\n', { mode: 0o644 })
    expect(donorKeyExists()).toBe(true)
    fs.rmSync(home, { recursive: true, force: true })
  })
})
