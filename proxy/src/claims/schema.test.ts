// proxy/src/claims/schema.test.ts
//
// The boot upgrade of the batch tables. Runs on private
// in-memory databases built with the pre-upgrade shape.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-claims-schema-test-${randomUUID()}.db`)

const { upgradeBatchSchema, upgradePoolSchema } = await import('./schema.js')

const APP = 4242

function oldShapeDb(): Database.Database {
  const handle = new Database(':memory:')
  handle.exec(`
    CREATE TABLE accruals (
      settle_txid TEXT NOT NULL, route TEXT NOT NULL, pkg TEXT NOT NULL,
      version TEXT NOT NULL, role TEXT NOT NULL, identity TEXT NOT NULL,
      amount_micro INTEGER NOT NULL, created_at INTEGER NOT NULL, repo TEXT,
      batch_seq INTEGER,
      PRIMARY KEY (settle_txid, role, pkg, version)
    );
    CREATE TABLE batches (
      batch_seq INTEGER PRIMARY KEY, attributed_micro INTEGER NOT NULL,
      unattributed_micro INTEGER NOT NULL, credit_txid TEXT, created_at INTEGER NOT NULL
    );
    INSERT INTO batches VALUES (1, 1000, 0, 'TX1', 10), (2, 2000, 500, NULL, 20);
    INSERT INTO accruals VALUES
      ('S1', 'single', 'a', '1.0.0', 'auditor', 'github:x', 300, 1, 'o/a', 1),
      ('S1', 'single', 'a', '1.0.0', 'ops', 'ops', 700, 1, 'o/a', 1),
      ('S2', 'single', 'b', '1.0.0', 'auditor', 'github:y', 300, 2, 'o/b', 2),
      ('S3', 'single', 'c', '1.0.0', 'auditor', 'github:z', 300, 3, 'o/c', NULL);
  `)
  return handle
}

function snapshot(handle: Database.Database) {
  return {
    batches: handle.prepare('SELECT * FROM batches ORDER BY batch_seq').all(),
    accruals: handle
      .prepare('SELECT settle_txid, role, batch_app_id, batch_seq FROM accruals ORDER BY 1, 2')
      .all(),
  }
}

describe('upgradeBatchSchema', () => {
  let handle: Database.Database
  beforeEach(() => {
    handle = oldShapeDb()
  })

  test('keeps every row and assigns the configured app id', () => {
    upgradeBatchSchema(handle, APP)

    const { batches, accruals } = snapshot(handle)
    expect(batches).toEqual([
      {
        app_id: APP,
        batch_seq: 1,
        attributed_micro: 1000,
        unattributed_micro: 0,
        credit_txid: 'TX1',
        created_at: 10,
      },
      {
        app_id: APP,
        batch_seq: 2,
        attributed_micro: 2000,
        unattributed_micro: 500,
        credit_txid: null,
        created_at: 20,
      },
    ])
    expect(accruals).toEqual([
      { settle_txid: 'S1', role: 'auditor', batch_app_id: APP, batch_seq: 1 },
      { settle_txid: 'S1', role: 'ops', batch_app_id: APP, batch_seq: 1 },
      { settle_txid: 'S2', role: 'auditor', batch_app_id: APP, batch_seq: 2 },
      { settle_txid: 'S3', role: 'auditor', batch_app_id: null, batch_seq: null },
    ])
  })

  test('a second run changes nothing', () => {
    upgradeBatchSchema(handle, APP)
    const first = snapshot(handle)

    upgradeBatchSchema(handle, APP)
    upgradeBatchSchema(handle, 1)

    expect(snapshot(handle)).toEqual(first)
  })

  test('the new key allows the same batch_seq for two apps', () => {
    upgradeBatchSchema(handle, APP)
    const insert = handle.prepare(
      'INSERT INTO batches (app_id, batch_seq, attributed_micro, unattributed_micro, created_at) ' +
        'VALUES (?, 1, 0, 0, 1)',
    )

    expect(() => insert.run(7)).not.toThrow()
    expect(() => insert.run(APP)).toThrow(/UNIQUE|PRIMARY/)
  })

  test('old batches and no configured app: throws and leaves the old tables intact', () => {
    expect(() => upgradeBatchSchema(handle, null)).toThrow(/PAYMENT_ROUTER_APP_ID is unset/)

    const names = (handle.prepare('PRAGMA table_info(batches)').all() as { name: string }[]).map(
      (c) => c.name,
    )
    expect(names).not.toContain('app_id')
    expect(handle.prepare('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: 2 })
  })

  test('an empty old batches table upgrades without a configured app', () => {
    handle.exec('DELETE FROM batches; DELETE FROM accruals')

    upgradeBatchSchema(handle, null)

    expect(snapshot(handle)).toEqual({ batches: [], accruals: [] })
  })
})

describe('upgradePoolSchema', () => {
  let handle: Database.Database
  beforeEach(() => {
    handle = oldShapeDb()
    upgradeBatchSchema(handle, APP)
  })

  const columns = (table: string) =>
    (handle.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name)

  test('an accrual that no batch credited yet: throws and changes nothing', () => {
    expect(() => upgradePoolSchema(handle)).toThrow(/1 accrual row\(s\) are not credited yet/)
    expect(columns('accruals')).not.toContain('unlock_at')
    expect(columns('batches')).toContain('attributed_micro')
    expect(handle.prepare('SELECT COUNT(*) AS n FROM accruals').get()).toEqual({ n: 4 })
  })

  test('keeps every row; the old credit becomes the payout pointer; new columns take defaults', () => {
    handle.exec('DELETE FROM accruals WHERE batch_seq IS NULL')
    upgradePoolSchema(handle)

    const rows = handle
      .prepare(
        `SELECT settle_txid, role, identity, amount_micro, batch_app_id, batch_seq,
                paid_app_id, paid_seq, unlock_at, frozen, treasury_kind
         FROM accruals ORDER BY 1, 2`,
      )
      .all()
    const base = { unlock_at: 0, frozen: 0, treasury_kind: null }
    expect(rows).toEqual([
      {
        settle_txid: 'S1',
        role: 'auditor',
        identity: 'github:x',
        amount_micro: 300,
        batch_app_id: APP,
        batch_seq: 1,
        paid_app_id: APP,
        paid_seq: 1,
        ...base,
      },
      {
        settle_txid: 'S1',
        role: 'ops',
        identity: 'ops',
        amount_micro: 700,
        batch_app_id: APP,
        batch_seq: 1,
        paid_app_id: APP,
        paid_seq: 1,
        ...base,
      },
      {
        settle_txid: 'S2',
        role: 'auditor',
        identity: 'github:y',
        amount_micro: 300,
        batch_app_id: APP,
        batch_seq: 2,
        paid_app_id: APP,
        paid_seq: 2,
        ...base,
      },
    ])
  })

  test('batches: attributed_micro becomes new_total_micro, treasury_extra_micro is added with 0', () => {
    handle.exec('DELETE FROM accruals WHERE batch_seq IS NULL')
    upgradePoolSchema(handle)

    expect(columns('batches')).toContain('new_total_micro')
    expect(columns('batches')).not.toContain('attributed_micro')
    expect(
      handle
        .prepare('SELECT batch_seq, new_total_micro, treasury_extra_micro FROM batches ORDER BY 1')
        .all(),
    ).toEqual([
      { batch_seq: 1, new_total_micro: 1000, treasury_extra_micro: 0 },
      { batch_seq: 2, new_total_micro: 2000, treasury_extra_micro: 0 },
    ])
  })

  test('the new primary key allows two reviewers on one payment; a second run changes nothing', () => {
    handle.exec('DELETE FROM accruals WHERE batch_seq IS NULL')
    upgradePoolSchema(handle)
    const before = handle.prepare('SELECT * FROM accruals ORDER BY 1, 2, 5').all()

    upgradePoolSchema(handle)

    expect(handle.prepare('SELECT * FROM accruals ORDER BY 1, 2, 5').all()).toEqual(before)
    const insert = handle.prepare(
      `INSERT INTO accruals (settle_txid, route, pkg, version, repo, role, identity,
                            amount_micro, created_at)
       VALUES ('S9', 'single', 'a', '1.0.0', 'o/a', 'reviewer', ?, 200, 9)`,
    )
    expect(() => insert.run('github:a')).not.toThrow()
    expect(() => insert.run('github:b')).not.toThrow()
    expect(() => insert.run('github:b')).toThrow(/UNIQUE|PRIMARY/)
  })

  test('an empty database upgrades', () => {
    handle.exec('DELETE FROM batches; DELETE FROM accruals')
    expect(() => upgradePoolSchema(handle)).not.toThrow()
    expect(columns('accruals')).toContain('paid_seq')
  })
})
