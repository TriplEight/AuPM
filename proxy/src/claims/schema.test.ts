// proxy/src/claims/schema.test.ts
//
// The boot upgrade of the batch tables (ADR 0014). Runs on private
// in-memory databases built with the pre-upgrade shape.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-claims-schema-test-${randomUUID()}.db`)

const { upgradeBatchSchema } = await import('./schema.js')

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
