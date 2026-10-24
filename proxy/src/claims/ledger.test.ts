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
  getPayee,
  groupForCredit,
  listBatchPayouts,
  listCreditCandidates,
  listPayeeBalances,
  listPayees,
  matureUnpaidTotal,
  openBatch,
  recordBatchCreditTxid,
  releaseBatch,
  recordBacklog,
  releaseShares,
  slashShares,
  touchPayeeOptInCheck,
  upsertPayee,
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
  db.exec('DELETE FROM batch_payouts')
  db.exec('DELETE FROM payees')
  db.exec('DELETE FROM backlog_days')
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
    expect(earnings.roles).toEqual([{ role: 'reviewer', accruedMicro: 800 }])
    expect(earnings.totalAccruedMicro).toBe(800)
  })

  test("never exposes another identity's data", () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-EARN-2', NOW, HOLD)
    expect(getEarningsForLogin('alice').totalAccruedMicro).toBe(800)
    expect(getEarningsForLogin('bob').totalAccruedMicro).toBe(400)
  })

  test('an unknown login reports zeros, no payout address and null times', () => {
    expect(getEarningsForLogin('nobody', NOW)).toEqual({
      identity: 'github:nobody',
      roles: [],
      totalAccruedMicro: 0,
      heldMicro: 0,
      maturedUnpaidMicro: 0,
      frozenMicro: 0,
      paidMicro: 0,
      payoutAddressSet: false,
      lastOptinCheckAt: null,
      lastPayoutAt: null,
    })
  })

  test('a share is held one millisecond before unlock_at and matured at unlock_at', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-EDGE', NOW, HOLD)
    const before = getEarningsForLogin('alice', NOW + HOLD - 1)
    expect(before.heldMicro).toBe(400)
    expect(before.maturedUnpaidMicro).toBe(0)
    const at = getEarningsForLogin('alice', NOW + HOLD)
    expect(at.heldMicro).toBe(0)
    expect(at.maturedUnpaidMicro).toBe(400)
  })

  test('a frozen share counts as frozen, not as held or matured', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-FROZEN', NOW, HOLD)
    freezeShares({ pkg: 'ms', version: '2.1.3', role: 'reviewer' }, NOW)
    const earnings = getEarningsForLogin('alice', NOW + HOLD + 1)
    expect(earnings.frozenMicro).toBe(400)
    expect(earnings.heldMicro).toBe(0)
    expect(earnings.maturedUnpaidMicro).toBe(0)
  })

  test('a share credited by a confirmed batch counts as paid only', () => {
    upsertPayee('github:alice', 'ALICE-ADDR', 0, 55)
    writeAccruals(SINGLE_ALICE, 'TXID-PAID', NOW, HOLD)
    const rows = listCreditCandidates()
    openBatch(APP, 1, {
      counted: rows,
      paid: rows.filter((r) => r.role === 'reviewer'),
      addresses: { 'github:alice': 'ALICE-ADDR' },
    })
    const now = NOW + HOLD
    const pending = getEarningsForLogin('alice', now)
    expect(pending.paidMicro).toBe(0)
    recordBatchCreditTxid(APP, 1, 'CREDIT-TXID', 4242)
    const paid = getEarningsForLogin('alice', now)
    expect(paid.paidMicro).toBe(400)
    expect(paid.maturedUnpaidMicro).toBe(0)
    expect(paid.heldMicro).toBe(0)
    expect(paid.lastPayoutAt).toBe(4242)
  })

  test('reports the payout address as set and the opt-in check time, never the address', () => {
    upsertPayee('github:alice', 'ALICE-ADDR', 0, 0)
    expect(getEarningsForLogin('alice', NOW)).toMatchObject({
      payoutAddressSet: true,
      lastOptinCheckAt: null,
    })
    touchPayeeOptInCheck('github:alice', 77)
    expect(getEarningsForLogin('alice', NOW).lastOptinCheckAt).toBe(77)
    expect(JSON.stringify(getEarningsForLogin('alice', NOW))).not.toContain('ALICE-ADDR')
  })

  test('is case-insensitive and skips a slashed share', () => {
    writeAccruals(
      { ...SINGLE_ALICE, packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:Alice' }] },
      'TXID-CANON',
      NOW,
      HOLD,
    )
    expect(getEarningsForLogin('ALICE').totalAccruedMicro).toBe(400)
    freezeShares({ pkg: 'ms', version: '2.1.3', role: 'reviewer' }, NOW)
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
      addresses: { 'github:alice': 'ALICE-ADDR' },
    })

    expect(totals.newTotalMicro).toBe(1000)
    expect(totals.unattributedMicro).toBe(0)
    expect(totals.treasuryExtraMicro).toBe(0)
    expect(totals.payouts).toEqual([
      { identity: 'github:alice', address: 'ALICE-ADDR', amountMicro: 400 },
    ])
    expect(listBatchPayouts(APP, 1)).toEqual(totals.payouts)
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
    freezeShares({ pkg: 'ms', version: '2.1.3', role: 'reviewer' }, NOW)
    const reviewer = listCreditCandidates().filter((r) => r.role === 'reviewer')
    expect(() =>
      openBatch(APP, 1, { counted: [], paid: reviewer, addresses: { 'github:alice': 'A' } }),
    ).toThrow(/frozen/)
    expect(countBatches()).toEqual({ n: 0 })
  })
})

describe('releaseBatch', () => {
  const countBatches = () => db.prepare('SELECT COUNT(*) AS n FROM batches').get()

  test('a pending batch: its rows return to uncounted and uncredited, its batch row is deleted', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-RELEASE', NOW, HOLD)
    const rows = listCreditCandidates()
    openBatch(APP, 1, {
      counted: rows,
      paid: rows.filter((r) => r.role === 'reviewer'),
      addresses: { 'github:alice': 'ALICE-ADDR', 'github:bob': 'BOB-ADDR' },
    })

    releaseBatch(APP, 1)

    expect(countBatches()).toEqual({ n: 0 })
    expect(listBatchPayouts(APP, 1)).toEqual([])
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
  test('sums payouts per payee and keeps treasury kinds out of payouts', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-GROUP', NOW, HOLD)
    const rows = listCreditCandidates()
    const totals = groupForCredit({
      counted: rows,
      paid: rows.filter((r) => ['reviewer', 'contributor', 'maintainer'].includes(r.role)),
      addresses: { 'github:alice': 'ALICE-ADDR', 'github:bob': 'BOB-ADDR' },
    })
    expect(totals.newTotalMicro).toBe(3000)
    expect(totals.treasuryExtraMicro).toBe(3 * (100 + 250))
    expect(totals.payouts).toEqual(
      expect.arrayContaining([
        { identity: 'github:alice', address: 'ALICE-ADDR', amountMicro: 800 },
        { identity: 'github:bob', address: 'BOB-ADDR', amountMicro: 400 },
      ]),
    )
    expect(totals.payouts).toHaveLength(2)
  })

  test('a payee without an address in the plan throws', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-NOADDR', NOW, HOLD)
    const paid = listCreditCandidates().filter((r) => r.role === 'reviewer')
    expect(() => groupForCredit({ counted: [], paid })).toThrow(/no payout address/)
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
    expect(freezeShares({ ...MS, role: 'reviewer' }, NOW)).toBe(1)
    expect(stateOf('reviewer')).toEqual([[1, null, NOW + HOLD]])
    expect(stateOf('ops')).toEqual([[0, null, 0]])
    expect(stateOf('maintainer')).toEqual([[0, 'unallocated', NOW + HOLD]])
    expect(freezeShares({ ...MS, role: 'reviewer' }, NOW)).toBe(0)
  })

  test('freeze can target one identity', () => {
    expect(freezeShares({ ...MS, role: 'reviewer', identity: 'github:bob' }, NOW)).toBe(0)
    expect(freezeShares({ ...MS, role: 'reviewer', identity: 'GitHub:Alice' }, NOW)).toBe(1)
  })

  test('freeze of another version touches nothing', () => {
    expect(freezeShares({ pkg: 'ms', version: '9.9.9', role: 'reviewer' }, NOW)).toBe(0)
  })

  test('release unfreezes and keeps the unlock time', () => {
    freezeShares({ ...MS, role: 'reviewer' }, NOW)
    expect(releaseShares({ ...MS, role: 'reviewer' })).toBe(1)
    expect(stateOf('reviewer')).toEqual([[0, null, NOW + HOLD]])
    expect(releaseShares({ ...MS, role: 'reviewer' })).toBe(0)
  })

  test('slash moves a frozen reviewer share to treasury kind slash, with no hold', () => {
    freezeShares({ ...MS, role: 'reviewer' }, NOW)
    expect(slashShares(MS)).toBe(1)
    expect(stateOf('reviewer')).toEqual([[0, 'slash', 0]])
  })

  test('forfeit moves a frozen maintainer share to treasury kind forfeit, with no hold', () => {
    // The maintainer share has no payee today, so give it one.
    db.prepare(
      "UPDATE accruals SET identity = 'github:carol', treasury_kind = NULL WHERE role = 'maintainer'",
    ).run()
    freezeShares({ ...MS, role: 'maintainer' }, NOW)
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
    openBatch(APP, 1, { counted: [], paid: reviewer, addresses: { 'github:alice': 'A' } })
    expect(freezeShares({ ...MS, role: 'reviewer' }, NOW)).toBe(0)
    expect(slashShares(MS)).toBe(0)
  })

  test('freeze rejects a role that has no pool share', () => {
    expect(() => freezeShares({ ...MS, role: 'ops' as never }, NOW)).toThrow(/role must be one of/)
  })
})

describe('freeze after the hold ends', () => {
  const MS = { pkg: 'ms', version: '2.1.3' }

  beforeEach(() => {
    writeAccruals(SINGLE_ALICE, 'TXID-AFTER-H', NOW, HOLD)
  })

  test('a freeze at or after the unlock time does not touch a matured share', () => {
    expect(freezeShares({ ...MS, role: 'reviewer' }, NOW + HOLD)).toBe(0)
    expect(freezeShares({ ...MS, role: 'reviewer' }, NOW + HOLD + 1)).toBe(0)
    const reviewer = getAccrualsForTxid('TXID-AFTER-H').find((r) => r.role === 'reviewer')
    expect(reviewer?.frozen).toBe(0)
  })

  test('a freeze one millisecond before the unlock time still holds the share', () => {
    expect(freezeShares({ ...MS, role: 'reviewer' }, NOW + HOLD - 1)).toBe(1)
  })

  test('a share frozen before the hold ends stays frozen after it, and a release works', () => {
    freezeShares({ ...MS, role: 'reviewer' }, NOW)
    expect(listPayeeBalances(NOW + HOLD + 1)).toEqual([])
    expect(releaseShares({ ...MS, role: 'reviewer' })).toBe(1)
    expect(listPayeeBalances(NOW + HOLD + 1)).toEqual([
      { identity: 'github:alice', balanceMicro: 400 },
    ])
  })
})

describe('payees', () => {
  test('upsert canonicalises the identity and reads back', () => {
    upsertPayee('GitHub:Alice', 'ADDR-1', 10, 20)
    expect(getPayee('github:alice')).toEqual({
      identity: 'github:alice',
      payout_address: 'ADDR-1',
      onboarded_at: 10,
      last_optin_check: 20,
      last_payout_at: null,
    })
  })

  test('a second upsert changes the address and keeps the onboarding date', () => {
    upsertPayee('github:alice', 'ADDR-1', 10, 20)
    upsertPayee('github:alice', 'ADDR-2', 99, 30)
    expect(getPayee('github:alice')).toMatchObject({
      payout_address: 'ADDR-2',
      onboarded_at: 10,
      last_optin_check: 30,
    })
    expect(listPayees()).toHaveLength(1)
  })

  test('the opt-in check time updates', () => {
    upsertPayee('github:alice', 'ADDR-1', 10, 20)
    touchPayeeOptInCheck('github:alice', 77)
    expect(getPayee('github:alice')?.last_optin_check).toBe(77)
  })

  test('a recorded credit txid stamps the paid payees and records their payouts', () => {
    upsertPayee('github:alice', 'ALICE-ADDR', 0, 0)
    upsertPayee('github:bob', 'BOB-ADDR', 0, 0)
    writeAccruals(SINGLE_ALICE, 'TXID-STAMP', NOW, HOLD)
    const rows = listCreditCandidates()
    openBatch(APP, 1, {
      counted: rows,
      paid: rows.filter((r) => r.role === 'reviewer'),
      addresses: { 'github:alice': 'ALICE-ADDR' },
    })
    recordBatchCreditTxid(APP, 1, 'CREDIT-TXID', 4242)

    expect(getPayee('github:alice')?.last_payout_at).toBe(4242)
    expect(getPayee('github:bob')?.last_payout_at).toBeNull()
    expect(getEarningsForLogin('alice', NOW).paidMicro).toBe(400)
  })
})

describe('listPayeeBalances', () => {
  test('counts only matured, unfrozen, unpaid payee shares, summed per payee', () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-BAL', NOW, HOLD)
    expect(listPayeeBalances(NOW + HOLD - 1)).toEqual([])
    expect(listPayeeBalances(NOW + HOLD)).toEqual([
      { identity: 'github:alice', balanceMicro: 800 },
      { identity: 'github:bob', balanceMicro: 400 },
    ])
    freezeShares({ pkg: 'lodash', version: '4.17.21', role: 'reviewer' }, NOW)
    expect(listPayeeBalances(NOW + HOLD)).toEqual([{ identity: 'github:alice', balanceMicro: 800 }])
    expect(matureUnpaidTotal(NOW + HOLD)).toBe(800)
  })

  test('a credited share leaves the balance', () => {
    writeAccruals(SINGLE_ALICE, 'TXID-BAL-PAID', NOW, HOLD)
    const reviewer = listCreditCandidates().filter((r) => r.role === 'reviewer')
    openBatch(APP, 1, { counted: [], paid: reviewer, addresses: { 'github:alice': 'A' } })
    expect(listPayeeBalances(NOW + HOLD)).toEqual([])
  })
})

describe('recordBacklog', () => {
  const DAY = 24 * 60 * 60 * 1000

  test('counts days of growth in a row, starting from a total of 0', () => {
    expect([100, 200, 300].map((total, i) => recordBacklog(total, i * DAY))).toEqual([1, 2, 3])
  })

  test('an equal or lower total resets the count to 0', () => {
    recordBacklog(100, 0)
    recordBacklog(200, DAY)
    expect(recordBacklog(200, 2 * DAY)).toBe(0)
    expect(recordBacklog(300, 3 * DAY)).toBe(1)
    expect(recordBacklog(100, 4 * DAY)).toBe(0)
  })

  test('a second record on the same day replaces the first', () => {
    recordBacklog(100, 0)
    expect(recordBacklog(150, DAY)).toBe(2)
    expect(recordBacklog(180, DAY + 1000)).toBe(2)
    expect(recordBacklog(50, DAY + 2000)).toBe(0)
  })

  test('a total of 0 on the first day is no growth', () => {
    expect(recordBacklog(0, 0)).toBe(0)
  })
})
