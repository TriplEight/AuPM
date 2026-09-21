// proxy/src/claims/attribution-rules.test.ts
import { describe, expect, test } from 'vitest'
import {
  type Attribution,
  buildAccrualInputs,
  computeRoleShareMicro,
  parseMaintainerIdentity,
  ROLE_SHARE_PER_1000,
  ROLES,
  resolveAuditorIdentity,
  resolveMaintainerIdentity,
  resolveReviewerIdentity,
  sortPackages,
  splitProRata,
  UNASSIGNED,
} from './attribution-rules.js'

describe('role shares', () => {
  test('50/20/15 of 20,000 microUSDC is 10,000 / 4,000 / 3,000 exactly', () => {
    expect(computeRoleShareMicro(20000, 'auditor')).toBe(10000)
    expect(computeRoleShareMicro(20000, 'maintainer')).toBe(4000)
    expect(computeRoleShareMicro(20000, 'reviewer')).toBe(3000)
  })

  test('role shares sum to 850/1000 (treasury 100 + ops 50 are not ledgered)', () => {
    const sum = ROLES.reduce((s, r) => s + ROLE_SHARE_PER_1000[r], 0)
    expect(sum).toBe(850)
  })

  test('throws on a price that is not a multiple of 1,000 microUSDC', () => {
    expect(() => computeRoleShareMicro(1500, 'auditor')).toThrow()
  })
})

describe('splitProRata', () => {
  test('divides evenly when it divides evenly', () => {
    expect(splitProRata(9000, 3)).toEqual([3000, 3000, 3000])
  })

  test('integer division: remainder lands on index 0', () => {
    // 10,000 / 3 = 3333.33...; base 3333 * 3 = 9999, remainder 1
    const amounts = splitProRata(10000, 3)
    expect(amounts).toEqual([3334, 3333, 3333])
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(10000)
  })

  test('4,000 / 3 keeps the whole sum, nothing lost to rounding', () => {
    const amounts = splitProRata(4000, 3)
    expect(amounts.reduce((a, b) => a + b, 0)).toBe(4000)
    expect(Number.isInteger(amounts[0])).toBe(true)
  })
})

describe('sortPackages', () => {
  test('sorts by pkg name then version', () => {
    const sorted = sortPackages([
      { pkg: 'zeta', version: '1.0.0', auditor: null, maintainer: null },
      { pkg: 'alpha', version: '2.0.0', auditor: null, maintainer: null },
      { pkg: 'alpha', version: '1.0.0', auditor: null, maintainer: null },
    ])
    expect(sorted.map((p) => `${p.pkg}@${p.version}`)).toEqual([
      'alpha@1.0.0',
      'alpha@2.0.0',
      'zeta@1.0.0',
    ])
  })
})

describe('identity resolution', () => {
  test('auditor identity is the review record reviewer', () => {
    expect(
      resolveAuditorIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
        maintainer: null,
      }),
    ).toBe('github:alice')
  })

  test('missing auditor maps to unassigned', () => {
    expect(
      resolveAuditorIdentity({ pkg: 'ms', version: '2.1.3', auditor: null, maintainer: null }),
    ).toBe(UNASSIGNED)
  })

  test('maintainer identity comes from AttributionEntry.maintainer', () => {
    expect(
      resolveMaintainerIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: null,
        maintainer: 'github:bob',
      }),
    ).toBe('github:bob')
  })

  test('missing maintainer maps to unassigned', () => {
    expect(
      resolveMaintainerIdentity({ pkg: 'ms', version: '2.1.3', auditor: null, maintainer: null }),
    ).toBe(UNASSIGNED)
  })

  test('reviewer (adversarial) always maps to unassigned, ignoring the entry', () => {
    expect(
      resolveReviewerIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
        maintainer: 'github:bob',
      }),
    ).toBe(UNASSIGNED)
  })
})

describe('parseMaintainerIdentity', () => {
  test('parses a plain https GitHub repository.url', () => {
    expect(parseMaintainerIdentity('https://github.com/lodash/lodash')).toBe('github:lodash')
  })

  test('parses a git+https GitHub repository.url with .git suffix', () => {
    expect(parseMaintainerIdentity('git+https://github.com/babel/babel.git')).toBe('github:babel')
  })

  test('parses an scp-style git@github.com url', () => {
    expect(parseMaintainerIdentity('git@github.com:vuejs/core.git')).toBe('github:vuejs')
  })

  test('a non-GitHub repository maps to null (caller maps to unassigned)', () => {
    expect(parseMaintainerIdentity('https://gitlab.com/foo/bar')).toBeNull()
  })

  test('a missing repository maps to null', () => {
    expect(parseMaintainerIdentity(null)).toBeNull()
    expect(parseMaintainerIdentity(undefined)).toBeNull()
  })
})

describe('buildAccrualInputs', () => {
  test('free request (priceMicro 0) produces no accrual inputs at all', () => {
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 0,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:bob' },
      ],
    }
    expect(buildAccrualInputs(attribution)).toEqual([])
  })

  test('tarball route: 100% of each role share goes to the single package', () => {
    const attribution: Attribution = {
      route: 'tarball',
      priceMicro: 1000,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:bob' },
      ],
    }
    const rows = buildAccrualInputs(attribution)
    expect(rows).toHaveLength(3)
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.amountMicro]))
    expect(byRole.auditor).toBe(500)
    expect(byRole.maintainer).toBe(200)
    expect(byRole.reviewer).toBe(150)
  })

  test('lockfile route: pro-rata across 3 reviewed packages, remainder to first in sort order, sums exact', () => {
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 20000,
      packages: [
        { pkg: 'zeta', version: '1.0.0', auditor: 'github:z', maintainer: null },
        { pkg: 'alpha', version: '1.0.0', auditor: 'github:a', maintainer: null },
        { pkg: 'mid', version: '1.0.0', auditor: 'github:m', maintainer: null },
      ],
    }
    const rows = buildAccrualInputs(attribution)
    expect(rows).toHaveLength(9) // 3 roles x 3 packages

    for (const role of ROLES) {
      const roleRows = rows.filter((r) => r.role === role)
      const expectedShare = computeRoleShareMicro(20000, role)
      const sum = roleRows.reduce((s, r) => s + r.amountMicro, 0)
      expect(sum).toBe(expectedShare)

      // sort order is alpha, mid, zeta — the remainder (if any) is on alpha.
      const byPkg = Object.fromEntries(roleRows.map((r) => [r.pkg, r.amountMicro]))
      const base = Math.floor(expectedShare / 3)
      const remainder = expectedShare - base * 3
      expect(byPkg.alpha).toBe(base + remainder)
      expect(byPkg.mid).toBe(base)
      expect(byPkg.zeta).toBe(base)
    }
  })
})
