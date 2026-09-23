// proxy/src/claims/attribution-rules.test.ts
import { describe, expect, test } from 'vitest'
import {
  type Attribution,
  buildAccrualInputs,
  computeRoleShareMicro,
  OPS_IDENTITY,
  ROLE_SHARE_PER_1000,
  ROLES,
  resolveAuditorIdentity,
  resolveContributorIdentity,
  resolveMaintainerIdentity,
  resolveOpsIdentity,
  resolveReviewerIdentity,
  resolveTreasuryIdentity,
  sortPackages,
  UNASSIGNED,
} from './attribution-rules.js'

describe('role shares', () => {
  test('400/100/200/150/100/50 of 20,000 microUSDC scale exactly', () => {
    expect(computeRoleShareMicro(20000, 'auditor')).toBe(8000)
    expect(computeRoleShareMicro(20000, 'contributor')).toBe(2000)
    expect(computeRoleShareMicro(20000, 'maintainer')).toBe(4000)
    expect(computeRoleShareMicro(20000, 'reviewer')).toBe(3000)
    expect(computeRoleShareMicro(20000, 'treasury')).toBe(2000)
    expect(computeRoleShareMicro(20000, 'ops')).toBe(1000)
  })

  test('all six ledgered role shares sum to 1,000 (SPEC.md §13.2)', () => {
    const sum = ROLES.reduce((s, r) => s + ROLE_SHARE_PER_1000[r], 0)
    expect(sum).toBe(1000)
    expect(ROLES).toHaveLength(6)
  })

  test('throws on a price that is not a multiple of 1,000 microUSDC', () => {
    expect(() => computeRoleShareMicro(1500, 'auditor')).toThrow()
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

  test('maintainer identity is always unassigned, even when AttributionEntry.maintainer is set', () => {
    expect(
      resolveMaintainerIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: null,
        maintainer: 'github:bob',
      }),
    ).toBe(UNASSIGNED)
  })

  test('contributor identity is always unassigned', () => {
    expect(
      resolveContributorIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
        maintainer: 'github:bob',
      }),
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

  test('treasury identity is always unassigned', () => {
    expect(
      resolveTreasuryIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
        maintainer: 'github:bob',
      }),
    ).toBe(UNASSIGNED)
  })

  test('ops identity is always "ops", never unassigned', () => {
    expect(
      resolveOpsIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
        maintainer: 'github:bob',
      }),
    ).toBe(OPS_IDENTITY)
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

  test('tarball route: the one package gets its own full 400/100/200/150/100/50 shares', () => {
    const attribution: Attribution = {
      route: 'tarball',
      priceMicro: 1000,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:bob' },
      ],
    }
    const rows = buildAccrualInputs(attribution)
    expect(rows).toHaveLength(6)
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.amountMicro]))
    expect(byRole.auditor).toBe(400)
    expect(byRole.contributor).toBe(100)
    expect(byRole.maintainer).toBe(200)
    expect(byRole.reviewer).toBe(150)
    expect(byRole.treasury).toBe(100)
    expect(byRole.ops).toBe(50)
    expect(rows.reduce((s, r) => s + r.amountMicro, 0)).toBe(1000)
  })

  test('lockfile route: each of 3 reviewed packages carries its own exact 1,000 microUSDC, no split', () => {
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 3000,
      packages: [
        { pkg: 'zeta', version: '1.0.0', auditor: 'github:z', maintainer: null },
        { pkg: 'alpha', version: '1.0.0', auditor: 'github:a', maintainer: null },
        { pkg: 'mid', version: '1.0.0', auditor: 'github:m', maintainer: null },
      ],
    }
    const rows = buildAccrualInputs(attribution)
    expect(rows).toHaveLength(18) // 6 roles x 3 packages

    for (const pkg of ['zeta', 'alpha', 'mid']) {
      const pkgRows = rows.filter((r) => r.pkg === pkg)
      const byRole = Object.fromEntries(pkgRows.map((r) => [r.role, r.amountMicro]))
      expect(byRole.auditor).toBe(400)
      expect(byRole.contributor).toBe(100)
      expect(byRole.maintainer).toBe(200)
      expect(byRole.reviewer).toBe(150)
      expect(byRole.treasury).toBe(100)
      expect(byRole.ops).toBe(50)
      expect(pkgRows.reduce((s, r) => s + r.amountMicro, 0)).toBe(1000)
    }

    expect(rows.reduce((s, r) => s + r.amountMicro, 0)).toBe(3000)
  })

  test('throws when priceMicro does not match packages.length * 1,000', () => {
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 20000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: null }],
    }
    expect(() => buildAccrualInputs(attribution)).toThrow()
  })
})
