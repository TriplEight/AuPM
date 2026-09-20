// proxy/src/claims/reconcile.test.ts
//
// CAUTION: `stubIndexerClient` performs no network I/O — no test here
// reaches an indexer.
//
// This file gets its own SQLite file via SQLITE_PATH, set before the
// dynamic import below (same trick as proxy/src/app.test.ts and this
// directory's ledger.test.ts) — the accruals table is shared across
// several test files here, so per-file isolation stops vitest's parallel
// test files from racing on the same physical database.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-claims-reconcile-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { writeAccruals } = await import('./ledger.js')
const { findUnmatchedInflows, reconcile } = await import('./reconcile.js')
type Attribution = import('./attribution-rules.js').Attribution
type IndexerClient = import('./reconcile.js').IndexerClient
type UsdcInflow = import('./reconcile.js').UsdcInflow

beforeEach(() => {
  db.exec('DELETE FROM accruals')
})

function stubIndexerClient(inflows: UsdcInflow[]): IndexerClient {
  return { listUsdcInflows: async () => inflows }
}

describe('findUnmatchedInflows', () => {
  test('an inflow already ledgered by a normal settlement is not unmatched', () => {
    const attribution: Attribution = {
      route: 'single-attest',
      priceMicro: 1000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice', maintainer: null }],
    }
    writeAccruals(attribution, 'TXID-MATCHED')
    const unmatched = findUnmatchedInflows([
      { txid: 'TXID-MATCHED', amountMicro: 1000 },
      { txid: 'TXID-DIRECT-DEPOSIT', amountMicro: 2000 },
    ])
    expect(unmatched.map((u) => u.txid)).toEqual(['TXID-DIRECT-DEPOSIT'])
  })
})

describe('reconcile', () => {
  test('ledgers an unmatched inflow as unassigned across the three roles', async () => {
    const indexer = stubIndexerClient([{ txid: 'TXID-UNMATCHED-1', amountMicro: 20000 }])
    const result = await reconcile('PAYTOADDR', indexer)
    expect(result.inflowsChecked).toBe(1)
    expect(result.unmatchedLedgered).toBe(1)

    const rows = db
      .prepare('SELECT role, identity, amount_micro FROM accruals WHERE settle_txid = ?')
      .all('TXID-UNMATCHED-1') as Array<{ role: string; identity: string; amount_micro: number }>
    expect(rows).toHaveLength(3)
    for (const row of rows) expect(row.identity).toBe('unassigned')
    const total = rows.reduce((s, r) => s + r.amount_micro, 0)
    expect(total).toBe(17000)
  })

  test('re-running reconcile over the same inflow ledgers nothing new (idempotent)', async () => {
    const indexer = stubIndexerClient([{ txid: 'TXID-UNMATCHED-2', amountMicro: 1000 }])
    await reconcile('PAYTOADDR', indexer)
    const second = await reconcile('PAYTOADDR', indexer)
    expect(second.unmatchedLedgered).toBe(0)
  })

  test('unmatchedLedgered counts only inflows actually written; a skipped non-multiple is reported separately', async () => {
    const indexer = stubIndexerClient([
      { txid: 'TXID-GOOD', amountMicro: 3000 },
      { txid: 'TXID-BAD-NOT-MULTIPLE', amountMicro: 1500 },
    ])
    const result = await reconcile('PAYTOADDR', indexer)

    expect(result.inflowsChecked).toBe(2)
    expect(result.unmatchedLedgered).toBe(1)
    expect(result.skipped).toHaveLength(1)
    expect(result.skipped[0]?.inflow.txid).toBe('TXID-BAD-NOT-MULTIPLE')
    expect(result.skipped[0]?.reason).toBe('not-a-multiple-of-1000-microusdc')

    // The skipped inflow wrote no accrual row at all.
    const rows = db
      .prepare('SELECT * FROM accruals WHERE settle_txid = ?')
      .all('TXID-BAD-NOT-MULTIPLE')
    expect(rows).toHaveLength(0)
  })

  test('a skipped non-multiple is re-reported on every run, not silently dropped', async () => {
    const indexer = stubIndexerClient([{ txid: 'TXID-STUCK', amountMicro: 1500 }])
    const first = await reconcile('PAYTOADDR', indexer)
    const second = await reconcile('PAYTOADDR', indexer)

    expect(first.unmatchedLedgered).toBe(0)
    expect(first.skipped.map((s) => s.inflow.txid)).toEqual(['TXID-STUCK'])
    expect(second.unmatchedLedgered).toBe(0)
    expect(second.skipped.map((s) => s.inflow.txid)).toEqual(['TXID-STUCK'])
  })
})
