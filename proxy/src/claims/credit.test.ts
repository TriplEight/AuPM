// proxy/src/claims/credit.test.ts
//
// CAUTION: every test here stubs CreditChainClient — no test in this file
// performs a real algod call. This file gets its own SQLite file via
// SQLITE_PATH, set before the dynamic import below (same trick as
// proxy/src/claims/ledger.test.ts) — the accruals and batches tables are
// shared across several test files in this directory.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, test, vi } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-claims-credit-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const {
  writeAccruals,
  openBatch,
  listCreditCandidates,
  recordBatchCreditTxid,
  freezeShares,
  releaseShares,
  slashShares,
  forfeitShares,
} = await import('./ledger.js')
const { setStatus } = await import('../status.js')
const {
  runCreditStep,
  buildCreditCallRefs,
  planCreditBatch,
  creditMethodArgs,
  CREDIT_METHOD_SIGNATURE,
  MAX_CREDIT_ENTRIES,
} = await import('./credit.js')
type AccrualRow = import('./schema.js').AccrualRow
type Attribution = import('./attribution-rules.js').Attribution
type CreditChainClient = import('./credit.js').CreditChainClient
type CreditEntry = import('./ledger.js').CreditEntry

const APP_ID = '123'
const PAY_TO = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// Shares written at T0 unlock at T0 + HOLD.
const T0 = 1_000_000
const HOLD = 5_000
const MATURE = T0 + HOLD

function envWithApp(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PAYMENT_ROUTER_APP_ID: APP_ID, PAY_TO_ADDRESS: PAY_TO, ...overrides }
}

type SubmitCreditMock = ReturnType<typeof vi.fn<CreditChainClient['submitCredit']>>

function makeSubmitMock(txid = 'CREDIT-TXID'): SubmitCreditMock {
  return vi.fn(async () => txid)
}

/** The arguments of `mock`'s first call. Throws if it was never called. */
function firstCallArgs(mock: SubmitCreditMock): Parameters<CreditChainClient['submitCredit']> {
  const call = mock.mock.calls[0]
  if (!call) throw new Error('firstCallArgs: submitCredit was never called')
  return call
}

/** A stub CreditChainClient: `rekeyed` controls isPayToRekeyed, `submit`
 * is a vi.fn() the caller inspects, defaulting to a fixed resolved txid.
 * `onChainLastBatchSeq` and `noteTxid` back the pending-batch recovery
 * path (getOnChainLastBatchSeq / findCreditTxidByNote) — default to "no
 * batch credited yet, so always resend". */
function stubClient(
  rekeyed: boolean,
  submit: SubmitCreditMock = makeSubmitMock(),
  onChainLastBatchSeq = 0,
  noteTxid: string | null = null,
): CreditChainClient {
  return {
    isPayToRekeyed: vi.fn(async () => rekeyed),
    submitCredit: submit,
    getOnChainLastBatchSeq: vi.fn(async () => onChainLastBatchSeq),
    findCreditTxidByNote: vi.fn(async () => noteTxid),
  }
}

const LOCKFILE_ATTRIBUTION: Attribution = {
  route: 'lockfile',
  priceMicro: 2000,
  packages: [
    { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
    { pkg: 'lodash', version: '4.17.21', auditor: 'github:bob' },
  ],
}

function write(attribution: Attribution, txid: string): void {
  writeAccruals(attribution, txid, T0, HOLD)
}

beforeEach(() => {
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM batches')
  db.exec('DELETE FROM audit_status')
  setStatus(
    'ms',
    '2.1.3',
    'COMMUNITY_REVIEWED',
    '0xA',
    'anchor-a',
    'sha-a',
    'alice',
    null,
    'acme/ms',
  )
  setStatus(
    'lodash',
    '4.17.21',
    'COMMUNITY_REVIEWED',
    '0xB',
    'anchor-b',
    'sha-b',
    'bob',
    null,
    'acme/lodash',
  )
})

describe('runCreditStep: skip conditions', () => {
  test('PAYMENT_ROUTER_APP_ID unset: no credit call, reason app-id-unset', async () => {
    const client = stubClient(true)
    const outcome = await runCreditStep(client, {}, T0)
    expect(outcome).toEqual({ ran: false, reason: 'app-id-unset' })
    expect(client.submitCredit).not.toHaveBeenCalled()
    expect(client.isPayToRekeyed).not.toHaveBeenCalled()
  })

  test('payTo not rekeyed: no credit call, reason payto-not-rekeyed', async () => {
    const client = stubClient(false)
    write(LOCKFILE_ATTRIBUTION, 'TXID-NOTREKEYED')
    const outcome = await runCreditStep(client, envWithApp(), T0)
    expect(outcome).toEqual({ ran: false, reason: 'payto-not-rekeyed' })
    expect(client.submitCredit).not.toHaveBeenCalled()
  })

  test('nothing to credit: no credit call, reason nothing-to-credit', async () => {
    const client = stubClient(true)
    const outcome = await runCreditStep(client, envWithApp(), T0)
    expect(outcome).toEqual({ ran: false, reason: 'nothing-to-credit' })
    expect(client.submitCredit).not.toHaveBeenCalled()
  })
})

describe('runCreditStep: exact credit() arguments', () => {
  test('before the hold ends: newTotal counts the payments, nothing is paid out', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-1')
    const submit = makeSubmitMock('CREDIT-TXID-1')

    const outcome = await runCreditStep(stubClient(true, submit), envWithApp(), T0 + 1)
    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-1' })

    expect(firstCallArgs(submit)).toEqual([
      123n,
      1,
      { newTotalMicro: 2000, unattributedMicro: 0, treasuryExtraMicro: 0, entries: [] },
    ])
    const batchRow = db.prepare('SELECT * FROM batches WHERE app_id = 123 AND batch_seq = 1').get()
    expect(batchRow).toMatchObject({
      credit_txid: 'CREDIT-TXID-1',
      new_total_micro: 2000,
      unattributed_micro: 0,
      treasury_extra_micro: 0,
    })
  })

  test('after the hold ends: entries per (repo, identity), unallocated shares as treasuryExtra, newTotal 0', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-2')
    const submit = makeSubmitMock('CREDIT-TXID-2')
    const client = stubClient(true, submit)
    await runCreditStep(client, envWithApp(), T0 + 1)
    await runCreditStep(client, envWithApp(), MATURE)

    expect(submit.mock.calls[1]).toEqual([
      123n,
      2,
      {
        newTotalMicro: 0,
        unattributedMicro: 0,
        // contributor 100 + maintainer 250, for each of the 2 packages
        treasuryExtraMicro: 700,
        entries: [
          { repo: 'acme/lodash', identity: 'github:bob', amountMicro: 400 },
          { repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 },
        ],
      },
    ])
  })

  test('the first run after the hold carries newTotal and the matured shares together', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-3')
    const submit = makeSubmitMock()
    await runCreditStep(stubClient(true, submit), envWithApp(), MATURE)
    const totals = firstCallArgs(submit)[2]
    expect(totals.newTotalMicro).toBe(2000)
    expect(totals.treasuryExtraMicro).toBe(700)
    expect(totals.entries).toHaveLength(2)
  })

  test('the entries never name ops or treasury, and every amount is above 0', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-4')
    const submit = makeSubmitMock()
    await runCreditStep(stubClient(true, submit), envWithApp(), MATURE)
    for (const entry of firstCallArgs(submit)[2].entries) {
      expect(['ops', 'treasury']).not.toContain(entry.identity)
      expect(entry.amountMicro).toBeGreaterThan(0)
    }
  })

  test('two packages under the same (repo, identity) merge into one entry', async () => {
    setStatus(
      'chalk',
      '5.3.0',
      'COMMUNITY_REVIEWED',
      '0xA',
      'anchor-c',
      'sha-c',
      'alice',
      null,
      'acme/ms', // same repo as ms, same reviewer -> same (repo, identity) key
    )
    write(
      {
        route: 'lockfile',
        priceMicro: 2000,
        packages: [
          { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
          { pkg: 'chalk', version: '5.3.0', auditor: 'github:alice' },
        ],
      },
      'TXID-MERGE',
    )
    const submit = makeSubmitMock()
    await runCreditStep(stubClient(true, submit), envWithApp(), MATURE)
    expect(firstCallArgs(submit)[2].entries).toEqual([
      { repo: 'acme/ms', identity: 'github:alice', amountMicro: 800 },
    ])
  })

  test('an unmatched inflow goes into unattributedTotal (treasury), not into entries or newTotal', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-UNASSIGNED')
    const { reconcile } = await import('./reconcile.js')
    await reconcile(
      PAY_TO,
      {
        listUsdcInflows: async () => [
          { txid: 'DIRECT-DEPOSIT', amountMicro: 5000, confirmedAt: 0 },
        ],
      },
      10_000, // far past MIN_INFLOW_AGE_SECONDS from confirmedAt=0
    )

    const submit = makeSubmitMock('CREDIT-TXID-3')
    const outcome = await runCreditStep(stubClient(true, submit), envWithApp(), T0 + 1)
    expect(outcome.ran).toBe(true)

    expect(firstCallArgs(submit)[2]).toEqual({
      newTotalMicro: 2000,
      unattributedMicro: 5000,
      treasuryExtraMicro: 0,
      entries: [],
    })
  })
})

describe('runCreditStep: freeze, release, slash, forfeit', () => {
  const MS = { pkg: 'ms', version: '2.1.3' }

  async function runAt(now: number): Promise<SubmitCreditMock> {
    const submit = makeSubmitMock()
    await runCreditStep(stubClient(true, submit), envWithApp(), now)
    return submit
  }

  beforeEach(() => {
    write(
      {
        route: 'single-attest',
        priceMicro: 1000,
        packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
      },
      'TXID-FREEZE',
    )
  })

  test('a frozen share is not credited after the hold; the rest of the pool is', async () => {
    freezeShares({ ...MS, role: 'reviewer' })
    const totals = firstCallArgs(await runAt(MATURE))[2]
    expect(totals.entries).toEqual([])
    expect(totals.newTotalMicro).toBe(1000)
    expect(totals.treasuryExtraMicro).toBe(350)
  })

  test('a released share is credited once it has matured', async () => {
    freezeShares({ ...MS, role: 'reviewer' })
    await runAt(MATURE) // counts the payment, credits nothing for the reviewer
    releaseShares({ ...MS, role: 'reviewer' })
    const totals = firstCallArgs(await runAt(MATURE + 1))[2]
    expect(totals.entries).toEqual([
      { repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 },
    ])
    expect(totals.newTotalMicro).toBe(0)
  })

  test('a released share that has not matured waits for its unlock time', async () => {
    freezeShares({ ...MS, role: 'reviewer' })
    releaseShares({ ...MS, role: 'reviewer' })
    const totals = firstCallArgs(await runAt(T0 + 1))[2]
    expect(totals.entries).toEqual([])
  })

  test('a slashed reviewer share goes to treasuryExtra at once, before the hold ends', async () => {
    freezeShares({ ...MS, role: 'reviewer' })
    slashShares(MS)
    const totals = firstCallArgs(await runAt(T0 + 1))[2]
    expect(totals.entries).toEqual([])
    expect(totals.treasuryExtraMicro).toBe(400)
  })

  test('a slashed share is credited once: not again in a later batch', async () => {
    freezeShares({ ...MS, role: 'reviewer' })
    slashShares(MS)
    await runAt(MATURE)
    const next = await runAt(MATURE + 1)
    expect(next).not.toHaveBeenCalled()
  })

  test('a forfeited maintainer share goes to treasuryExtra at once', async () => {
    db.prepare(
      "UPDATE accruals SET identity = 'github:carol', treasury_kind = NULL WHERE role = 'maintainer'",
    ).run()
    freezeShares({ ...MS, role: 'maintainer' })
    forfeitShares(MS)
    const totals = firstCallArgs(await runAt(T0 + 1))[2]
    expect(totals.treasuryExtraMicro).toBe(250)
    expect(totals.entries).toEqual([])
  })
})

describe('runCreditStep: batch resend after a crash', () => {
  test('a batch whose txid is recorded is never re-sent', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-ONCE')
    const submit = makeSubmitMock('CREDIT-TXID-ONCE')
    const client = stubClient(true, submit)

    const first = await runCreditStep(client, envWithApp(), T0 + 1)
    expect(first).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-ONCE' })

    const second = await runCreditStep(client, envWithApp(), T0 + 2)
    expect(second).toEqual({ ran: false, reason: 'nothing-to-credit' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  test('a batch row without a txid (crash after assign) is resent with its stored totals', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-CRASH')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('network dropped')
    })

    await expect(runCreditStep(stubClient(true, failing), envWithApp(), MATURE)).rejects.toThrow(
      'network dropped',
    )
    const pending = db.prepare('SELECT * FROM batches').all() as { batch_seq: number }[]
    expect(pending).toHaveLength(1)

    const retrySubmit = makeSubmitMock('CREDIT-TXID-RETRY')
    // A later clock must not change the resend: the stored rows decide.
    const outcome = await runCreditStep(stubClient(true, retrySubmit), envWithApp(), MATURE + 999)

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-RETRY' })
    expect(retrySubmit).toHaveBeenCalledTimes(1)
    expect(firstCallArgs(retrySubmit)[2]).toEqual(firstCallArgs(failing)[2])
    expect(db.prepare('SELECT * FROM batches').all()).toHaveLength(1)
  })

  test('a pending batch already credited on-chain is not resent; its txid is recovered from the note', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-CONFIRMED-NOT-RECORDED')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('response lost after confirmation')
    })
    await expect(runCreditStep(stubClient(true, failing), envWithApp(), T0 + 1)).rejects.toThrow(
      'response lost after confirmation',
    )

    const recoverySubmit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    const recoveryClient = stubClient(true, recoverySubmit, 1, 'RECOVERED-TXID')
    const outcome = await runCreditStep(recoveryClient, envWithApp(), T0 + 2)

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'RECOVERED-TXID' })
    expect(recoverySubmit).not.toHaveBeenCalled()
    expect(recoveryClient.getOnChainLastBatchSeq).toHaveBeenCalledWith(BigInt(APP_ID))
    expect(recoveryClient.findCreditTxidByNote).toHaveBeenCalledWith(BigInt(APP_ID), 1)

    const batchRow = db
      .prepare('SELECT credit_txid FROM batches WHERE app_id = 123 AND batch_seq = 1')
      .get() as { credit_txid: string | null }
    expect(batchRow.credit_txid).toBe('RECOVERED-TXID')
  })

  test('already credited on-chain but no matching note: throws, never resends', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-CONFIRMED-UNRECOVERABLE')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('response lost after confirmation')
    })
    await expect(runCreditStep(stubClient(true, failing), envWithApp(), T0 + 1)).rejects.toThrow(
      'response lost after confirmation',
    )

    const unrecoverableSubmit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    await expect(
      runCreditStep(stubClient(true, unrecoverableSubmit, 1, null), envWithApp(), T0 + 2),
    ).rejects.toThrow(/already credited on-chain/)
    expect(unrecoverableSubmit).not.toHaveBeenCalled()

    const batchRow = db
      .prepare('SELECT credit_txid FROM batches WHERE app_id = 123 AND batch_seq = 1')
      .get() as { credit_txid: string | null }
    expect(batchRow.credit_txid).toBeNull()
  })
})

describe('runCreditStep: batch numbers follow the configured app', () => {
  const OTHER_APP = 999

  function creditedBatchOfOtherApp(seq: number, txid: string): void {
    write(LOCKFILE_ATTRIBUTION, txid)
    openBatch(OTHER_APP, seq, {
      counted: listCreditCandidates().filter((r) => r.batch_seq === null),
      paid: [],
    })
    recordBatchCreditTxid(OTHER_APP, seq, `CREDIT-${txid}`)
  }

  test('a fresh app starts at batch 1 although another app has a longer history', async () => {
    creditedBatchOfOtherApp(6, 'TXID-OTHER-1')
    write(LOCKFILE_ATTRIBUTION, 'TXID-NEW-APP')
    const submit = makeSubmitMock('CREDIT-NEW-APP')

    const outcome = await runCreditStep(stubClient(true, submit, 0), envWithApp(), T0 + 1)

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-NEW-APP' })
    expect(firstCallArgs(submit)[1]).toBe(1)
    const rows = db.prepare('SELECT app_id, batch_seq FROM batches ORDER BY app_id').all()
    expect(rows).toEqual([
      { app_id: Number(APP_ID), batch_seq: 1 },
      { app_id: OTHER_APP, batch_seq: 6 },
    ])
  })

  test('switching back to the earlier app continues its own sequence', async () => {
    creditedBatchOfOtherApp(6, 'TXID-OTHER-1')
    write(LOCKFILE_ATTRIBUTION, 'TXID-NEW-APP')
    await runCreditStep(stubClient(true, makeSubmitMock('CREDIT-NEW-APP'), 0), envWithApp(), T0 + 1)

    write(LOCKFILE_ATTRIBUTION, 'TXID-BACK')
    const submit = makeSubmitMock('CREDIT-BACK')
    const outcome = await runCreditStep(
      stubClient(true, submit, 6),
      envWithApp({ PAYMENT_ROUTER_APP_ID: String(OTHER_APP) }),
      T0 + 1,
    )

    expect(outcome).toEqual({ ran: true, batchSeq: 7, creditTxid: 'CREDIT-BACK' })
  })

  test('a pending batch of another app is not resent to the configured app', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-OTHER-PENDING')
    openBatch(OTHER_APP, 4, { counted: listCreditCandidates(), paid: [] })
    write(LOCKFILE_ATTRIBUTION, 'TXID-NEW-APP')
    const submit = makeSubmitMock('CREDIT-NEW-APP')

    const outcome = await runCreditStep(stubClient(true, submit, 0), envWithApp(), T0 + 1)

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-NEW-APP' })
    expect(firstCallArgs(submit)[2].newTotalMicro).toBe(2000)
  })
})

describe('runCreditStep: a pending batch over the entry limit', () => {
  const FIVE_REVIEWERS: Attribution = {
    route: 'lockfile',
    priceMicro: 5000,
    packages: [0, 1, 2, 3, 4].map((i) => ({
      pkg: `pkg-${i}`,
      version: '1.0.0',
      auditor: `github:auditor-${i}`,
    })),
  }

  // A batch with 5 entries: it can never confirm on chain.
  function openOversizedBatch(): void {
    write(FIVE_REVIEWERS, 'TXID-FIVE')
    const rows = listCreditCandidates()
    openBatch(Number(APP_ID), 1, {
      counted: rows,
      paid: rows.filter((r) => r.role === 'reviewer'),
    })
  }

  test('not credited on chain: released, then re-planned within the limit and sent', async () => {
    openOversizedBatch()
    const submit = makeSubmitMock('CREDIT-REPLANNED')
    const outcome = await runCreditStep(stubClient(true, submit, 0), envWithApp(), MATURE)

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-REPLANNED' })
    expect(submit).toHaveBeenCalledTimes(1)
    const [, batchSeq, totals] = firstCallArgs(submit)
    expect(batchSeq).toBe(1)
    expect(totals.newTotalMicro).toBe(5000)
    expect(totals.entries).toHaveLength(3)
    const unpaid = db
      .prepare(
        "SELECT COUNT(DISTINCT pkg) AS n FROM accruals WHERE role = 'reviewer' AND paid_seq IS NULL",
      )
      .get()
    expect(unpaid).toEqual({ n: 2 })
  })

  test('already credited on chain: never released, its txid is recovered from the note', async () => {
    openOversizedBatch()
    const submit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    const outcome = await runCreditStep(
      stubClient(true, submit, 1, 'ON-CHAIN'),
      envWithApp(),
      MATURE,
    )

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'ON-CHAIN' })
    expect(submit).not.toHaveBeenCalled()
    const released = db.prepare('SELECT COUNT(*) AS n FROM accruals WHERE batch_seq IS NULL').get()
    expect(released).toEqual({ n: 0 })
  })

  test('a pending batch within the limit is resent as-is, never released', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-SMALL')
    const rows = listCreditCandidates()
    openBatch(Number(APP_ID), 1, {
      counted: rows,
      paid: rows.filter((r) => r.role === 'reviewer'),
    })
    const submit = makeSubmitMock('CREDIT-RESENT')
    await runCreditStep(stubClient(true, submit, 0), envWithApp(), T0 + 1)

    const [, batchSeq, totals] = firstCallArgs(submit)
    expect([batchSeq, totals.newTotalMicro, totals.entries.length]).toEqual([1, 2000, 2])
  })
})

describe('buildCreditCallRefs', () => {
  const PAY_TO_ADDR = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const ASSET_ID = 31566704n

  function boxNamesOf(refs: ReturnType<typeof buildCreditCallRefs>): string[] {
    return refs.boxes.map((b) => Buffer.from(b.name).toString('utf8')).sort()
  }

  test('one box per distinct identity plus bal:ops and bal:treasury, one payTo account, one asset', () => {
    const entries: CreditEntry[] = [
      { repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 },
      { repo: 'acme/lodash', identity: 'github:bob', amountMicro: 400 },
    ]
    const refs = buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)

    expect(refs.accounts).toEqual([PAY_TO_ADDR])
    expect(refs.assets).toEqual([ASSET_ID])
    expect(boxNamesOf(refs)).toEqual([
      'bal:github:alice',
      'bal:github:bob',
      'bal:ops',
      'bal:treasury',
    ])
    expect(refs.boxes.every((b) => b.appIndex === 0)).toBe(true)
  })

  test('no entries: still bal:ops and bal:treasury', () => {
    expect(boxNamesOf(buildCreditCallRefs([], PAY_TO_ADDR, ASSET_ID))).toEqual([
      'bal:ops',
      'bal:treasury',
    ])
  })

  test('the same identity across two repos gets one box, not two', () => {
    const entries: CreditEntry[] = [
      { repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 },
      { repo: 'acme/other', identity: 'github:alice', amountMicro: 100 },
    ]
    const refs = buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)
    expect(boxNamesOf(refs)).toEqual(['bal:github:alice', 'bal:ops', 'bal:treasury'])
  })

  test('over the AVM 8-reference limit: throws before any network call', () => {
    // 5 distinct identities + ops + treasury = 7 boxes, + 1 account + 1 asset = 9 > 8
    const entries: CreditEntry[] = Array.from({ length: 5 }, (_, i) => ({
      repo: `acme/repo-${i}`,
      identity: `github:auditor-${i}`,
      amountMicro: 100,
    }))
    expect(() => buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)).toThrow(
      /over the AVM's per-transaction limit of 8/,
    )
  })

  test('exactly at the limit does not throw', () => {
    // 4 distinct identities + ops + treasury = 6 boxes, + 1 account + 1 asset = 8
    const entries: CreditEntry[] = Array.from({ length: 4 }, (_, i) => ({
      repo: `acme/repo-${i}`,
      identity: `github:auditor-${i}`,
      amountMicro: 100,
    }))
    expect(() => buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)).not.toThrow()
  })
})

describe('credit() ABI', () => {
  test('the signature has the 5 arguments of the contract', () => {
    expect(CREDIT_METHOD_SIGNATURE).toBe(
      'credit(uint64,uint64,uint64,uint64,(string,string,uint64)[])void',
    )
  })

  test('the arguments encode with the ABI types in the order batchSeq, newTotal, unattributed, treasuryExtra, entries', () => {
    const method = algosdk.ABIMethod.fromSignature(CREDIT_METHOD_SIGNATURE)
    const args = creditMethodArgs(7, {
      newTotalMicro: 2000,
      unattributedMicro: 5000,
      treasuryExtraMicro: 700,
      entries: [{ repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 }],
    })
    expect(args).toEqual([7n, 2000n, 5000n, 700n, [['acme/ms', 'github:alice', 400n]]])
    expect(method.args).toHaveLength(5)
    args.forEach((arg, i) => {
      const type = method.args[i]?.type
      if (typeof type === 'string') throw new Error('expected a value argument type')
      expect(() => type?.encode(arg as never)).not.toThrow()
    })
  })
})

// One credit() call fits at most MAX_CREDIT_ENTRIES (repo, identity) entries.
// A larger backlog must split into several batches, never stall the job.
function share(pkg: string, identity: string, overrides: Partial<AccrualRow> = {}): AccrualRow {
  return {
    settle_txid: 'T',
    route: 'lockfile',
    pkg,
    version: '1.0.0',
    repo: `acme/${pkg}`,
    role: 'reviewer',
    identity,
    amount_micro: 400,
    created_at: 1,
    unlock_at: 100,
    frozen: 0,
    treasury_kind: null,
    batch_app_id: null,
    batch_seq: null,
    paid_app_id: null,
    paid_seq: null,
    ...overrides,
  }
}

describe('planCreditBatch', () => {
  test('no rows: an empty plan', () => {
    expect(planCreditBatch([], 1000)).toEqual({ counted: [], paid: [] })
  })

  test('the limit is 3 entries', () => {
    expect(MAX_CREDIT_ENTRIES).toBe(3)
  })

  test('a share before its unlock time is counted but not paid', () => {
    const row = share('p0', 'github:a')
    expect(planCreditBatch([row], 99)).toEqual({ counted: [row], paid: [] })
    expect(planCreditBatch([row], 100).paid).toEqual([row])
  })

  test('a frozen share is never paid', () => {
    const row = share('p0', 'github:a', { frozen: 1 })
    expect(planCreditBatch([row], 1000).paid).toEqual([])
  })

  test('a share already credited is not paid again, and a counted payment is not counted again', () => {
    const row = share('p0', 'github:a', { batch_seq: 1, paid_seq: 1 })
    expect(planCreditBatch([row], 1000)).toEqual({ counted: [], paid: [] })
  })

  test('off-the-top rows are counted and never paid', () => {
    const ops = share('p0', 'ops', { role: 'ops', amount_micro: 50, unlock_at: 0 })
    const cut = share('p0', 'treasury', {
      role: 'treasury',
      treasury_kind: 'cut',
      amount_micro: 200,
      unlock_at: 0,
    })
    expect(planCreditBatch([ops, cut], 1000)).toEqual({ counted: [ops, cut], paid: [] })
  })

  test('matured unallocated, slash and forfeit rows are all paid in the first batch', () => {
    const kinds = ['unallocated', 'slash', 'forfeit'].map((kind) =>
      share('p0', 'treasury', { treasury_kind: kind, role: 'maintainer' }),
    )
    expect(planCreditBatch(kinds, 1000).paid).toEqual(kinds)
  })

  test('more than 3 groups: only the first 3 are paid, each group whole', () => {
    const rows = [0, 1, 2, 3].flatMap((i) => [
      share(`p${i}`, 'github:alice'),
      share(`p${i}`, 'github:alice', { settle_txid: 'T2' }),
    ])
    const plan = planCreditBatch(rows, 1000)
    expect(plan.paid.map((r) => r.pkg)).toEqual(['p0', 'p0', 'p1', 'p1', 'p2', 'p2'])
  })

  test('one identity across many repos still splits: the limit counts entries, not identities', () => {
    const rows = Array.from({ length: 30 }, (_, i) => share(`p${i}`, 'github:tripleight'))
    expect(planCreditBatch(rows, 1000).paid).toHaveLength(3)
  })
})

describe('runCreditStep: a backlog over the entry limit splits into calls', () => {
  const SEVEN_REVIEWERS: Attribution = {
    route: 'lockfile',
    priceMicro: 7000,
    packages: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      pkg: `pkg-${i}`,
      version: '1.0.0',
      auditor: `github:auditor-${i}`,
    })),
  }

  test('7 reviewers: three calls with 3, 3 and 1 entries; only the first has newTotal and treasuryExtra', async () => {
    write(SEVEN_REVIEWERS, 'TXID-SEVEN')
    const submit: SubmitCreditMock = vi.fn(async (_app, seq) => `CREDIT-${seq}`)
    const client = stubClient(true, submit)

    for (const batchSeq of [1, 2, 3]) {
      expect(await runCreditStep(client, envWithApp(), MATURE)).toEqual({
        ran: true,
        batchSeq,
        creditTxid: `CREDIT-${batchSeq}`,
      })
    }
    expect(await runCreditStep(client, envWithApp(), MATURE)).toEqual({
      ran: false,
      reason: 'nothing-to-credit',
    })

    const totals = submit.mock.calls.map((call) => call[2])
    expect(totals.map((t) => t.newTotalMicro)).toEqual([7000, 0, 0])
    expect(totals.map((t) => t.unattributedMicro)).toEqual([0, 0, 0])
    expect(totals.map((t) => t.treasuryExtraMicro)).toEqual([2450, 0, 0])
    expect(totals.map((t) => t.entries.length)).toEqual([3, 3, 1])
    expect(submit.mock.calls.map((call) => call[1])).toEqual([1, 2, 3])
    for (const t of totals) {
      expect(() => buildCreditCallRefs(t.entries, PAY_TO, 31566704n)).not.toThrow()
    }
    // every reviewer line is paid exactly once
    const paid = totals.flatMap((t) => t.entries).reduce((sum, e) => sum + e.amountMicro, 0)
    expect(paid).toBe(7 * 400)
    const open = db.prepare('SELECT COUNT(*) AS n FROM accruals WHERE batch_seq IS NULL').get()
    expect(open).toEqual({ n: 0 })
  })
})
