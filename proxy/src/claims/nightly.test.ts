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

const {
  default: db,
  getLastNightlyRun,
  getLastSuccessfulNightlyRun,
  NIGHTLY_LEASE_STALE_MS,
} = await import('./schema.js')
const { runNightly, runNightlyWithLease } = await import('./nightly.js')
const { writeAccruals } = await import('./ledger.js')
type IndexerClient = import('./reconcile.js').IndexerClient
type CreditChainClient = import('./credit.js').CreditChainClient
type Attribution = import('./attribution-rules.js').Attribution

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
  db.exec('DELETE FROM nightly_runs')
  db.exec('DELETE FROM nightly_lease')
})

function fullyConfiguredDeps(overrides: Partial<Parameters<typeof runNightly>[0]> = {}) {
  return {
    indexer: emptyIndexer(),
    backup: vi.fn(() => '/backup/audit-2026.db'),
    creditClient: stubCreditClient(),
    assertGenesisMatches: () => {},
    env: { PAYMENT_ROUTER_APP_ID: '123', PAY_TO_ADDRESS: PAY_TO },
    log: () => {},
    ...overrides,
  }
}

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
        assertGenesisMatches: () => {},
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
        assertGenesisMatches: () => {},
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
        assertGenesisMatches: () => {},
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
      assertGenesisMatches: () => {},
      env: { PAYMENT_ROUTER_APP_ID: '123', PAY_TO_ADDRESS: PAY_TO },
      log: () => {},
    })

    expect(calls).toEqual(['reconcile', 'backup', 'credit'])
  })
})

describe('runNightly: genesis guard (R3c)', () => {
  test('a genesis mismatch stops the job before reconcile: no reconcile, no backup, no credit', async () => {
    const indexer = emptyIndexer()
    const backup = vi.fn(() => '/backup/audit-2026.db')
    const creditClient = stubCreditClient()

    await expect(
      runNightly({
        indexer,
        backup,
        creditClient,
        assertGenesisMatches: () => {
          throw new Error(
            'algod genesis id "mainnet-v1.0" from https://mainnet-api.algonode.cloud ' +
              'does not match NETWORK=testnet; fix ALGOD_SERVER (or NETWORK)',
          )
        },
        env: { PAYMENT_ROUTER_APP_ID: '123', PAY_TO_ADDRESS: PAY_TO },
        log: () => {},
      }),
    ).rejects.toThrow(/algod genesis id .* does not match NETWORK=testnet.*ALGOD_SERVER/s)

    expect(indexer.listUsdcInflows).not.toHaveBeenCalled()
    expect(backup).not.toHaveBeenCalled()
    expect(creditClient.isPayToRekeyed).not.toHaveBeenCalled()
    expect(creditClient.submitCredit).not.toHaveBeenCalled()
  })

  test('an async assertGenesisMatches rejection also stops the job before reconcile', async () => {
    const indexer = emptyIndexer()
    const backup = vi.fn(() => '/backup/audit-2026.db')

    await expect(
      runNightly({
        indexer,
        backup,
        creditClient: null,
        assertGenesisMatches: async () => {
          throw new Error(
            'indexer genesis id "mainnet-v1.0" from https://mainnet-idx.algonode.cloud ' +
              'does not match NETWORK=testnet; fix INDEXER_URL (or NETWORK)',
          )
        },
        env: { PAYMENT_ROUTER_APP_ID: '123', PAY_TO_ADDRESS: PAY_TO },
        log: () => {},
      }),
    ).rejects.toThrow(/indexer genesis id .* does not match NETWORK=testnet.*INDEXER_URL/s)

    expect(indexer.listUsdcInflows).not.toHaveBeenCalled()
    expect(backup).not.toHaveBeenCalled()
  })
})

describe('runNightlyWithLease: run records (item N1.5)', () => {
  test('a successful run with nothing to credit records a null batch', async () => {
    const now = () => new Date('2026-02-01T03:17:00Z')

    const outcome = await runNightlyWithLease(fullyConfiguredDeps(), now)

    expect(outcome).toEqual({ status: 'success' })
    const run = getLastNightlyRun()
    expect(run?.started_at).toBe(now().getTime())
    expect(run?.ended_at).toBe(now().getTime())
    expect(run?.result).toBe('success')
    expect(run?.error).toBeNull()
    expect(run?.batch_seq).toBeNull()
    expect(run?.credit_txid).toBeNull()
    expect(getLastSuccessfulNightlyRun()?.id).toBe(run?.id)
  })

  test('a successful run that credits a batch records batch_seq and credit_txid', async () => {
    const attribution: Attribution = {
      route: 'single-attest',
      priceMicro: 1000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
    }
    writeAccruals(attribution, 'TXID-NIGHTLY-CREDIT')
    const now = () => new Date('2026-02-01T03:17:00Z')

    const outcome = await runNightlyWithLease(fullyConfiguredDeps(), now)

    expect(outcome).toEqual({ status: 'success' })
    const run = getLastNightlyRun()
    expect(run?.result).toBe('success')
    expect(run?.batch_seq).toBe(1)
    expect(run?.credit_txid).toBe('CREDIT-TXID')
  })

  test('a failed run records the error, logs it, and never throws', async () => {
    const backup = vi.fn(() => {
      throw new Error('backup destination is unwritable')
    })
    const log = vi.fn()

    const outcome = await runNightlyWithLease(fullyConfiguredDeps({ backup, log }))

    expect(outcome).toEqual({ status: 'failed', error: 'backup destination is unwritable' })
    expect(log).toHaveBeenCalledWith('spm-nightly: failed — backup destination is unwritable')
    const run = getLastNightlyRun()
    expect(run?.result).toBe('failed')
    expect(run?.error).toBe('backup destination is unwritable')
    expect(run?.batch_seq).toBeNull()
    expect(getLastSuccessfulNightlyRun()).toBeUndefined()
  })
})

describe('runNightlyWithLease: a throw from the lease/run-record calls never rejects (item N1.3)', () => {
  // For example SQLITE_BUSY, from an operator running nightly-main.ts in a
  // second process against the same DB file while the in-process scheduler
  // is mid-acquire — the scheduler calls runNightlyWithLease with `void`,
  // so a rejection here would be an unhandled rejection and kill the
  // server.
  test('acquireNightlyLease throwing resolves failed, logs, and does not reject', async () => {
    const schema = await import('./schema.js')
    const spy = vi.spyOn(schema, 'acquireNightlyLease').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    const log = vi.fn()

    try {
      await expect(runNightlyWithLease(fullyConfiguredDeps({ log }))).resolves.toEqual({
        status: 'failed',
        error: 'SQLITE_BUSY: database is locked',
      })
      expect(log).toHaveBeenCalledWith('spm-nightly: failed — SQLITE_BUSY: database is locked')
      // No run row: the throw happened before recordNightlyRunStart ever ran.
      expect(getLastNightlyRun()).toBeUndefined()
    } finally {
      spy.mockRestore()
    }
  })

  test('recordNightlyRunStart throwing after the lease is taken resolves failed and releases the lease', async () => {
    const schema = await import('./schema.js')
    const spy = vi.spyOn(schema, 'recordNightlyRunStart').mockImplementation(() => {
      throw new Error('SQLITE_BUSY: database is locked')
    })
    const now = () => new Date('2026-02-01T03:17:00Z')

    const outcome = await runNightlyWithLease(fullyConfiguredDeps(), now)
    expect(outcome).toEqual({ status: 'failed', error: 'SQLITE_BUSY: database is locked' })
    // No run row: recordNightlyRunStart's own throw means no id to record
    // an end against.
    expect(getLastNightlyRun()).toBeUndefined()

    spy.mockRestore()

    // The lease was released in `finally` despite the throw — proven by a
    // normal run proceeding right after, with no stale-lease wait needed.
    const after = await runNightlyWithLease(fullyConfiguredDeps(), now)
    expect(after.status).toBe('success')
  })
})

describe('runNightlyWithLease: lease overlap and expiry (item N1.4)', () => {
  test('a second run started at the same instant exits without running, logging why', async () => {
    const now = () => new Date('2026-02-01T03:17:00Z')
    const first = fullyConfiguredDeps()
    const secondLog = vi.fn()
    const secondBackup = vi.fn(() => '/backup/audit-2026.db')

    // Blocks the first run mid-flight so the second run's acquire attempt
    // lands while the first run still holds the lease.
    let releaseFirstRun: () => void = () => {}
    const blocked = new Promise<void>((resolve) => {
      releaseFirstRun = resolve
    })
    // The first run's own eventual result does not matter to this test —
    // only that it still holds the lease at the moment the second run
    // attempts to acquire it. Failing it here is the simplest way to let
    // it finish (and release the lease, in its own `finally`) once
    // unblocked, without needing a working indexer/credit stub past this
    // point.
    first.backup = vi.fn(() => {
      throw new Error('first run: stop here, lease overlap already proven above')
    })
    const firstRunPromise = runNightlyWithLease(
      {
        ...first,
        assertGenesisMatches: () => blocked,
      },
      now,
    )

    const second = await runNightlyWithLease(
      fullyConfiguredDeps({ backup: secondBackup, log: secondLog }),
      now,
    )

    expect(second).toEqual({ status: 'lease-held' })
    expect(secondLog).toHaveBeenCalledWith(
      'spm-nightly: another run already holds the lease; exiting',
    )
    expect(secondBackup).not.toHaveBeenCalled()

    releaseFirstRun()
    await firstRunPromise
  })

  test('a lease older than one hour counts as released and a new run proceeds', async () => {
    const staleHolderAt = new Date('2026-02-01T00:00:00Z')
    const staleRun = await runNightlyWithLease(fullyConfiguredDeps(), () => staleHolderAt)
    expect(staleRun.status).toBe('success')
    // runNightlyWithLease's own `finally` already released that run's
    // lease. Acquire a fresh one directly, at the same old timestamp and
    // never released, to simulate a crashed run that never reached its own
    // `finally` block — leaving a held-but-abandoned lease row in place for
    // the staleness check below.
    const { acquireNightlyLease } = await import('./schema.js')
    const abandonedHolder = acquireNightlyLease(staleHolderAt.getTime())
    expect(abandonedHolder).not.toBeNull()

    const stillFresh = await runNightlyWithLease(
      fullyConfiguredDeps(),
      () => new Date(staleHolderAt.getTime() + NIGHTLY_LEASE_STALE_MS - 1),
    )
    expect(stillFresh.status).toBe('lease-held')

    const afterStale = await runNightlyWithLease(
      fullyConfiguredDeps(),
      () => new Date(staleHolderAt.getTime() + NIGHTLY_LEASE_STALE_MS + 1),
    )
    expect(afterStale.status).toBe('success')
  })
})
