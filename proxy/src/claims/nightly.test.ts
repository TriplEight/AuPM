// proxy/src/claims/nightly.test.ts
//
// CAUTION: every test here stubs the indexer and the credit chain client
// (deps.backup is a plain function, never real VACUUM INTO/network I/O) —
// no test in this file performs a real network or chain call. This file
// gets its own SQLite file via SQLITE_PATH, set before the dynamic import
// below (same trick as this directory's other test files).
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test, vi } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-claims-nightly-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { runNightly } = await import('./nightly.js')
type IndexerClient = import('./reconcile.js').IndexerClient
type CreditChainClient = import('./credit.js').CreditChainClient

const PAY_TO = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function emptyIndexer(): IndexerClient {
  return { listUsdcInflows: vi.fn().mockResolvedValue([]) }
}

function stubCreditClient(): CreditChainClient {
  return {
    isPayToRekeyed: vi.fn().mockResolvedValue(true),
    submitCredit: vi.fn().mockResolvedValue('CREDIT-TXID'),
    getOnChainLastBatchSeq: vi.fn().mockResolvedValue(0),
    findCreditTxidByNote: vi.fn().mockResolvedValue(null),
  }
}

beforeEach(() => {
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM batches')
})

describe('runNightly: order and stop conditions', () => {
  test('a backup failure stops the job before credit: no credit call, error propagates', async () => {
    const creditClient = stubCreditClient()
    const backup = vi.fn(() => {
      throw new Error('backup destination is unwritable')
    })

    await expect(
      runNightly({
        indexer: emptyIndexer(),
        backup,
        creditClient,
        env: { PAYMENT_ROUTER_APP_ID: '123', PAY_TO_ADDRESS: PAY_TO },
        log: () => {},
      }),
    ).rejects.toThrow('backup destination is unwritable')

    expect(backup).toHaveBeenCalledTimes(1)
    expect(creditClient.isPayToRekeyed).not.toHaveBeenCalled()
    expect(creditClient.submitCredit).not.toHaveBeenCalled()
  })

  test('PAYMENT_ROUTER_APP_ID unset: backup still runs, credit is skipped, resolves (exit 0)', async () => {
    const creditClient = stubCreditClient()
    const backup = vi.fn(() => '/backup/audit-2026.db')

    await expect(
      runNightly({
        indexer: emptyIndexer(),
        backup,
        creditClient,
        env: {},
        log: () => {},
      }),
    ).resolves.toBeUndefined()

    expect(backup).toHaveBeenCalledTimes(1)
    expect(creditClient.submitCredit).not.toHaveBeenCalled()
  })

  test('CREDITER_MNEMONIC unset (creditClient null): credit is skipped, resolves (exit 0)', async () => {
    const backup = vi.fn(() => '/backup/audit-2026.db')

    await expect(
      runNightly({
        indexer: emptyIndexer(),
        backup,
        creditClient: null,
        env: { PAYMENT_ROUTER_APP_ID: '123', PAY_TO_ADDRESS: PAY_TO },
        log: () => {},
      }),
    ).resolves.toBeUndefined()

    expect(backup).toHaveBeenCalledTimes(1)
  })

  test('a fully configured run reconciles, backs up, then credits, in that order', async () => {
    const calls: string[] = []
    const indexer: IndexerClient = {
      listUsdcInflows: vi.fn(async () => {
        calls.push('reconcile')
        return []
      }),
    }
    const backup = vi.fn(() => {
      calls.push('backup')
      return '/backup/audit-2026.db'
    })
    const creditClient: CreditChainClient = {
      isPayToRekeyed: vi.fn(async () => {
        calls.push('credit')
        return true
      }),
      submitCredit: vi.fn().mockResolvedValue('CREDIT-TXID'),
      getOnChainLastBatchSeq: vi.fn().mockResolvedValue(0),
      findCreditTxidByNote: vi.fn().mockResolvedValue(null),
    }

    await runNightly({
      indexer,
      backup,
      creditClient,
      env: { PAYMENT_ROUTER_APP_ID: '123', PAY_TO_ADDRESS: PAY_TO },
      log: () => {},
    })

    expect(calls).toEqual(['reconcile', 'backup', 'credit'])
  })
})
