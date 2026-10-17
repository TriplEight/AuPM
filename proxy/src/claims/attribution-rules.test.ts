// proxy/src/claims/attribution-rules.test.ts
import { describe, expect, test } from 'vitest'
import {
  type Attribution,
  buildAccrualInputs,
  CUT_PER_1000,
  DEFAULT_HOLD_DAYS,
  DEFAULT_PAYOUT_RULES,
  holdMsFromEnv,
  isPayoutDue,
  mvpSplit,
  OPS_PER_1000,
  POOL_ROLES,
  POOL_SHARE_PER_1000,
  payoutRulesFromEnv,
  sortPackages,
  splitPoolShare,
} from './attribution-rules.js'

const DAY_MS = 24 * 60 * 60 * 1000

describe('split constants', () => {
  test('cut 200, ops 50, pool 400/100/250 sum to 1,000', () => {
    const pool = POOL_ROLES.reduce((sum, role) => sum + POOL_SHARE_PER_1000[role], 0)
    expect(pool).toBe(750)
    expect(CUT_PER_1000 + OPS_PER_1000 + pool).toBe(1000)
  })
})

describe('mvpSplit', () => {
  test('MVP split', () => {
    expect(mvpSplit()).toEqual({ auditorPercent: 30, opsPercent: 70 })
  })
})

describe('holdMsFromEnv', () => {
  test('unset or empty: 30 days', () => {
    expect(DEFAULT_HOLD_DAYS).toBe(30)
    expect(holdMsFromEnv({})).toBe(30 * DAY_MS)
    expect(holdMsFromEnv({ POOL_HOLD_DAYS: '  ' })).toBe(30 * DAY_MS)
  })

  test('a whole number of days is read', () => {
    expect(holdMsFromEnv({ POOL_HOLD_DAYS: '45' })).toBe(45 * DAY_MS)
  })

  test.each(['0', '-3', '1.5', 'abc', '3651', '1e2', '0x10'])('rejects %s', (value) => {
    expect(() => holdMsFromEnv({ POOL_HOLD_DAYS: value })).toThrow(/POOL_HOLD_DAYS/)
  })
})

describe('sortPackages', () => {
  test('sorts by pkg name then version', () => {
    const sorted = sortPackages([
      { pkg: 'zeta', version: '1.0.0', auditor: null },
      { pkg: 'alpha', version: '2.0.0', auditor: null },
      { pkg: 'alpha', version: '1.0.0', auditor: null },
    ])
    expect(sorted.map((p) => `${p.pkg}@${p.version}`)).toEqual([
      'alpha@1.0.0',
      'alpha@2.0.0',
      'zeta@1.0.0',
    ])
  })
})

describe('splitPoolShare', () => {
  test('one payee gets the whole share', () => {
    expect(splitPoolShare(400, ['github:a'])).toEqual([
      { identity: 'github:a', amountMicro: 400, treasuryKind: null },
    ])
  })

  test('no payee: the whole share is treasury unallocated', () => {
    expect(splitPoolShare(250, [])).toEqual([
      { identity: 'treasury', amountMicro: 250, treasuryKind: 'unallocated' },
    ])
  })

  test('three payees share 400 equally; the remainder 1 goes to treasury unallocated', () => {
    const shares = splitPoolShare(400, ['github:a', 'github:b', 'github:c'])
    expect(shares.map((s) => s.amountMicro)).toEqual([133, 133, 133, 1])
    expect(shares[3]).toEqual({ identity: 'treasury', amountMicro: 1, treasuryKind: 'unallocated' })
    expect(shares.reduce((sum, s) => sum + s.amountMicro, 0)).toBe(400)
  })

  test('an even split leaves no remainder row', () => {
    const shares = splitPoolShare(400, ['github:a', 'github:b'])
    expect(shares.map((s) => s.amountMicro)).toEqual([200, 200])
  })

  test('more payees than micro-units: all of it is unallocated, no zero row', () => {
    const shares = splitPoolShare(2, ['a', 'b', 'c'])
    expect(shares).toEqual([{ identity: 'treasury', amountMicro: 2, treasuryKind: 'unallocated' }])
  })
})

describe('buildAccrualInputs', () => {
  test('free request (priceMicro 0) produces no accrual inputs at all', () => {
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 0,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
    }
    expect(buildAccrualInputs(attribution)).toEqual([])
  })

  test('tarball route with a reviewer: cut 200, ops 50, reviewer 400, rest unallocated', () => {
    const attribution: Attribution = {
      route: 'tarball',
      priceMicro: 1000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:Alice' }],
    }
    const rows = buildAccrualInputs(attribution)
    expect(rows.map((r) => [r.role, r.identity, r.amountMicro, r.treasuryKind, r.held])).toEqual([
      ['treasury', 'treasury', 200, 'cut', false],
      ['ops', 'ops', 50, null, false],
      ['reviewer', 'github:alice', 400, null, true],
      ['contributor', 'treasury', 100, 'unallocated', true],
      ['maintainer', 'treasury', 250, 'unallocated', true],
    ])
    expect(rows.reduce((s, r) => s + r.amountMicro, 0)).toBe(1000)
  })

  test('a package with no reviewer: the reviewer line is unallocated too', () => {
    const rows = buildAccrualInputs({
      route: 'tarball',
      priceMicro: 1000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: null }],
    })
    const reviewer = rows.find((r) => r.role === 'reviewer')
    expect(reviewer).toMatchObject({ identity: 'treasury', amountMicro: 400 })
    expect(reviewer?.treasuryKind).toBe('unallocated')
  })

  test('a reviewer named ops or treasury is never a payee', () => {
    for (const name of ['ops', 'TREASURY']) {
      const rows = buildAccrualInputs({
        route: 'tarball',
        priceMicro: 1000,
        packages: [{ pkg: 'ms', version: '2.1.3', auditor: name }],
      })
      expect(rows.find((r) => r.role === 'reviewer')?.treasuryKind).toBe('unallocated')
    }
  })

  test('lockfile route: each reviewed package carries its own exact 1,000 microUSDC', () => {
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 3000,
      packages: [
        { pkg: 'zeta', version: '1.0.0', auditor: 'github:z' },
        { pkg: 'alpha', version: '1.0.0', auditor: 'github:a' },
        { pkg: 'mid', version: '1.0.0', auditor: 'github:m' },
      ],
    }
    const rows = buildAccrualInputs(attribution)
    expect(rows).toHaveLength(15) // 5 rows x 3 packages
    expect(rows[0]?.pkg).toBe('alpha')
    for (const pkg of ['zeta', 'alpha', 'mid']) {
      const pkgRows = rows.filter((r) => r.pkg === pkg)
      expect(pkgRows.reduce((s, r) => s + r.amountMicro, 0)).toBe(1000)
    }
    expect(rows.reduce((s, r) => s + r.amountMicro, 0)).toBe(3000)
  })

  test('throws when priceMicro does not match packages.length * 1,000', () => {
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 20000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
    }
    expect(() => buildAccrualInputs(attribution)).toThrow()
  })
})

describe('payoutRulesFromEnv', () => {
  test('unset or empty values give 1,000,000, 100,000 and 10,000', () => {
    const expected = { minMicro: 1_000_000, dustMicro: 100_000, floorMicro: 10_000 }
    expect(DEFAULT_PAYOUT_RULES).toEqual(expected)
    expect(payoutRulesFromEnv({})).toEqual(expected)
    expect(payoutRulesFromEnv({ PAYOUT_MIN: '', PAYOUT_DUST: ' ' })).toEqual(expected)
  })

  test('each variable overrides its own threshold', () => {
    expect(payoutRulesFromEnv({ PAYOUT_MIN: '5', PAYOUT_DUST: '4', PAYOUT_FLOOR: '3' })).toEqual({
      minMicro: 5,
      dustMicro: 4,
      floorMicro: 3,
    })
  })

  test.each(['0', '-1', '1.5', '1e6', 'abc', '9007199254740993'])('rejects "%s"', (raw) => {
    expect(() => payoutRulesFromEnv({ PAYOUT_FLOOR: raw })).toThrow(/PAYOUT_FLOOR must be/)
  })
})

describe('isPayoutDue', () => {
  const rules = DEFAULT_PAYOUT_RULES

  test('rule a: the minimum is due on any night, one below is not', () => {
    expect(isPayoutDue(1_000_000, 0, 0, rules)).toBe(true)
    expect(isPayoutDue(999_999, 0, 0, rules)).toBe(false)
  })

  test('rule b: the dust level is due at 7 days, not before', () => {
    expect(isPayoutDue(100_000, 0, 7 * DAY_MS, rules)).toBe(true)
    expect(isPayoutDue(100_000, 0, 7 * DAY_MS - 1, rules)).toBe(false)
    expect(isPayoutDue(99_999, 0, 7 * DAY_MS, rules)).toBe(false)
  })

  test('rule c: the floor is due at 30 days, not before', () => {
    expect(isPayoutDue(10_000, 0, 30 * DAY_MS, rules)).toBe(true)
    expect(isPayoutDue(10_000, 0, 30 * DAY_MS - 1, rules)).toBe(false)
    expect(isPayoutDue(9_999, 0, 30 * DAY_MS, rules)).toBe(false)
  })

  test('a balance of 0 is never due', () => {
    expect(isPayoutDue(0, 0, 365 * DAY_MS, rules)).toBe(false)
  })
})
