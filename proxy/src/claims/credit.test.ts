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
import { beforeEach, describe, expect, test, vi } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-claims-credit-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { writeAccruals, openBatch, listUncreditedAccruals } = await import('./ledger.js')
const { setStatus } = await import('../status.js')
const { runCreditStep, buildCreditCallRefs, planCreditChunk, MAX_CREDIT_ENTRIES } = await import(
  './credit.js'
)
const { groupForCredit } = await import('./ledger.js')
type AccrualRow = import('./schema.js').AccrualRow
type Attribution = import('./attribution-rules.js').Attribution
type CreditChainClient = import('./credit.js').CreditChainClient
type CreditEntry = import('./ledger.js').CreditEntry

const APP_ID = '123'
const PAY_TO = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function envWithApp(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { PAYMENT_ROUTER_APP_ID: APP_ID, PAY_TO_ADDRESS: PAY_TO, ...overrides }
}

type SubmitCreditMock = ReturnType<typeof vi.fn<CreditChainClient['submitCredit']>>

function makeSubmitMock(txid = 'CREDIT-TXID'): SubmitCreditMock {
  return vi.fn(async () => txid)
}

/** The arguments of `mock`'s first call. Throws if it was never called —
 * every caller here already asserted that a credit call happened, so this
 * is defensive, not part of the test's actual behavior under test. */
function firstCallArgs(mock: SubmitCreditMock): Parameters<CreditChainClient['submitCredit']> {
  const call = mock.mock.calls[0]
  if (!call) throw new Error('firstCallArgs: submitCredit was never called')
  return call
}

/** A stub CreditChainClient: `rekeyed` controls isPayToRekeyed, `submit`
 * is a vi.fn() the caller inspects, defaulting to a fixed resolved txid.
 * `onChainLastBatchSeq` and `noteTxid` back the pending-batch recovery
 * path (getOnChainLastBatchSeq / findCreditTxidByNote) — default to "no
 * batch credited yet, so always resend", which is what every test that
 * predates the recovery path needs. */
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
    const outcome = await runCreditStep(client, {})
    expect(outcome).toEqual({ ran: false, reason: 'app-id-unset' })
    expect(client.submitCredit).not.toHaveBeenCalled()
    expect(client.isPayToRekeyed).not.toHaveBeenCalled()
  })

  test('payTo not rekeyed: no credit call, reason payto-not-rekeyed', async () => {
    const client = stubClient(false)
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-NOTREKEYED')
    const outcome = await runCreditStep(client, envWithApp())
    expect(outcome).toEqual({ ran: false, reason: 'payto-not-rekeyed' })
    expect(client.submitCredit).not.toHaveBeenCalled()
  })

  test('nothing uncredited: no credit call, reason nothing-to-credit', async () => {
    const client = stubClient(true)
    const outcome = await runCreditStep(client, envWithApp())
    expect(outcome).toEqual({ ran: false, reason: 'nothing-to-credit' })
    expect(client.submitCredit).not.toHaveBeenCalled()
  })
})

describe('runCreditStep: batch totals and entries', () => {
  test('batch totals equal the ledger sums; auditor entries grouped per (repo, identity)', async () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-1')
    const submit = makeSubmitMock('CREDIT-TXID-1')
    const client = stubClient(true, submit)

    const outcome = await runCreditStep(client, envWithApp())
    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-1' })
    expect(submit).toHaveBeenCalledTimes(1)

    const [, batchSeq, attributedMicro, unattributedMicro, entries] = firstCallArgs(submit)
    expect(batchSeq).toBe(1)
    expect(attributedMicro).toBe(2000) // 2 packages x 1,000 microUSDC each
    expect(unattributedMicro).toBe(0)

    // 300 per package, ADR 0011's auditor share (docs/TASK.md P8d: one split everywhere).
    const byKey = new Map(entries.map((e) => [`${e.repo}:${e.identity}`, e.amountMicro]))
    expect(byKey.get('acme/ms:github:alice')).toBe(300)
    expect(byKey.get('acme/lodash:github:bob')).toBe(300)
    expect(entries).toHaveLength(2) // never merged across different (repo, identity) pairs

    const batchRow = db.prepare('SELECT * FROM batches WHERE batch_seq = 1').get() as {
      credit_txid: string | null
      attributed_micro: number
      unattributed_micro: number
    }
    expect(batchRow.credit_txid).toBe('CREDIT-TXID-1')
    expect(batchRow.attributed_micro).toBe(2000)
    expect(batchRow.unattributed_micro).toBe(0)
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
      'acme/ms', // same repo as ms, same auditor -> same (repo, identity) key
    )
    const attribution: Attribution = {
      route: 'lockfile',
      priceMicro: 2000,
      packages: [
        { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
        { pkg: 'chalk', version: '5.3.0', auditor: 'github:alice' },
      ],
    }
    writeAccruals(attribution, 'TXID-MERGE')
    const submit = makeSubmitMock('CREDIT-TXID-2')
    const client = stubClient(true, submit)

    await runCreditStep(client, envWithApp())
    const [, , , , entries] = firstCallArgs(submit)
    expect(entries).toHaveLength(1)
    // 2 x 300 (auditor share, ADR 0011), merged into one (repo, identity) entry.
    expect(entries[0]).toEqual({ repo: 'acme/ms', identity: 'github:alice', amountMicro: 600 })
  })

  test('an unmatched inflow ledgered as unassigned goes into unattributedMicro, not entries', async () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-UNASSIGNED')
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
    const client = stubClient(true, submit)
    const outcome = await runCreditStep(client, envWithApp())
    expect(outcome.ran).toBe(true)

    const [, , attributedMicro, unattributedMicro, entries] = firstCallArgs(submit)
    expect(attributedMicro).toBe(2000)
    expect(unattributedMicro).toBe(5000)
    // the unassigned inflow's auditor share carries identity "unassigned",
    // never folded into a real auditor's entries — only the 2 real
    // packages' (repo, identity) entries appear.
    expect(entries).toHaveLength(2)
    expect(entries.some((e) => e.identity === 'unassigned')).toBe(false)
  })
})

describe('runCreditStep: batch resend after a crash', () => {
  test('a batch whose txid is recorded is never re-sent', async () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-ONCE')
    const submit = makeSubmitMock('CREDIT-TXID-ONCE')
    const client = stubClient(true, submit)

    const first = await runCreditStep(client, envWithApp())
    expect(first).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-ONCE' })

    const second = await runCreditStep(client, envWithApp())
    expect(second).toEqual({ ran: false, reason: 'nothing-to-credit' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  test('a batch row without a txid (crash after assign) is resent, not opened again', async () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-CRASH')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('network dropped')
    })
    const crashingClient = stubClient(true, failing)

    await expect(runCreditStep(crashingClient, envWithApp())).rejects.toThrow('network dropped')

    // The batch row exists, rows are stamped, but no credit_txid yet.
    const pending = db.prepare('SELECT * FROM batches').all() as { batch_seq: number }[]
    expect(pending).toHaveLength(1)
    expect(pending[0]?.batch_seq).toBe(1)

    const retrySubmit = makeSubmitMock('CREDIT-TXID-RETRY')
    const retryClient = stubClient(true, retrySubmit)
    const outcome = await runCreditStep(retryClient, envWithApp())

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-RETRY' })
    expect(retrySubmit).toHaveBeenCalledTimes(1)
    const batches = db.prepare('SELECT * FROM batches').all() as { batch_seq: number }[]
    expect(batches).toHaveLength(1) // never opened a second batch
  })

  test('a pending batch already credited on-chain is not resent; its txid is recovered from the note', async () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-CONFIRMED-NOT-RECORDED')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('response lost after confirmation')
    })
    const crashingClient = stubClient(true, failing)
    await expect(runCreditStep(crashingClient, envWithApp())).rejects.toThrow(
      'response lost after confirmation',
    )

    // The batch actually confirmed on-chain (lastBatchSeq caught up to 1),
    // it just never got its txid recorded locally.
    const recoverySubmit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    const recoveryClient = stubClient(true, recoverySubmit, 1, 'RECOVERED-TXID')
    const outcome = await runCreditStep(recoveryClient, envWithApp())

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'RECOVERED-TXID' })
    expect(recoverySubmit).not.toHaveBeenCalled() // never resent
    expect(recoveryClient.getOnChainLastBatchSeq).toHaveBeenCalledWith(BigInt(APP_ID))
    expect(recoveryClient.findCreditTxidByNote).toHaveBeenCalledWith(BigInt(APP_ID), 1)

    const batchRow = db.prepare('SELECT credit_txid FROM batches WHERE batch_seq = 1').get() as {
      credit_txid: string | null
    }
    expect(batchRow.credit_txid).toBe('RECOVERED-TXID')
  })

  test('already credited on-chain but no matching note: throws, never resends', async () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-CONFIRMED-UNRECOVERABLE')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('response lost after confirmation')
    })
    const crashingClient = stubClient(true, failing)
    await expect(runCreditStep(crashingClient, envWithApp())).rejects.toThrow(
      'response lost after confirmation',
    )

    const unrecoverableSubmit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    const unrecoverableClient = stubClient(true, unrecoverableSubmit, 1, null)
    await expect(runCreditStep(unrecoverableClient, envWithApp())).rejects.toThrow(
      /already credited on-chain/,
    )
    expect(unrecoverableSubmit).not.toHaveBeenCalled()

    const batchRow = db.prepare('SELECT credit_txid FROM batches WHERE batch_seq = 1').get() as {
      credit_txid: string | null
    }
    expect(batchRow.credit_txid).toBeNull() // still pending, not silently marked done
  })
})

describe('runCreditStep: a pending batch over the entry limit', () => {
  const FIVE_AUDITORS: Attribution = {
    route: 'lockfile',
    priceMicro: 5000,
    packages: [0, 1, 2, 3, 4].map((i) => ({
      pkg: `pkg-${i}`,
      version: '1.0.0',
      auditor: `github:auditor-${i}`,
    })),
  }

  // What the planner before the entry limit did: one batch with 5 entries.
  function openOversizedBatch(): void {
    writeAccruals(FIVE_AUDITORS, 'TXID-FIVE')
    openBatch(1, listUncreditedAccruals())
  }

  test('not credited on chain: released, then re-planned within the limit and sent', async () => {
    openOversizedBatch()
    const submit = makeSubmitMock('CREDIT-REPLANNED')
    const outcome = await runCreditStep(stubClient(true, submit, 0), envWithApp())

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-REPLANNED' })
    expect(submit).toHaveBeenCalledTimes(1)
    const [, batchSeq, attributed, , entries] = firstCallArgs(submit)
    expect(batchSeq).toBe(1)
    expect(attributed).toBe(3000)
    expect(entries).toHaveLength(3)
    const uncredited = db
      .prepare('SELECT COUNT(DISTINCT pkg) AS n FROM accruals WHERE batch_seq IS NULL')
      .get()
    expect(uncredited).toEqual({ n: 2 })
  })

  test('already credited on chain: never released, its txid is recovered from the note', async () => {
    openOversizedBatch()
    const submit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    const outcome = await runCreditStep(stubClient(true, submit, 1, 'ON-CHAIN'), envWithApp())

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'ON-CHAIN' })
    expect(submit).not.toHaveBeenCalled()
    const released = db.prepare('SELECT COUNT(*) AS n FROM accruals WHERE batch_seq IS NULL').get()
    expect(released).toEqual({ n: 0 })
  })

  test('a pending batch within the limit is resent as-is, never released', async () => {
    writeAccruals(LOCKFILE_ATTRIBUTION, 'TXID-SMALL')
    openBatch(1, listUncreditedAccruals())
    const submit = makeSubmitMock('CREDIT-RESENT')
    await runCreditStep(stubClient(true, submit, 0), envWithApp())

    const [, batchSeq, attributed, , entries] = firstCallArgs(submit)
    expect([batchSeq, attributed, entries.length]).toEqual([1, 2000, 2])
  })
})

describe('buildCreditCallRefs', () => {
  const PAY_TO_ADDR = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'
  const ASSET_ID = 31566704n

  function boxNamesOf(refs: ReturnType<typeof buildCreditCallRefs>): string[] {
    return refs.boxes.map((b) => Buffer.from(b.name).toString('utf8')).sort()
  }

  test('one box per distinct identity plus bal:ops, one payTo account, one asset', () => {
    const entries: CreditEntry[] = [
      { repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 },
      { repo: 'acme/lodash', identity: 'github:bob', amountMicro: 400 },
    ]
    const refs = buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)

    expect(refs.accounts).toEqual([PAY_TO_ADDR])
    expect(refs.assets).toEqual([ASSET_ID])
    expect(boxNamesOf(refs)).toEqual(['bal:github:alice', 'bal:github:bob', 'bal:ops'])
    expect(refs.boxes.every((b) => b.appIndex === 0)).toBe(true)
  })

  test('the same identity across two repos gets one box, not two', () => {
    const entries: CreditEntry[] = [
      { repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 },
      { repo: 'acme/other', identity: 'github:alice', amountMicro: 100 },
    ]
    const refs = buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)
    expect(boxNamesOf(refs)).toEqual(['bal:github:alice', 'bal:ops'])
  })

  test('over the AVM 8-reference limit: throws before any network call', () => {
    // 6 distinct identities + "ops" = 7 boxes, + 1 account + 1 asset = 9 > 8
    const entries: CreditEntry[] = Array.from({ length: 6 }, (_, i) => ({
      repo: `acme/repo-${i}`,
      identity: `github:auditor-${i}`,
      amountMicro: 100,
    }))
    expect(() => buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)).toThrow(
      /over the AVM's per-transaction limit of 8/,
    )
  })

  test('exactly at the limit does not throw', () => {
    // 5 distinct identities + "ops" = 6 boxes, + 1 account + 1 asset = 8
    const entries: CreditEntry[] = Array.from({ length: 5 }, (_, i) => ({
      repo: `acme/repo-${i}`,
      identity: `github:auditor-${i}`,
      amountMicro: 100,
    }))
    expect(() => buildCreditCallRefs(entries, PAY_TO_ADDR, ASSET_ID)).not.toThrow()
  })
})

// One credit() call fits at most MAX_CREDIT_ENTRIES (repo, identity) entries:
// the opcode budget measured on TestNet (173 + 159 per entry, limit 700).
// A larger backlog must split into several batches, never stall the job.
function packageRows(txid: string, pkg: string, auditor: string): AccrualRow[] {
  const base = {
    settle_txid: txid,
    route: 'lockfile',
    pkg,
    version: '1.0.0',
    repo: `acme/${pkg}`,
    batch_seq: null,
    created_at: 1,
  }
  return [
    { ...base, role: 'auditor', identity: auditor, amount_micro: 300 },
    { ...base, role: 'ops', identity: 'ops', amount_micro: 700 },
  ]
}

function unassignedRow(txid: string, amount: number): AccrualRow {
  return {
    settle_txid: txid,
    route: 'unassigned',
    pkg: '',
    version: '',
    repo: '',
    role: 'ops',
    identity: 'ops',
    amount_micro: amount,
    batch_seq: null,
    created_at: 1,
  }
}

describe('planCreditChunk', () => {
  test('no rows: an empty chunk', () => {
    expect(planCreditChunk([])).toEqual([])
  })

  test('the limit is 3 entries', () => {
    expect(MAX_CREDIT_ENTRIES).toBe(3)
  })

  test('3 packages in 3 repos fit: every row goes into the chunk', () => {
    const rows = [0, 1, 2].flatMap((i) => packageRows('T', `p${i}`, `github:a${i}`))
    expect(planCreditChunk(rows)).toEqual(rows)
  })

  test('a 4th repo waits for the next batch, with all its role rows', () => {
    const rows = [0, 1, 2, 3].flatMap((i) => packageRows('T', `p${i}`, 'github:alice'))
    const chunk = planCreditChunk(rows)
    expect(chunk.map((r) => r.pkg).sort()).toEqual(['p0', 'p0', 'p1', 'p1', 'p2', 'p2'])
  })

  test('one auditor across many repos still splits: the limit counts entries, not identities', () => {
    const rows = Array.from({ length: 30 }, (_, i) =>
      packageRows('T', `p${i}`, 'github:tripleight'),
    ).flat()
    expect(groupForCredit(planCreditChunk(rows)).entries).toHaveLength(3)
  })

  test('a repeated (repo, identity) adds no entry: a later package in a known repo still fits', () => {
    const rows = [
      ...[0, 1, 2, 3].flatMap((i) => packageRows('T', `p${i}`, `github:a${i}`)),
      ...packageRows('T2', 'p0', 'github:a0'),
    ]
    const chunk = planCreditChunk(rows)
    expect(chunk.some((r) => r.settle_txid === 'T2')).toBe(true)
    expect(chunk.some((r) => r.pkg === 'p3')).toBe(false)
  })

  test('unassigned rows always go into the chunk: they add no entry', () => {
    const rows = [
      ...[0, 1, 2, 3].flatMap((i) => packageRows('T', `p${i}`, `github:a${i}`)),
      unassignedRow('U1', 5123),
    ]
    expect(planCreditChunk(rows)).toContainEqual(unassignedRow('U1', 5123))
  })

  test("each chunk's entries sum to exactly 300 per 1,000 attributed, within the limits", () => {
    let remaining = Array.from({ length: 13 }, (_, i) =>
      packageRows(`T${i % 3}`, `p${i}`, `github:a${i % 8}`),
    ).flat()
    let batches = 0
    while (remaining.length > 0) {
      const chunk = planCreditChunk(remaining)
      const totals = groupForCredit(chunk)
      const entriesTotal = totals.entries.reduce((sum, e) => sum + e.amountMicro, 0)
      expect(entriesTotal * 1000).toBe(totals.attributedMicro * 300)
      expect(totals.entries.length).toBeLessThanOrEqual(MAX_CREDIT_ENTRIES)
      expect(() => buildCreditCallRefs(totals.entries, PAY_TO, 31566704n)).not.toThrow()
      remaining = remaining.filter((r) => !chunk.includes(r))
      batches += 1
    }
    expect(batches).toBe(5)
  })

  test('one package that alone needs more than 3 entries throws', () => {
    const rows = [0, 1, 2, 3].flatMap((i) =>
      packageRows('T', 'p0', `github:a${i}`).filter((r) => r.role === 'auditor'),
    )
    expect(() => planCreditChunk(rows)).toThrow(/alone needs 4 entries/)
  })
})

describe('runCreditStep: a backlog over the entry limit splits into batches', () => {
  const SEVEN_AUDITORS: Attribution = {
    route: 'lockfile',
    priceMicro: 7000,
    packages: [0, 1, 2, 3, 4, 5, 6].map((i) => ({
      pkg: `pkg-${i}`,
      version: '1.0.0',
      auditor: `github:auditor-${i}`,
    })),
  }

  test('7 auditors in one lockfile: batches of 3, 3 and 1, then nothing is left', async () => {
    writeAccruals(SEVEN_AUDITORS, 'TXID-SEVEN')
    const submit: SubmitCreditMock = vi.fn(async (_app, seq) => `CREDIT-${seq}`)
    const client = stubClient(true, submit)

    for (const batchSeq of [1, 2, 3]) {
      expect(await runCreditStep(client, envWithApp())).toEqual({
        ran: true,
        batchSeq,
        creditTxid: `CREDIT-${batchSeq}`,
      })
    }
    expect(await runCreditStep(client, envWithApp())).toEqual({
      ran: false,
      reason: 'nothing-to-credit',
    })

    expect(submit.mock.calls.map((call) => call[2])).toEqual([3000, 3000, 1000])
    expect(submit.mock.calls.map((call) => call[4].length)).toEqual([3, 3, 1])
    for (const call of submit.mock.calls) {
      expect(() => buildCreditCallRefs(call[4], PAY_TO, 31566704n)).not.toThrow()
    }
    const uncredited = db
      .prepare('SELECT COUNT(*) AS n FROM accruals WHERE batch_seq IS NULL')
      .get()
    expect(uncredited).toEqual({ n: 0 })
  })
})
