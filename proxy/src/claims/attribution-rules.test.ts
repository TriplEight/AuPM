// proxy/src/claims/attribution-rules.test.ts
import { describe, expect, test } from 'vitest'
import {
  type Attribution,
  auditorShareMicro,
  buildAccrualInputs,
  computeRoleShareMicro,
  mvpSplit,
  OPS_IDENTITY,
  ROLE_SHARE_PER_1000,
  ROLE_SHARE_PER_1000_BY_NETWORK,
  ROLES,
  resolveAuditorIdentity,
  resolveContributorIdentity,
  resolveMaintainerIdentity,
  resolveOpsIdentity,
  resolveReviewerIdentity,
  resolveTreasuryIdentity,
  roleShareTableFor,
  sortPackages,
  targetSplitRow,
  UNASSIGNED,
} from './attribution-rules.js'

// MainNet is the default network (NETWORK unset -> 'mainnet', proxy/src/config.ts),
// so ROLE_SHARE_PER_1000 here is the MainNet row (ADR 0011): 300/100/200/250/100/50.
describe('role shares', () => {
  test('300/100/200/250/100/50 of 20000 microUSDC scale exactly (MainNet, ADR 0011)', () => {
    expect(computeRoleShareMicro(20000, 'auditor')).toBe(6000)
    expect(computeRoleShareMicro(20000, 'contributor')).toBe(2000)
    expect(computeRoleShareMicro(20000, 'maintainer')).toBe(4000)
    expect(computeRoleShareMicro(20000, 'reviewer')).toBe(5000)
    expect(computeRoleShareMicro(20000, 'treasury')).toBe(2000)
    expect(computeRoleShareMicro(20000, 'ops')).toBe(1000)
  })

  test('400/100/200/150/100/50 of 20000 microUSDC scale exactly (TestNet, ADR 0003)', () => {
    expect(computeRoleShareMicro(20000, 'auditor', 'testnet')).toBe(8000)
    expect(computeRoleShareMicro(20000, 'contributor', 'testnet')).toBe(2000)
    expect(computeRoleShareMicro(20000, 'maintainer', 'testnet')).toBe(4000)
    expect(computeRoleShareMicro(20000, 'reviewer', 'testnet')).toBe(3000)
    expect(computeRoleShareMicro(20000, 'treasury', 'testnet')).toBe(2000)
    expect(computeRoleShareMicro(20000, 'ops', 'testnet')).toBe(1000)
  })

  test.each(['mainnet', 'testnet'] as const)(
    'all six ledgered role shares sum to 1,000 on %s',
    (network) => {
      const table = roleShareTableFor(network)
      const sum = ROLES.reduce((s, r) => s + table[r], 0)
      expect(sum).toBe(1000)
      expect(ROLES).toHaveLength(6)
    },
  )

  test('roleShareTableFor throws on an unrecognized network', () => {
    expect(() => roleShareTableFor('localnet')).toThrow(/unknown network/)
  })

  test('throws on a price that is not a multiple of 1,000 microUSDC', () => {
    expect(() => computeRoleShareMicro(1500, 'auditor')).toThrow()
  })
})

describe('targetSplitRow and mvpSplit (docs/TASK.md P8a)', () => {
  test('MainNet target row and MVP split (ADR 0011)', () => {
    expect(targetSplitRow('mainnet')).toBe('30/10/20/25/10/5')
    expect(mvpSplit('mainnet')).toEqual({ auditorPercent: 30, opsPercent: 70 })
  })

  test('TestNet target row and MVP split (ADR 0003; app 772553842 is not redeployed)', () => {
    expect(targetSplitRow('testnet')).toBe('40/10/20/15/10/5')
    expect(mvpSplit('testnet')).toEqual({ auditorPercent: 40, opsPercent: 60 })
  })
})

describe('auditorShareMicro rounds like the contract (docs/TASK.md P8a)', () => {
  // contract.algo.ts: auditorShare = (attributedTotal * AUDITOR_SHARE_NUM) / SPLIT_DEN,
  // uint64 (floor) division. An attributedMicro that is not a multiple of 1,000
  // never occurs in production (every price is a multiple of 1,000), but this
  // defence-in-depth check must floor exactly like the contract, not merely
  // when the division happens to be exact.
  test('floors 1,001 x 300 / 1000 on MainNet, like the contract', () => {
    expect(auditorShareMicro(1001, 'mainnet')).toBe(Math.floor((1001 * 300) / 1000))
    expect(auditorShareMicro(1001, 'mainnet')).toBe(300)
  })

  test('floors 999 x 300 / 1000 on MainNet, like the contract', () => {
    expect(auditorShareMicro(999, 'mainnet')).toBe(Math.floor((999 * 300) / 1000))
    expect(auditorShareMicro(999, 'mainnet')).toBe(299)
  })

  test('floors 1,001 x 400 / 1000 on TestNet, like the contract', () => {
    expect(auditorShareMicro(1001, 'testnet')).toBe(Math.floor((1001 * 400) / 1000))
    expect(auditorShareMicro(1001, 'testnet')).toBe(400)
  })

  test('floors 999 x 400 / 1000 on TestNet, like the contract', () => {
    expect(auditorShareMicro(999, 'testnet')).toBe(Math.floor((999 * 400) / 1000))
    expect(auditorShareMicro(999, 'testnet')).toBe(399)
  })

  test('exact multiples of 1,000 never lose a remainder, on either network', () => {
    expect(auditorShareMicro(2000, 'mainnet')).toBe(600)
    expect(auditorShareMicro(2000, 'testnet')).toBe(800)
  })

  test('an unrecognized network fails fast with a clear error', () => {
    expect(() => auditorShareMicro(1000, 'localnet')).toThrow(/unknown network/)
  })
})

describe('ROLE_SHARE_PER_1000_BY_NETWORK', () => {
  test('is the single source of truth for both the ledger split and the MainNet default', () => {
    expect(ROLE_SHARE_PER_1000).toEqual(ROLE_SHARE_PER_1000_BY_NETWORK.mainnet)
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

describe('identity resolution', () => {
  test('auditor identity is the review record reviewer', () => {
    expect(
      resolveAuditorIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
      }),
    ).toBe('github:alice')
  })

  test('missing auditor maps to unassigned', () => {
    expect(resolveAuditorIdentity({ pkg: 'ms', version: '2.1.3', auditor: null })).toBe(UNASSIGNED)
  })

  test('maintainer identity is always unassigned', () => {
    expect(
      resolveMaintainerIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: null,
      }),
    ).toBe(UNASSIGNED)
  })

  test('contributor identity is always unassigned', () => {
    expect(
      resolveContributorIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
      }),
    ).toBe(UNASSIGNED)
  })

  test('reviewer (adversarial) always maps to unassigned, ignoring the entry', () => {
    expect(
      resolveReviewerIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
      }),
    ).toBe(UNASSIGNED)
  })

  test('treasury identity is always unassigned', () => {
    expect(
      resolveTreasuryIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
      }),
    ).toBe(UNASSIGNED)
  })

  test('ops identity is always "ops", never unassigned', () => {
    expect(
      resolveOpsIdentity({
        pkg: 'ms',
        version: '2.1.3',
        auditor: 'github:alice',
      }),
    ).toBe(OPS_IDENTITY)
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

  test('tarball route: the one package gets its own full 300/100/200/250/100/50 shares (MainNet)', () => {
    const attribution: Attribution = {
      route: 'tarball',
      priceMicro: 1000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
    }
    const rows = buildAccrualInputs(attribution)
    expect(rows).toHaveLength(6)
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.amountMicro]))
    expect(byRole.auditor).toBe(300)
    expect(byRole.contributor).toBe(100)
    expect(byRole.maintainer).toBe(200)
    expect(byRole.reviewer).toBe(250)
    expect(byRole.treasury).toBe(100)
    expect(byRole.ops).toBe(50)
    expect(rows.reduce((s, r) => s + r.amountMicro, 0)).toBe(1000)
  })

  test('tarball route on TestNet: the older 400/100/200/150/100/50 shares (ADR 0003)', () => {
    const attribution: Attribution = {
      route: 'tarball',
      priceMicro: 1000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
    }
    const rows = buildAccrualInputs(attribution, 'testnet')
    const byRole = Object.fromEntries(rows.map((r) => [r.role, r.amountMicro]))
    expect(byRole.auditor).toBe(400)
    expect(byRole.reviewer).toBe(150)
    expect(rows.reduce((s, r) => s + r.amountMicro, 0)).toBe(1000)
  })

  test('lockfile route: each of 3 reviewed packages carries its own exact 1,000 microUSDC, no split', () => {
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
    expect(rows).toHaveLength(18) // 6 roles x 3 packages

    for (const pkg of ['zeta', 'alpha', 'mid']) {
      const pkgRows = rows.filter((r) => r.pkg === pkg)
      const byRole = Object.fromEntries(pkgRows.map((r) => [r.role, r.amountMicro]))
      expect(byRole.auditor).toBe(300)
      expect(byRole.contributor).toBe(100)
      expect(byRole.maintainer).toBe(200)
      expect(byRole.reviewer).toBe(250)
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
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
    }
    expect(() => buildAccrualInputs(attribution)).toThrow()
  })
})
