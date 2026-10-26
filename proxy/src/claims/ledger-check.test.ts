// proxy/src/claims/ledger-check.test.ts
//
// The comparison is pure. The reader tests use their own SQLite file via
// SQLITE_PATH, set before the dynamic import below. No test touches a network.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-ledger-check-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { batchTotalOf, compareLedger, readLedgerSide } = await import('./ledger-check.js')
type LedgerBatch = import('./ledger-check.js').LedgerBatch
type RouterTotals = import('./ledger-check.js').RouterTotals

// One batch of 10,000: ops 500, cut 2,000, pool part 7,500.
const BATCH: LedgerBatch = {
  newTotalMicro: 10_000,
  unattributedMicro: 3_000,
  treasuryExtraMicro: 500,
  payoutsMicro: 4_000,
}

// Carry-in 1,000: pin = 1,000 + 7,500, pot = 4,500, dct = 1,000 + 13,000,
// pdt = 500 + 2,000 + 500 + 3,000 + 4,000. The payTo balance holds 100 more.
function matchingChain(): RouterTotals {
  return { pin: 8_500n, pot: 4_500n, dct: 14_000n, pdt: 10_000n, payToBalance: 4_100n }
}

describe('batchTotalOf', () => {
  test('adds ops, cut, treasury extra, unattributed and payouts', () => {
    expect(batchTotalOf(BATCH)).toBe(10_000n)
  })

  test('floors the ops and cut shares', () => {
    const odd = { ...BATCH, newTotalMicro: 1_999, unattributedMicro: 0 }
    expect(batchTotalOf(odd)).toBe(99n + 399n + 500n + 4_000n)
  })
})

describe('compareLedger', () => {
  test('a matching ledger has no mismatch', () => {
    const result = compareLedger([BATCH], 0, matchingChain())
    expect(result.mismatches).toEqual([])
  })

  test('a different pot is a mismatch with both values', () => {
    const result = compareLedger([BATCH], 0, { ...matchingChain(), pot: 4_501n })
    expect(result.mismatches).toEqual(['pot chain=4501 ledger=4500'])
  })

  test('a different pdt is a mismatch with both values', () => {
    const result = compareLedger([BATCH], 0, { ...matchingChain(), pdt: 9_999n })
    expect(result.mismatches).toEqual(['pdt chain=9999 ledger=10000'])
  })

  test('two carry-in values that differ are a mismatch', () => {
    const result = compareLedger([BATCH], 0, { ...matchingChain(), pin: 8_600n })
    expect(result.mismatches).toEqual(['carry-in by dct=1000 by pin=1100'])
  })

  test('the ledger expecting more than payTo holds is an excess', () => {
    // chainUndeclared = balance - (dct - pdt) = 4,100 - 4,000 = 100
    const result = compareLedger([BATCH], 250, matchingChain())
    expect(result.excessMicro).toBe(150n)
    expect(result.gapMicro).toBe(0n)
  })

  test('payTo holding more than the ledger expects is a gap, not an excess', () => {
    const result = compareLedger([BATCH], 40, matchingChain())
    expect(result.excessMicro).toBe(0n)
    expect(result.gapMicro).toBe(60n)
  })
})

describe('readLedgerSide', () => {
  beforeEach(() => {
    db.exec('DELETE FROM accruals')
    db.exec('DELETE FROM batches')
    db.exec('DELETE FROM batch_payouts')
  })

  const insertBatch = (seq: number, txid: string | null, appId = 7): void => {
    db.prepare(
      `INSERT INTO batches (app_id, batch_seq, new_total_micro, unattributed_micro,
                            treasury_extra_micro, credit_txid, created_at)
       VALUES (?, ?, 10000, 3000, 500, ?, 0)`,
    ).run(appId, seq, txid)
    db.prepare(
      `INSERT INTO batch_payouts (app_id, batch_seq, identity, address, amount_micro)
       VALUES (?, ?, 'id:github:a', 'ADDR', 4000)`,
    ).run(appId, seq)
  }

  test('a batch without a credit txid is not read', () => {
    insertBatch(1, 'TXID-1')
    insertBatch(2, null)
    expect(readLedgerSide(7).batches).toEqual([BATCH])
  })

  test('a batch of another app is not read', () => {
    insertBatch(1, 'TXID-1', 8)
    expect(readLedgerSide(7).batches).toEqual([])
  })

  test('sums the accruals that no batch counted', () => {
    const insert = db.prepare(
      `INSERT INTO accruals (settle_txid, route, pkg, version, role, identity,
                            amount_micro, created_at, batch_app_id, batch_seq)
       VALUES (?, 'single-attest', 'p', '1.0.0', 'ops', 'ops', ?, 0, ?, ?)`,
    )
    insert.run('A', 50, null, null)
    insert.run('B', 200, null, null)
    insert.run('C', 999, 7, 1)
    expect(readLedgerSide(7).unbatchedMicro).toBe(250)
  })
})
