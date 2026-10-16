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

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-claims-ledger-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const {
  accrualCountForTxid,
  forfeitShares,
  freezeShares,
  getAccrualsForTxid,
  getEarningsForLogin,
  groupForCredit,
  listCreditCandidates,
  openBatch,
  recordBatchCreditTxid,
  recordPayout,
  releaseBatch,
  releaseShares,
  slashShares,
  summarizeBatch,
  writeAccruals,
} = await import('./ledger.js')
const { setStatus } = await import('../status.js')
type Attribution = import('./attribution-rules.js').Attribution
type AccrualRow = import('./schema.js').AccrualRow

const APP = 5
const NOW = 1_000_000
const HOLD = 5_000

beforeEach(() => {
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM batches')
  db.exec('DELETE FROM payouts')
  db.exec('DELETE FROM audit_status')
})

const LOCKFILE_ATTRIBUTION: Attribution = {
  route: 'lockfile',
  priceMicro: 3000,
  packages: [
    { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
    { pkg: 'lodash', version: '4.17.21', auditor: 'github:bob' },
    { pkg: 'chalk', version: '5.3.0', auditor: 'github:alice' },
  ],
}

const SINGLE_ALICE: Attribution = {
  route: 'single-attest',
  priceMicro: 1000,
  packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
}

function sumByRole(rows: AccrualRow[]): Map<string, number> {
  const byRole = new Map<string, number>()
  for (const row of rows) byRole.set(row.role, (byRole.get(row.role) ?? 0) + row.amount_micro)
  return byRole
}

describe('writeAccruals', () => {
  test('3 packages of 1,000 accrue cut 600, ops 150, reviewer 1,200, contributor 300, maintainer 750', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-1', NOW, HOLD)
    const rows = getAccrualsForTxid('TXID-1')
    const byRole = sumByRole(rows)

    expect(byRole.get('treasury')).toBe(600)
    expect(byRole.get('ops')).toBe(150)
    expect(byRole.get('reviewer')).toBe(1200)
    expect(byRole.get('contributor')).toBe(300)
    expect(byRole.get('maintainer')).toBe(750)
    expect(rows.reduce((s, r) => s + r.amount_micro, 0)).toBe(3000)
  })

  test('contributor and maintainer shares are treasury unallocated; cut is treasury cut', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-KINDS', NOW, HOLD)
    const kinds = getAccrualsForTxid('TXID-KINDS').map((r) => [r.role, r.identity, r.treasury_kind])
    expect(kinds).toEqual(
      expect.arrayContaining([
        ['treasury', 'treasury', 'cut'],
        ['ops', 'ops', null],
        ['reviewer', 'github:alice', null],
        ['contributor', 'treasury', 'unallocated'],
        ['maintainer', 'treasury', 'unallocated'],
      ]),
    )
  })

  test('pool shares unlock after the hold; cut and ops are not held', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-HOLD', NOW, HOLD)
    for (const row of getAccrualsForTxid('TXID-HOLD')) {
      const held = ['reviewer', 'contributor', 'maintainer'].includes(row.role)
      expect(row.unlock_at).toBe(held ? NOW + HOLD : 0)
      expect(row.frozen).toBe(0)
    }
  })

  test('replaying the same settle_txid writes no second accrual: row count and total unchanged', () => {
    const firstWritten = writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-REPLAY', NOW, HOLD)
    expect(firstWritten).toBe(15) // 5 rows x 3 packages

    const before = getAccrualsForTxid('TXID-REPLAY')
    const totalBefore = before.reduce((s, r) => s + r.amount_micro, 0)

    expect(writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-REPLAY', NOW, HOLD)).toBe(0)

    const after = getAccrualsForTxid('TXID-REPLAY')
    expect(after).toHaveLength(15)
    expect(after.reduce((s, r) => s + r.amount_micro, 0)).toBe(totalBefore)
    expect(accrualCountForTxid('TXID-REPLAY')).toBe(15)
  })

  test('a free request (priceMicro 0) writes no accrual at all', () => {
    const freeAttribution: Attribution = { route: 'lockfile', priceMicro: 0, packages: [] }
    expect(writeAccruals(freeAttribution, 'TXID-FREE')).toBe(0)
    expect(getAccrualsForTxid('TXID-FREE')).toHaveLength(0)
  })

  test('the default hold is 30 days', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-DEFAULT', NOW)
    const reviewer = getAccrualsForTxid('TXID-DEFAULT').find((r) => r.role === 'reviewer')
    expect(reviewer?.unlock_at).toBe(NOW + 30 * 24 * 60 * 60 * 1000)
  })
})

describe('writeAccruals: repo column', () => {
  test('every row of a reviewed package carries its stored repo key', () => {
    setStatus(
      'ms',
      '2.1.3',
      'COMMUNITY_REVIEWED',
      '0xAUD',
      'anchor-1',
      'sha512-x',
      'alice',
      'scope',
      'acme/ms',
    )
    writeAccruals(SINGLE_ALICE, 'TXID-REPO-1', NOW, HOLD)
    const rows = getAccrualsForTxid('TXID-REPO-1')
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(row.repo).toBe('acme/ms')
  })

  test("a package with no stored repo accrues with repo '', never a failed write", () => {
    const attribution: Attribution = {
      route: 'single-attest',
      priceMicro: 1000,
      packages: [{ pkg: 'unknown-pkg', version: '1.0.0', auditor: 'github:alice' }],
    }
    writeAccruals(attribution, 'TXID-REPO-2', NOW, HOLD)
    const rows = getAccrualsForTxid('TXID-REPO-2')
    expect(rows).toHaveLength(5)
    for (const row of rows) expect(row.repo).toBe('')
  })
})

describe('getEarningsForLogin', () => {
  test('reports accrued totals per role for a login', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-EARN', NOW, HOLD)
    const earnings = getEarningsForLogin('alice')
    expect(earnings.identity).toBe('github:alice')
    // alice reviewed ms and chalk: 2 reviewer lines of 400
    expect(earnings.roles).toEqual([{ role: 'reviewer', accruedMicro: 800, claimedMicro: 0 }])
    expect(earnings.totalAccruedMicro).toBe(800)
    expect(earnings.totalClaimedMicro).toBe(0)
  })

  test("never exposes another identity's data", () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-EARN-2', NOW, HOLD)
    expect(getEarningsForLogin('alice').totalAccruedMicro).toBe(800)
    expect(getEarningsForLogin('bob').totalAccruedMicro).toBe(400)
  })

  test('claimed totals reflect recorded payouts', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-EARN-3', NOW, HOLD)
    recordPayout('github:alice', 'reviewer', 1000, 'PAYOUT-TX-1')
    const role = getEarningsForLogin('alice').roles.find((r) => r.role === 'reviewer')
    expect(role?.claimedMicro).toBe(1000)
  })

  test('is case-insensitive and skips a slashed share', () => {
    writeAccruals(
      { ...SINGLE_ALICE, packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:Alice' }] },
      'TXID-CANON',
      NOW,
      HOLD,
    )
    expect(getEarningsForLogin('ALICE').totalAccruedMicro).toBe(400)
    freezeShares({ pkg: 'ms', version: '2.1.3', role: 'reviewer' })
    slashShares({ pkg: 'ms', version: '2.1.3' })
    expect(getEarningsForLogin('alice').totalAccruedMicro).toBe(0)
  })
})

describe('openBatch', () => {
  const countBatches = () => db.prepare('SELECT COUNT(*) AS n FROM batches').get()

  test('counts payments and credits shares, and stores the totals', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-OPEN', NOW, HOLD)
    const rows = listCreditCandidates()
    const msRows = rows.filter((r) => r.pkg === 'ms')

    const totals = openBatch(APP, 1, {
      counted: msRows,
      paid: msRows.filter((r) => r.role === 'reviewer'),
    })

    expect(totals.newTotalMicro).toBe(1000)
    expect(totals.unattributedMicro).toBe(0)
    expect(totals.treasuryExtraMicro).toBe(0)
    expect(totals.entries).toEqual([{ repo: '', identity: 'github:alice', amountMicro: 400 }])
    expect(summarizeBatch(APP, 1)).toEqual(totals.entries)
    expect(
      db
        .prepare(
          'SELECT new_total_micro, treasury_extra_micro FROM batches WHERE app_id = 5 AND batch_seq = 1',
        )
        .get(),
    ).toEqual({ new_total_micro: 1000, treasury_extra_micro: 0 })
  })

  test('a counted row is not counted twice: throws and writes nothing', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-TWICE', NOW, HOLD)
    const rows = listCreditCandidates()
    const msRows = rows.filter((r) => r.pkg === 'ms')
    openBatch(APP, 1, { counted: msRows, paid: [] })

    expect(() => openBatch(APP, 2, { counted: rows, paid: [] })).toThrow(
      /already counted; batch 2 was not opened/,
    )
    expect(countBatches()).toEqual({ n: 1 })
    expect(listCreditCandidates().filter((r) => r.batch_seq === null)).toHaveLength(
      rows.length - msRows.length,
    )
  })

  test('a frozen share cannot be credited', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-FROZEN', NOW, HOLD)
    freezeShares({ pkg: 'ms', version: '2.1.3', role: 'reviewer' })
    const reviewer = listCreditCandidates().filter((r) => r.role === 'reviewer')
    expect(() => openBatch(APP, 1, { counted: [], paid: reviewer })).toThrow(/frozen/)
    expect(countBatches()).toEqual({ n: 0 })
  })
})

describe('releaseBatch', () => {
  const countBatches = () => db.prepare('SELECT COUNT(*) AS n FROM batches').get()

  test('a pending batch: its rows return to uncounted and uncredited, its batch row is deleted', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-RELEASE', NOW, HOLD)
    const rows = listCreditCandidates()
    openBatch(APP, 1, { counted: rows, paid: rows.filter((r) => r.role === 'reviewer') })

    releaseBatch(APP, 1)

    expect(countBatches()).toEqual({ n: 0 })
    const after = listCreditCandidates()
    expect(after.every((r) => r.batch_seq === null && r.paid_seq === null)).toBe(true)
    expect(after).toHaveLength(rows.length)
  })

  test('a credited batch: throws and changes nothing', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-CREDITED', NOW, HOLD)
    openBatch(APP, 1, { counted: listCreditCandidates(), paid: [] })
    recordBatchCreditTxid(APP, 1, 'CREDIT-TXID')

    expect(() => releaseBatch(APP, 1)).toThrow(/batch 1 is missing or already credited/)
    expect(countBatches()).toEqual({ n: 1 })
  })

  test('a missing batch: throws', () => {
    expect(() => releaseBatch(APP, 7)).toThrow(/batch 7 is missing or already credited/)
  })
})

describe('groupForCredit', () => {
  test('sums entries per (repo, identity) and keeps treasury kinds out of entries', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-GROUP', NOW, HOLD)
    const rows = listCreditCandidates()
    const totals = groupForCredit({
      counted: rows,
      paid: rows.filter((r) => ['reviewer', 'contributor', 'maintainer'].includes(r.role)),
    })
    expect(totals.newTotalMicro).toBe(3000)
    expect(totals.treasuryExtraMicro).toBe(3 * (100 + 250))
    expect(totals.entries).toEqual(
      expect.arrayContaining([
        { repo: '', identity: 'github:alice', amountMicro: 800 },
        { repo: '', identity: 'github:bob', amountMicro: 400 },
      ]),
    )
    expect(totals.entries).toHaveLength(2)
  })
})

describe('freeze, release, slash, forfeit', () => {
  const MS = { pkg: 'ms', version: '2.1.3' }
  const stateOf = (role: string) =>
    getAccrualsForTxid('TXID-EVT')
      .filter((r) => r.role === role)
      .map((r) => [r.frozen, r.treasury_kind, r.unlock_at])

  beforeEach(() => {
    writeAccruals(SINGLE_ALICE, 'TXID-EVT', NOW, HOLD)
  })

  test('freeze marks only the uncredited payee shares of that role', () => {
    expect(freezeShares({ ...MS, role: 'reviewer' })).toBe(1)
    expect(stateOf('reviewer')).toEqual([[1, null, NOW + HOLD]])
    expect(stateOf('ops')).toEqual([[0, null, 0]])
    expect(stateOf('maintainer')).toEqual([[0, 'unallocated', NOW + HOLD]])
    expect(freezeShares({ ...MS, role: 'reviewer' })).toBe(0)
  })

  test('freeze can target one identity', () => {
    expect(freezeShares({ ...MS, role: 'reviewer', identity: 'github:bob' })).toBe(0)
    expect(freezeShares({ ...MS, role: 'reviewer', identity: 'GitHub:Alice' })).toBe(1)
  })

  test('freeze of another version touches nothing', () => {
    expect(freezeShares({ pkg: 'ms', version: '9.9.9', role: 'reviewer' })).toBe(0)
  })

  test('release unfreezes and keeps the unlock time', () => {
    freezeShares({ ...MS, role: 'reviewer' })
    expect(releaseShares({ ...MS, role: 'reviewer' })).toBe(1)
    expect(stateOf('reviewer')).toEqual([[0, null, NOW + HOLD]])
    expect(releaseShares({ ...MS, role: 'reviewer' })).toBe(0)
  })

  test('slash moves a frozen reviewer share to treasury kind slash, with no hold', () => {
    freezeShares({ ...MS, role: 'reviewer' })
    expect(slashShares(MS)).toBe(1)
    expect(stateOf('reviewer')).toEqual([[0, 'slash', 0]])
  })

  test('forfeit moves a frozen maintainer share to treasury kind forfeit, with no hold', () => {
    // The maintainer share has no payee today, so give it one.
    db.prepare(
      "UPDATE accruals SET identity = 'github:carol', treasury_kind = NULL WHERE role = 'maintainer'",
    ).run()
    freezeShares({ ...MS, role: 'maintainer' })
    expect(forfeitShares(MS)).toBe(1)
    expect(stateOf('maintainer')).toEqual([[0, 'forfeit', 0]])
  })

  test('slash and forfeit never touch a share that is not frozen', () => {
    expect(slashShares(MS)).toBe(0)
    expect(forfeitShares(MS)).toBe(0)
    expect(stateOf('reviewer')).toEqual([[0, null, NOW + HOLD]])
  })

  test('a credited share is out of reach of every event', () => {
    const reviewer = listCreditCandidates().filter((r) => r.role === 'reviewer')
    openBatch(APP, 1, { counted: [], paid: reviewer })
    expect(freezeShares({ ...MS, role: 'reviewer' })).toBe(0)
    expect(slashShares(MS)).toBe(0)
  })

  test('freeze rejects a role that has no pool share', () => {
    expect(() => freezeShares({ ...MS, role: 'ops' as never })).toThrow(/role must be one of/)
  })
})
