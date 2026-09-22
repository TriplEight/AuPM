// proxy/src/claims/ledger.test.ts
//
// CAUTION: this file gets its own SQLite file via SQLITE_PATH, set before
// the dynamic import below (same trick as proxy/src/app.test.ts). The
// accruals and payouts tables are shared across several test files in this
// directory; without per-file isolation, vitest's parallel test files race
// on the same physical database and writes from one file can be wiped by
// another file's beforeEach mid-test.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-claims-ledger-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const {
  accrualCountForTxid,
  getAccrualsForTxid,
  getEarningsForLogin,
  recordPayout,
  writeAccruals,
} = await import('./ledger.js')
type Attribution = import('./attribution-rules.js').Attribution

beforeEach(() => {
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM payouts')
})

const LOCKFILE_ATTRIBUTION: Attribution = {
  route: 'lockfile',
  priceMicro: 20000,
  packages: [
    { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:ms-owner' },
    { pkg: 'lodash', version: '4.17.21', auditor: 'github:bob', maintainer: null },
    { pkg: 'chalk', version: '5.3.0', auditor: 'github:alice', maintainer: 'github:chalk-owner' },
  ],
}

describe('writeAccruals', () => {
  test('a paid lockfile call of 20,000 microUSDC accrues exactly 10,000 / 4,000 / 3,000 across the three roles', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-1')
    const rows = getAccrualsForTxid('TXID-1')

    const byRole = new Map<string, number>()
    for (const row of rows) byRole.set(row.role, (byRole.get(row.role) ?? 0) + row.amount_micro)

    expect(byRole.get('auditor')).toBe(10000)
    expect(byRole.get('maintainer')).toBe(4000)
    expect(byRole.get('reviewer')).toBe(3000)

    const total = rows.reduce((s, r) => s + r.amount_micro, 0)
    expect(total).toBe(17000) // 10,000 + 4,000 + 3,000; the ledgered 850/1000 of 20,000
  })

  test('replaying the same settle_txid writes no second accrual: row count and total unchanged', () => {
    const firstWritten = writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-REPLAY')
    expect(firstWritten).toBe(9) // 3 roles x 3 packages

    const before = getAccrualsForTxid('TXID-REPLAY')
    const totalBefore = before.reduce((s, r) => s + r.amount_micro, 0)
    expect(before).toHaveLength(9)

    const secondWritten = writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-REPLAY')
    expect(secondWritten).toBe(0)

    const after = getAccrualsForTxid('TXID-REPLAY')
    const totalAfter = after.reduce((s, r) => s + r.amount_micro, 0)
    expect(after).toHaveLength(9)
    expect(totalAfter).toBe(totalBefore)
    expect(accrualCountForTxid('TXID-REPLAY')).toBe(9)
  })

  test('a free request (priceMicro 0) writes no accrual at all', () => {
    const freeAttribution: Attribution = { route: 'lockfile', priceMicro: 0, packages: [] }
    const written = writeAccruals(freeAttribution, 'TXID-FREE')
    expect(written).toBe(0)
    expect(getAccrualsForTxid('TXID-FREE')).toHaveLength(0)
  })

  test('single-attest route: 100% goes to that one package, identity github:alice for auditor', () => {
    const attribution: Attribution = {
      route: 'single-attest',
      priceMicro: 1000,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:ms-owner' },
      ],
    }
    writeAccruals(attribution, 'TXID-SINGLE')
    const rows = getAccrualsForTxid('TXID-SINGLE')
    const auditorRow = rows.find((r) => r.role === 'auditor')
    expect(auditorRow?.identity).toBe('github:alice')
    expect(auditorRow?.amount_micro).toBe(500)
  })
})

describe('getEarningsForLogin', () => {
  test('reports accrued totals per role for a login', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-EARN')
    const earnings = getEarningsForLogin('alice')
    expect(earnings.identity).toBe('github:alice')
    const auditorRole = earnings.roles.find((r) => r.role === 'auditor')
    // alice audited ms and chalk: 2 of the 3 packages' auditor shares
    expect(auditorRole?.accruedMicro).toBeGreaterThan(0)
    expect(earnings.totalAccruedMicro).toBe(auditorRole?.accruedMicro)
    expect(earnings.totalClaimedMicro).toBe(0)
  })

  test("never exposes another identity's data: querying alice does not return bob's accrual", () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-EARN-2')
    // alice audited 2 of the 3 packages (ms, chalk); bob audited 1 (lodash).
    const alice = getEarningsForLogin('alice')
    const bob = getEarningsForLogin('bob')
    const aliceAuditor = alice.roles.find((r) => r.role === 'auditor')?.accruedMicro ?? 0
    const bobAuditor = bob.roles.find((r) => r.role === 'auditor')?.accruedMicro ?? 0
    expect(aliceAuditor).toBeGreaterThan(0)
    expect(bobAuditor).toBeGreaterThan(0)
    expect(aliceAuditor).not.toBe(bobAuditor)
    expect(aliceAuditor + bobAuditor).toBe(10000) // the whole auditor share, split between only these two
  })

  test('claimed totals reflect recorded payouts', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-EARN-3')
    recordPayout('github:alice', 'auditor', 1000, 'PAYOUT-TX-1')
    const earnings = getEarningsForLogin('alice')
    const auditorRole = earnings.roles.find((r) => r.role === 'auditor')
    expect(auditorRole?.claimedMicro).toBe(1000)
  })
})

describe('identity canonicalisation', () => {
  const MIXED_CASE_ATTRIBUTION: Attribution = {
    route: 'single-attest',
    priceMicro: 1000,
    packages: [
      { pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: 'github:ms-owner' },
    ],
  }

  test('an accrual for reviewer alice resolves to github:alice; earnings reports the exact accrued amount', () => {
    // The accrual identity is built from a reviewer login stored elsewhere
    // as `github:alice` — lower-case, as `resolveAuditorIdentity` resolves it.
    writeAccruals(MIXED_CASE_ATTRIBUTION, 'TXID-CANON-1')

    const earnings = getEarningsForLogin('Alice')
    expect(earnings.identity).toBe('github:alice')
    const auditorRole = earnings.roles.find((r) => r.role === 'auditor')
    expect(auditorRole?.accruedMicro).toBe(500)
    expect(earnings.totalAccruedMicro).toBe(500)
  })

  test('getEarningsForLogin is case-insensitive: an accrual for github:Alice is found under both alice and ALICE', () => {
    const attribution: Attribution = {
      route: 'single-attest',
      priceMicro: 1000,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:Alice', maintainer: 'github:ms-owner' },
      ],
    }
    writeAccruals(attribution, 'TXID-CANON-2')

    const lower = getEarningsForLogin('alice')
    const upper = getEarningsForLogin('ALICE')

    expect(lower.identity).toBe('github:alice')
    expect(upper.identity).toBe('github:alice')
    expect(lower.roles.find((r) => r.role === 'auditor')?.accruedMicro).toBe(500)
    expect(upper.roles.find((r) => r.role === 'auditor')?.accruedMicro).toBe(500)
    expect(lower.totalAccruedMicro).toBe(500)
    expect(upper.totalAccruedMicro).toBe(500)
  })
})
