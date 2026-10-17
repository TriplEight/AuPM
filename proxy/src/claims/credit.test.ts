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
  getPayee,
  openBatch,
  listCreditCandidates,
  recordBatchCreditTxid,
  freezeShares,
  releaseShares,
  slashShares,
  forfeitShares,
  upsertPayee,
} = await import('./ledger.js')
const { setStatus } = await import('../status.js')
const {
  runCreditStep,
  buildAlgodCreditClient,
  buildCreditGroup,
  innerTransferCount,
  onboardPayee,
  planCreditBatch,
  creditMethodArgs,
  CREDIT_METHOD_SIGNATURE,
  MAX_PAYOUTS_PER_GROUP,
} = await import('./credit.js')
type AccrualRow = import('./schema.js').AccrualRow
type Attribution = import('./attribution-rules.js').Attribution
type CreditChainClient = import('./credit.js').CreditChainClient
type PayoutAddressStatus = import('./credit.js').PayoutAddressStatus

const APP_ID = '123'
const PAY_TO = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

// Shares written at T0 unlock at T0 + HOLD.
const T0 = 1_000_000
const HOLD = 5_000
const MATURE = T0 + HOLD
const DAY = 24 * 60 * 60 * 1000

// The batch number the stub chain holds. A confirmed submit moves it.
let chainLast = 0

// Most tests pay a payee at 400 micro-USDC, one reviewer line.
function envWithApp(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return {
    PAYMENT_ROUTER_APP_ID: APP_ID,
    PAY_TO_ADDRESS: PAY_TO,
    PAYOUT_MIN: '400',
    ...overrides,
  }
}

type SubmitCreditMock = ReturnType<typeof vi.fn<CreditChainClient['submitCredit']>>

function makeSubmitMock(txid = 'CREDIT-TXID'): SubmitCreditMock {
  return vi.fn(async (_app, seq) => {
    chainLast = seq
    return txid
  })
}

/** The arguments of `mock`'s first call. Throws if it was never called. */
function firstCallArgs(mock: SubmitCreditMock): Parameters<CreditChainClient['submitCredit']> {
  const call = mock.mock.calls[0]
  if (!call) throw new Error('firstCallArgs: submitCredit was never called')
  return call
}

interface StubOptions {
  rekeyed?: boolean
  submit?: SubmitCreditMock
  /** Fixed on-chain batch number. The default follows the confirmed submits. */
  onChain?: number
  noteTxid?: string | null
  /** Check result per payout address. An address not listed is fine. */
  statuses?: Record<string, PayoutAddressStatus>
}

/** A stub CreditChainClient. `noteTxid` backs the pending-batch recovery path. */
function stubClient(options: StubOptions = {}): CreditChainClient {
  return {
    isPayToRekeyed: vi.fn(async () => options.rekeyed ?? true),
    submitCredit: options.submit ?? makeSubmitMock(),
    getOnChainLastBatchSeq: vi.fn(async () => options.onChain ?? chainLast),
    findCreditTxidByNote: vi.fn(async () => options.noteTxid ?? null),
    checkPayoutAddress: vi.fn(async (address) => options.statuses?.[address] ?? 'ok'),
  }
}

const ADDR = (identity: string) => `ADDR-${identity.replace('github:', '')}`

function onboard(identity: string, onboardedAt = T0): void {
  upsertPayee(identity, ADDR(identity), onboardedAt, onboardedAt)
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

/** A lockfile of `count` packages, all reviewed by `identity`. */
function lockfileOf(count: number, identity: string, prefix = 'pkg'): Attribution {
  return {
    route: 'lockfile',
    priceMicro: count * 1000,
    packages: Array.from({ length: count }, (_, i) => ({
      pkg: `${prefix}-${i}`,
      version: '1.0.0',
      auditor: identity,
    })),
  }
}

beforeEach(() => {
  chainLast = 0
  db.exec('DELETE FROM accruals')
  db.exec('DELETE FROM batches')
  db.exec('DELETE FROM batch_payouts')
  db.exec('DELETE FROM payees')
  db.exec('DELETE FROM payouts')
  db.exec('DELETE FROM audit_status')
  onboard('github:alice')
  onboard('github:bob')
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
    const client = stubClient()
    const outcome = await runCreditStep(client, {}, T0)
    expect(outcome).toEqual({ ran: false, reason: 'app-id-unset' })
    expect(client.submitCredit).not.toHaveBeenCalled()
    expect(client.isPayToRekeyed).not.toHaveBeenCalled()
  })

  test('payTo not rekeyed: no credit call, reason payto-not-rekeyed', async () => {
    const client = stubClient({ rekeyed: false })
    write(LOCKFILE_ATTRIBUTION, 'TXID-NOTREKEYED')
    const outcome = await runCreditStep(client, envWithApp(), T0)
    expect(outcome).toEqual({ ran: false, reason: 'payto-not-rekeyed' })
    expect(client.submitCredit).not.toHaveBeenCalled()
  })

  test('nothing to credit: no credit call, reason nothing-to-credit', async () => {
    const client = stubClient()
    const outcome = await runCreditStep(client, envWithApp(), T0)
    expect(outcome).toEqual({ ran: false, reason: 'nothing-to-credit' })
    expect(client.submitCredit).not.toHaveBeenCalled()
  })
})

describe('runCreditStep: exact credit() arguments', () => {
  test('before the hold ends: newTotal counts the payments, nothing is paid out', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-1')
    const submit = makeSubmitMock('CREDIT-TXID-1')

    const outcome = await runCreditStep(stubClient({ submit }), envWithApp(), T0 + 1)
    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-1' })

    expect(firstCallArgs(submit)).toEqual([
      123n,
      1,
      { newTotalMicro: 2000, unattributedMicro: 0, treasuryExtraMicro: 0, payouts: [] },
    ])
    const batchRow = db.prepare('SELECT * FROM batches WHERE app_id = 123 AND batch_seq = 1').get()
    expect(batchRow).toMatchObject({
      credit_txid: 'CREDIT-TXID-1',
      new_total_micro: 2000,
      unattributed_micro: 0,
      treasury_extra_micro: 0,
    })
  })

  test('after the hold ends: payouts per payee, unallocated shares as treasuryExtra, newTotal 0', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-2')
    const submit = makeSubmitMock('CREDIT-TXID-2')
    const client = stubClient({ submit })
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
        payouts: [
          { identity: 'github:alice', address: 'ADDR-alice', amountMicro: 400 },
          { identity: 'github:bob', address: 'ADDR-bob', amountMicro: 400 },
        ],
      },
    ])
  })

  test('the first run after the hold carries newTotal and the matured shares together', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-3')
    const submit = makeSubmitMock()
    await runCreditStep(stubClient({ submit }), envWithApp(), MATURE)
    const totals = firstCallArgs(submit)[2]
    expect(totals.newTotalMicro).toBe(2000)
    expect(totals.treasuryExtraMicro).toBe(700)
    expect(totals.payouts).toHaveLength(2)
  })

  test('the payouts never name ops or treasury, and every amount is above 0', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-BATCH-4')
    const submit = makeSubmitMock()
    await runCreditStep(stubClient({ submit }), envWithApp(), MATURE)
    for (const payout of firstCallArgs(submit)[2].payouts) {
      expect(['ops', 'treasury']).not.toContain(payout.identity)
      expect(payout.amountMicro).toBeGreaterThan(0)
    }
  })

  test('two packages of one payee merge into one payout', async () => {
    write(lockfileOf(2, 'github:alice'), 'TXID-MERGE')
    const submit = makeSubmitMock()
    await runCreditStep(stubClient({ submit }), envWithApp(), MATURE)
    expect(firstCallArgs(submit)[2].payouts).toEqual([
      { identity: 'github:alice', address: 'ADDR-alice', amountMicro: 800 },
    ])
  })

  test('an unmatched inflow goes into unattributedTotal (treasury), not into payouts or newTotal', async () => {
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
    const outcome = await runCreditStep(stubClient({ submit }), envWithApp(), T0 + 1)
    expect(outcome.ran).toBe(true)

    expect(firstCallArgs(submit)[2]).toEqual({
      newTotalMicro: 2000,
      unattributedMicro: 5000,
      treasuryExtraMicro: 0,
      payouts: [],
    })
  })
})

describe('runCreditStep: payout thresholds', () => {
  // Reviewer lines of 400 each: n packages are a balance of 400n.
  const RULES = { PAYOUT_MIN: '1200', PAYOUT_DUST: '800', PAYOUT_FLOOR: '400' }

  async function paidAfter(
    packages: number,
    idleMs: number,
    rules: Record<string, string> = RULES,
    lastPayoutAt: number | null = null,
  ): Promise<boolean> {
    write(lockfileOf(packages, 'github:alice'), `TXID-RULE-${randomUUID()}`)
    // The payee onboarded at T0. A set last payout replaces the onboarding date.
    if (lastPayoutAt !== null) {
      db.prepare("UPDATE payees SET last_payout_at = ? WHERE identity = 'github:alice'").run(
        lastPayoutAt,
      )
    }
    const submit = makeSubmitMock()
    const now = (lastPayoutAt ?? T0) + idleMs
    await runCreditStep(stubClient({ submit }), envWithApp(rules), now)
    return submit.mock.calls.some((call) => call[2].payouts.length === 1)
  }

  test('rule a: a balance at the minimum is paid on any night', async () => {
    expect(await paidAfter(3, HOLD)).toBe(true)
  })

  test('rule a: a balance just below the minimum is not paid while the payee is young', async () => {
    expect(await paidAfter(3, HOLD, { ...RULES, PAYOUT_MIN: '1201' })).toBe(false)
    expect(db.prepare('SELECT COUNT(*) AS n FROM batch_payouts').get()).toEqual({ n: 0 })
  })

  test('rule b: a balance at the dust level is paid when the last payout is 7 days old', async () => {
    expect(await paidAfter(2, 7 * DAY)).toBe(true)
  })

  test('rule b: one millisecond short of 7 days is not paid', async () => {
    expect(await paidAfter(2, 7 * DAY - 1)).toBe(false)
  })

  test('rule b: a balance just below the dust level is not paid at 7 days', async () => {
    expect(await paidAfter(2, 7 * DAY, { ...RULES, PAYOUT_DUST: '801' })).toBe(false)
  })

  test('rule c: a balance at the floor is paid when the last payout is 30 days old', async () => {
    expect(await paidAfter(1, 30 * DAY)).toBe(true)
  })

  test('rule c: one millisecond short of 30 days is not paid', async () => {
    expect(await paidAfter(1, 30 * DAY - 1)).toBe(false)
  })

  test('rule c: a balance just below the floor is not paid at 30 days', async () => {
    expect(await paidAfter(1, 30 * DAY, { ...RULES, PAYOUT_FLOOR: '401' })).toBe(false)
  })

  test('a never-paid payee counts its onboarding date as the last payout', async () => {
    db.prepare("UPDATE payees SET onboarded_at = ? WHERE identity = 'github:alice'").run(
      T0 - 8 * DAY,
    )
    write(lockfileOf(2, 'github:alice'), 'TXID-ONBOARD')
    const submit = makeSubmitMock()
    await runCreditStep(stubClient({ submit }), envWithApp(RULES), MATURE)
    expect(firstCallArgs(submit)[2].payouts).toHaveLength(1)
  })

  test('a recorded last payout replaces the onboarding date', async () => {
    db.prepare("UPDATE payees SET onboarded_at = ? WHERE identity = 'github:alice'").run(
      T0 - 40 * DAY,
    )
    // Paid 1 day ago: neither the 7 nor the 30 days rule applies.
    expect(await paidAfter(2, DAY, RULES, MATURE - DAY)).toBe(false)
  })

  test('below every rule the share stays in the ledger and pays later', async () => {
    write(lockfileOf(1, 'github:alice'), 'TXID-LATER')
    const submit = makeSubmitMock()
    const client = stubClient({ submit })
    await runCreditStep(client, envWithApp(RULES), MATURE)
    const unpaid = "SELECT COUNT(*) AS n FROM accruals WHERE role = 'reviewer' AND paid_seq IS NULL"
    expect(db.prepare(unpaid).get()).toEqual({ n: 1 })

    await runCreditStep(client, envWithApp(RULES), T0 + 30 * DAY)
    expect(db.prepare(unpaid).get()).toEqual({ n: 0 })
  })

  test('the thresholds default to 1,000,000, 100,000 and 10,000', async () => {
    const defaults = { PAYMENT_ROUTER_APP_ID: APP_ID, PAY_TO_ADDRESS: PAY_TO }
    const outcomes: boolean[] = []
    for (const [packages, idle] of [
      [2500, 0], // 1,000,000: paid on any night
      [2499, 0], // 999,600: not paid
    ] as const) {
      db.exec('DELETE FROM accruals')
      db.exec('DELETE FROM batches')
      db.exec('DELETE FROM batch_payouts')
      write(lockfileOf(packages, 'github:alice'), `TXID-DEF-${packages}`)
      const submit = makeSubmitMock()
      await runCreditStep(stubClient({ submit, onChain: 0 }), defaults, MATURE + idle)
      outcomes.push(submit.mock.calls.some((call) => call[2].payouts.length === 1))
    }
    expect(outcomes).toEqual([true, false])
  })
})

describe('runCreditStep: opt-in check', () => {
  test('an opted-out payee is left out, keeps its balance and the run logs it', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-OPTOUT')
    const submit = makeSubmitMock()
    const logs: string[] = []
    const client = stubClient({ submit, statuses: { 'ADDR-alice': 'not-opted-in' } })
    await runCreditStep(client, envWithApp(), MATURE, (line) => logs.push(line))

    expect(firstCallArgs(submit)[2].payouts).toEqual([
      { identity: 'github:bob', address: 'ADDR-bob', amountMicro: 400 },
    ])
    const alice = db
      .prepare(
        "SELECT paid_seq FROM accruals WHERE identity = 'github:alice' AND role = 'reviewer'",
      )
      .get()
    expect(alice).toEqual({ paid_seq: null })
    expect(logs.join('\n')).toMatch(/github:alice.*400 micro-USDC.*not-opted-in/)
  })

  test('a frozen payee is left out and keeps its balance', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-FROZEN-ADDR')
    const submit = makeSubmitMock()
    const logs: string[] = []
    const client = stubClient({ submit, statuses: { 'ADDR-bob': 'frozen' } })
    await runCreditStep(client, envWithApp(), MATURE, (line) => logs.push(line))

    expect(firstCallArgs(submit)[2].payouts.map((p) => p.identity)).toEqual(['github:alice'])
    expect(logs.join('\n')).toMatch(/github:bob.*frozen/)
    const bob = db
      .prepare("SELECT paid_seq FROM accruals WHERE identity = 'github:bob' AND role = 'reviewer'")
      .get()
    expect(bob).toEqual({ paid_seq: null })
  })

  test('the payee is paid on a later night once it opts in', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-LATER-OPTIN')
    const submit = makeSubmitMock()
    const statuses: Record<string, PayoutAddressStatus> = { 'ADDR-alice': 'not-opted-in' }
    const client = stubClient({ submit, statuses })
    await runCreditStep(client, envWithApp(), MATURE)
    statuses['ADDR-alice'] = 'ok'
    await runCreditStep(client, envWithApp(), MATURE + 1)
    expect(submit.mock.calls[1]?.[2].payouts).toEqual([
      { identity: 'github:alice', address: 'ADDR-alice', amountMicro: 400 },
    ])
  })

  test('every candidate address is checked and the check time is recorded', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-CHECKED')
    const client = stubClient()
    await runCreditStep(client, envWithApp(), MATURE)
    expect(client.checkPayoutAddress).toHaveBeenCalledWith('ADDR-alice')
    expect(client.checkPayoutAddress).toHaveBeenCalledWith('ADDR-bob')
    expect(getPayee('github:alice')?.last_optin_check).toBe(MATURE)
  })

  test('a payee below its payout rule is not checked', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-NOT-DUE')
    const client = stubClient()
    await runCreditStep(client, envWithApp({ PAYOUT_MIN: '401' }), MATURE)
    expect(client.checkPayoutAddress).not.toHaveBeenCalled()
  })

  test('an address equal to payTo is left out: credit() would fail whole', async () => {
    upsertPayee('github:alice', PAY_TO, T0, T0)
    write(LOCKFILE_ATTRIBUTION, 'TXID-RESERVED')
    const submit = makeSubmitMock()
    await runCreditStep(stubClient({ submit }), envWithApp(), MATURE)
    expect(firstCallArgs(submit)[2].payouts.map((p) => p.identity)).toEqual(['github:bob'])
  })

  test('a balance with no payee row stays in the ledger and is logged', async () => {
    db.exec('DELETE FROM payees')
    write(LOCKFILE_ATTRIBUTION, 'TXID-UNMAPPED')
    const submit = makeSubmitMock()
    const logs: string[] = []
    await runCreditStep(stubClient({ submit }), envWithApp(), MATURE, (line) => logs.push(line))
    expect(firstCallArgs(submit)[2].payouts).toEqual([])
    expect(logs.join('\n')).toMatch(/github:alice has a matured balance but no payout address/)
  })
})

describe('runCreditStep: freeze, release, slash, forfeit', () => {
  const MS = { pkg: 'ms', version: '2.1.3' }
  const ALICE_PAYOUT = { identity: 'github:alice', address: 'ADDR-alice', amountMicro: 400 }

  async function runAt(now: number): Promise<SubmitCreditMock> {
    const submit = makeSubmitMock()
    await runCreditStep(stubClient({ submit }), envWithApp(), now)
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
    freezeShares({ ...MS, role: 'reviewer' }, T0 + 1)
    const totals = firstCallArgs(await runAt(MATURE))[2]
    expect(totals.payouts).toEqual([])
    expect(totals.newTotalMicro).toBe(1000)
    expect(totals.treasuryExtraMicro).toBe(350)
  })

  test('a freeze after the hold ends does not touch a matured share', async () => {
    expect(freezeShares({ ...MS, role: 'reviewer' }, MATURE)).toBe(0)
    const totals = firstCallArgs(await runAt(MATURE + 1))[2]
    expect(totals.payouts).toEqual([ALICE_PAYOUT])
  })

  test('a matured share that waits for its threshold is out of reach of a freeze', async () => {
    const waiting = envWithApp({ PAYOUT_MIN: '1000000' })
    await runCreditStep(stubClient(), waiting, MATURE)
    expect(freezeShares({ ...MS, role: 'reviewer' }, MATURE + DAY)).toBe(0)
    expect(slashShares(MS)).toBe(0)
    const unpaid = db
      .prepare(
        "SELECT COUNT(*) AS n FROM accruals WHERE role = 'reviewer' AND paid_seq IS NULL AND frozen = 0",
      )
      .get()
    expect(unpaid).toEqual({ n: 1 })
  })

  test('a released share is credited once it has matured', async () => {
    freezeShares({ ...MS, role: 'reviewer' }, T0 + 1)
    await runAt(MATURE) // counts the payment, credits nothing for the reviewer
    releaseShares({ ...MS, role: 'reviewer' })
    const totals = firstCallArgs(await runAt(MATURE + 1))[2]
    expect(totals.payouts).toEqual([ALICE_PAYOUT])
    expect(totals.newTotalMicro).toBe(0)
  })

  test('a released share that has not matured waits for its unlock time', async () => {
    freezeShares({ ...MS, role: 'reviewer' }, T0 + 1)
    releaseShares({ ...MS, role: 'reviewer' })
    const totals = firstCallArgs(await runAt(T0 + 1))[2]
    expect(totals.payouts).toEqual([])
  })

  test('a slashed reviewer share goes to treasuryExtra at once, before the hold ends', async () => {
    freezeShares({ ...MS, role: 'reviewer' }, T0 + 1)
    slashShares(MS)
    const totals = firstCallArgs(await runAt(T0 + 1))[2]
    expect(totals.payouts).toEqual([])
    expect(totals.treasuryExtraMicro).toBe(400)
  })

  test('a slashed share is credited once: not again in a later batch', async () => {
    freezeShares({ ...MS, role: 'reviewer' }, T0 + 1)
    slashShares(MS)
    await runAt(MATURE)
    const next = await runAt(MATURE + 1)
    expect(next).not.toHaveBeenCalled()
  })

  test('a forfeited maintainer share goes to treasuryExtra at once', async () => {
    db.prepare(
      "UPDATE accruals SET identity = 'github:carol', treasury_kind = NULL WHERE role = 'maintainer'",
    ).run()
    freezeShares({ ...MS, role: 'maintainer' }, T0 + 1)
    forfeitShares(MS)
    const totals = firstCallArgs(await runAt(T0 + 1))[2]
    expect(totals.treasuryExtraMicro).toBe(250)
    expect(totals.payouts).toEqual([])
  })
})

describe('runCreditStep: batch resend after a crash', () => {
  test('a batch whose txid is recorded is never re-sent', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-ONCE')
    const submit = makeSubmitMock('CREDIT-TXID-ONCE')
    const client = stubClient({ submit })

    const first = await runCreditStep(client, envWithApp(), T0 + 1)
    expect(first).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-ONCE' })

    const second = await runCreditStep(client, envWithApp(), T0 + 2)
    expect(second).toEqual({ ran: false, reason: 'nothing-to-credit' })
    expect(submit).toHaveBeenCalledTimes(1)
  })

  test('a recorded txid stamps the paid payees with the run time', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-STAMPED')
    await runCreditStep(stubClient(), envWithApp(), MATURE)
    expect(getPayee('github:alice')?.last_payout_at).toBe(MATURE)
    expect(getPayee('github:bob')?.last_payout_at).toBe(MATURE)
  })

  test('a batch row without a txid (crash after assign) is resent with its stored totals', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-CRASH')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('network dropped')
    })

    await expect(
      runCreditStep(stubClient({ submit: failing }), envWithApp(), MATURE),
    ).rejects.toThrow('network dropped')
    const pending = db.prepare('SELECT * FROM batches').all() as { batch_seq: number }[]
    expect(pending).toHaveLength(1)

    // The address changes after the crash: the resend still pays the stored one.
    upsertPayee('github:alice', 'ADDR-alice-new', T0, T0)
    const retrySubmit = makeSubmitMock('CREDIT-TXID-RETRY')
    // A later clock must not change the resend: the stored rows decide.
    const outcome = await runCreditStep(
      stubClient({ submit: retrySubmit }),
      envWithApp(),
      MATURE + 999,
    )

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-RETRY' })
    expect(retrySubmit).toHaveBeenCalledTimes(1)
    expect(firstCallArgs(retrySubmit)[2]).toEqual(firstCallArgs(failing)[2])
    expect(firstCallArgs(retrySubmit)[2].payouts[0]?.address).toBe('ADDR-alice')
    expect(db.prepare('SELECT * FROM batches').all()).toHaveLength(1)
  })

  test('a pending batch already credited on-chain is not resent; its txid is recovered from the note', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-CONFIRMED-NOT-RECORDED')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('response lost after confirmation')
    })
    await expect(
      runCreditStep(stubClient({ submit: failing }), envWithApp(), T0 + 1),
    ).rejects.toThrow('response lost after confirmation')

    const recoverySubmit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    const recoveryClient = stubClient({
      submit: recoverySubmit,
      onChain: 1,
      noteTxid: 'RECOVERED-TXID',
    })
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
    await expect(
      runCreditStep(stubClient({ submit: failing }), envWithApp(), T0 + 1),
    ).rejects.toThrow('response lost after confirmation')

    const unrecoverableSubmit = makeSubmitMock('SHOULD-NEVER-BE-SENT')
    await expect(
      runCreditStep(
        stubClient({ submit: unrecoverableSubmit, onChain: 1, noteTxid: null }),
        envWithApp(),
        T0 + 2,
      ),
    ).rejects.toThrow(/already credited on-chain/)
    expect(unrecoverableSubmit).not.toHaveBeenCalled()

    const batchRow = db
      .prepare('SELECT credit_txid FROM batches WHERE app_id = 123 AND batch_seq = 1')
      .get() as { credit_txid: string | null }
    expect(batchRow.credit_txid).toBeNull()
  })

  test('a pending batch whose payee now fails the check is released and planned again without it', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-PENDING-OPTOUT')
    const failing: SubmitCreditMock = vi.fn(async () => {
      throw new Error('network dropped')
    })
    await expect(
      runCreditStep(stubClient({ submit: failing }), envWithApp(), MATURE),
    ).rejects.toThrow('network dropped')

    const submit = makeSubmitMock('CREDIT-REPLANNED')
    const client = stubClient({ submit, statuses: { 'ADDR-alice': 'not-opted-in' } })
    const outcome = await runCreditStep(client, envWithApp(), MATURE + 1)

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-REPLANNED' })
    const totals = firstCallArgs(submit)[2]
    expect(totals.newTotalMicro).toBe(2000)
    expect(totals.payouts.map((p) => p.identity)).toEqual(['github:bob'])
    expect(db.prepare('SELECT COUNT(*) AS n FROM batches').get()).toEqual({ n: 1 })
  })
})

describe('runCreditStep: batch numbers follow the chain and the configured app', () => {
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

    const outcome = await runCreditStep(stubClient({ submit, onChain: 0 }), envWithApp(), T0 + 1)

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
    await runCreditStep(
      stubClient({ submit: makeSubmitMock('CREDIT-NEW-APP'), onChain: 0 }),
      envWithApp(),
      T0 + 1,
    )

    write(LOCKFILE_ATTRIBUTION, 'TXID-BACK')
    const submit = makeSubmitMock('CREDIT-BACK')
    const outcome = await runCreditStep(
      stubClient({ submit, onChain: 6 }),
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

    const outcome = await runCreditStep(stubClient({ submit, onChain: 0 }), envWithApp(), T0 + 1)

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-NEW-APP' })
    expect(firstCallArgs(submit)[2].newTotalMicro).toBe(2000)
  })

  test('a chain ahead of the ledger with no pending batch stops the run', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-RESUME')
    const submit = makeSubmitMock('CREDIT-RESUME')
    await expect(
      runCreditStep(stubClient({ submit, onChain: 5 }), envWithApp(), T0 + 1),
    ).rejects.toThrow(/ledger holds batch 0.*lastBatchSeq is 5/)
    expect(submit).not.toHaveBeenCalled()
  })

  test('a ledger ahead of the chain with no pending batch stops the run', async () => {
    write(LOCKFILE_ATTRIBUTION, 'TXID-AHEAD')
    await runCreditStep(stubClient(), envWithApp(), T0 + 1)
    write(LOCKFILE_ATTRIBUTION, 'TXID-AHEAD-2')
    const submit = makeSubmitMock()
    await expect(
      runCreditStep(stubClient({ submit, onChain: 0 }), envWithApp(), T0 + 2),
    ).rejects.toThrow(/ledger holds batch 1.*lastBatchSeq is 0/)
    expect(submit).not.toHaveBeenCalled()
  })
})

describe('credit() ABI', () => {
  test('the signature has the 5 arguments of the contract', () => {
    expect(CREDIT_METHOD_SIGNATURE).toBe(
      'credit(uint64,uint64,uint64,uint64,(address,uint64)[])void',
    )
  })

  test('the arguments encode with the ABI types in the order batchSeq, newTotal, unattributed, treasuryExtra, payouts', () => {
    const method = algosdk.ABIMethod.fromSignature(CREDIT_METHOD_SIGNATURE)
    const receiver = algosdk.generateAccount().addr.toString()
    const args = creditMethodArgs(7, {
      newTotalMicro: 2000,
      unattributedMicro: 5000,
      treasuryExtraMicro: 700,
      payouts: [{ identity: 'github:alice', address: receiver, amountMicro: 400 }],
    })
    expect(args).toEqual([7n, 2000n, 5000n, 700n, [[receiver, 400n]]])
    expect(method.args).toHaveLength(5)
    args.forEach((arg, i) => {
      const type = method.args[i]?.type
      if (typeof type === 'string') throw new Error('expected a value argument type')
      expect(() => type?.encode(arg as never)).not.toThrow()
    })
  })
})

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
  const ADDRESSES = { 'github:a': 'ADDR-a' }

  test('no rows: an empty plan', () => {
    expect(planCreditBatch([], ADDRESSES, 1000)).toEqual({
      counted: [],
      paid: [],
      addresses: ADDRESSES,
    })
  })

  test('a share before its unlock time is counted but not paid', () => {
    const row = share('p0', 'github:a')
    expect(planCreditBatch([row], ADDRESSES, 99)).toMatchObject({ counted: [row], paid: [] })
    expect(planCreditBatch([row], ADDRESSES, 100).paid).toEqual([row])
  })

  test('a frozen share is never paid', () => {
    const row = share('p0', 'github:a', { frozen: 1 })
    expect(planCreditBatch([row], ADDRESSES, 1000).paid).toEqual([])
  })

  test('a payee outside the addresses is not paid', () => {
    const row = share('p0', 'github:other')
    expect(planCreditBatch([row], ADDRESSES, 1000).paid).toEqual([])
  })

  test('a share already credited is not paid again, and a counted payment is not counted again', () => {
    const row = share('p0', 'github:a', { batch_seq: 1, paid_seq: 1 })
    expect(planCreditBatch([row], ADDRESSES, 1000)).toMatchObject({ counted: [], paid: [] })
  })

  test('off-the-top rows are counted and never paid', () => {
    const ops = share('p0', 'ops', { role: 'ops', amount_micro: 50, unlock_at: 0 })
    const cut = share('p0', 'treasury', {
      role: 'treasury',
      treasury_kind: 'cut',
      amount_micro: 200,
      unlock_at: 0,
    })
    expect(planCreditBatch([ops, cut], ADDRESSES, 1000)).toMatchObject({
      counted: [ops, cut],
      paid: [],
    })
  })

  test('matured unallocated, slash and forfeit rows are all paid in the first batch', () => {
    const kinds = ['unallocated', 'slash', 'forfeit'].map((kind) =>
      share('p0', 'treasury', { treasury_kind: kind, role: 'maintainer' }),
    )
    expect(planCreditBatch(kinds, {}, 1000).paid).toEqual(kinds)
  })

  test('every share of an admitted payee is paid, across packages', () => {
    const rows = Array.from({ length: 30 }, (_, i) => share(`p${i}`, 'github:a'))
    expect(planCreditBatch(rows, ADDRESSES, 1000).paid).toHaveLength(30)
  })
})

describe('runCreditStep: a backlog over the group limit splits into batches', () => {
  function writePayees(count: number): void {
    write(
      {
        route: 'lockfile',
        priceMicro: count * 1000,
        packages: Array.from({ length: count }, (_, i) => ({
          pkg: `pkg-${i}`,
          version: '1.0.0',
          auditor: `github:auditor-${i}`,
        })),
      },
      'TXID-MANY',
    )
    for (let i = 0; i < count; i++) onboard(`github:auditor-${i}`)
  }

  test('the group limit is 50 payouts', () => {
    expect(MAX_PAYOUTS_PER_GROUP).toBe(50)
    expect(Math.floor((2048 - 4 - 4 * 8 - 2) / 40)).toBe(MAX_PAYOUTS_PER_GROUP)
  })

  test('105 payees: three batches of 50, 50 and 5; only the first has newTotal and treasuryExtra', async () => {
    writePayees(105)
    const submit: SubmitCreditMock = vi.fn(async (_app, seq) => {
      chainLast = seq
      return `CREDIT-${seq}`
    })
    const client = stubClient({ submit })

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
    expect(totals.map((t) => t.newTotalMicro)).toEqual([105_000, 0, 0])
    expect(totals.map((t) => t.treasuryExtraMicro)).toEqual([105 * 350, 0, 0])
    expect(totals.map((t) => t.payouts.length)).toEqual([50, 50, 5])
    expect(submit.mock.calls.map((call) => call[1])).toEqual([1, 2, 3])
    const paid = totals.flatMap((t) => t.payouts).reduce((sum, p) => sum + p.amountMicro, 0)
    expect(paid).toBe(105 * 400)
    const open = db.prepare('SELECT COUNT(*) AS n FROM accruals WHERE batch_seq IS NULL').get()
    expect(open).toEqual({ n: 0 })
  })

  test('a payee that fails the check does not use a slot of the group', async () => {
    writePayees(51)
    const submit = makeSubmitMock()
    const client = stubClient({ submit, statuses: { 'ADDR-auditor-0': 'not-opted-in' } })
    await runCreditStep(client, envWithApp(), MATURE)
    const identities = firstCallArgs(submit)[2].payouts.map((p) => p.identity)
    expect(identities).toHaveLength(50)
    expect(identities).not.toContain('github:auditor-0')
  })
})

describe('buildCreditGroup', () => {
  const ASSET_ID = 31566704n
  const MIN_FEE = 1000n
  const payTo = algosdk.generateAccount().addr.toString()
  const ops = algosdk.generateAccount().addr.toString()
  const treasury = algosdk.generateAccount().addr.toString()
  const sender = algosdk.generateAccount().addr.toString()

  const suggestedParams: algosdk.SuggestedParams = {
    fee: 0n,
    flatFee: false,
    firstValid: 1000n,
    lastValid: 2000n,
    genesisID: 'testnet-v1.0',
    genesisHash: new Uint8Array(32),
    minFee: MIN_FEE,
  }

  function payoutsOf(count: number): { identity: string; address: string; amountMicro: number }[] {
    return Array.from({ length: count }, (_, i) => ({
      identity: `github:p${i}`,
      address: algosdk.generateAccount().addr.toString(),
      amountMicro: 400,
    }))
  }

  function group(count: number, newTotalMicro = 1_000_000) {
    const totals = {
      newTotalMicro,
      unattributedMicro: 0,
      treasuryExtraMicro: 0,
      payouts: payoutsOf(count),
    }
    const atc = buildCreditGroup({
      appId: 123n,
      sender,
      signer: algosdk.makeEmptyTransactionSigner(),
      suggestedParams,
      batchSeq: 4,
      totals,
      payTo,
      opsAddress: ops,
      treasuryAddress: treasury,
      assetId: ASSET_ID,
    })
    return { totals, txns: atc.buildGroup().map((entry) => entry.txn) }
  }

  test('50 payouts: one credit() call and 8 refs() calls of 7, 7, 7, 7, 7, 7, 7 and 1 accounts', () => {
    const { txns, totals } = group(50)
    expect(txns).toHaveLength(9)
    const refs = txns.slice(1)
    expect(refs.map((t) => t.applicationCall?.accounts.length)).toEqual([7, 7, 7, 7, 7, 7, 7, 1])
    const named = refs.flatMap((t) => (t.applicationCall?.accounts ?? []).map((a) => a.toString()))
    expect(named).toEqual(totals.payouts.map((p) => p.address))
  })

  test('every refs() call carries the USDC asset', () => {
    for (const txn of group(50).txns.slice(1)) {
      expect(txn.applicationCall?.foreignAssets).toEqual([ASSET_ID])
    }
  })

  test('credit() carries payTo, ops, treasury and the USDC asset', () => {
    const credit = group(3).txns[0]?.applicationCall
    expect(credit?.accounts.map((a) => a.toString())).toEqual([payTo, ops, treasury])
    expect(credit?.foreignAssets).toEqual([ASSET_ID])
    expect(credit?.appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature(CREDIT_METHOD_SIGNATURE).getSelector(),
    )
  })

  test('the credit() note names the batch', () => {
    const note = group(1).txns[0]?.note
    expect(new TextDecoder().decode(note)).toBe('aupm:credit:4')
  })

  test('no payouts: a credit() call alone, no refs() call', () => {
    expect(group(0).txns).toHaveLength(1)
  })

  test('the outer fee of credit() covers every inner transfer; refs() calls pay their own minimum', () => {
    const { txns } = group(50)
    // 50 payouts + ops + treasury = 52 inner transfers
    expect(txns[0]?.fee).toBe(MIN_FEE * 53n)
    for (const txn of txns.slice(1)) expect(txn.fee).toBe(MIN_FEE)
  })

  test('the contract skips a transfer of 0, so the fee skips it too', () => {
    // newTotal 4: ops = 0 and cut = 0, so only the payouts are inner transfers
    const { txns, totals } = group(2, 4)
    expect(innerTransferCount(totals)).toBe(2)
    expect(txns[0]?.fee).toBe(MIN_FEE * 3n)
  })

  test('treasury money alone adds the treasury transfer', () => {
    const { totals } = group(1, 0)
    expect(innerTransferCount({ ...totals, treasuryExtraMicro: 1 })).toBe(2)
    expect(innerTransferCount({ ...totals, unattributedMicro: 1 })).toBe(2)
    expect(innerTransferCount(totals)).toBe(1)
  })

  test('the group holds at most 16 transactions: more than 105 receivers throw', () => {
    expect(group(105).txns).toHaveLength(16)
    expect(() => group(106)).toThrow(/over the limit of 15/)
  })

  test('one receiver named twice is named once', () => {
    const [first] = payoutsOf(1)
    if (!first) throw new Error('no payout')
    const atc = buildCreditGroup({
      appId: 123n,
      sender,
      signer: algosdk.makeEmptyTransactionSigner(),
      suggestedParams,
      batchSeq: 1,
      totals: {
        newTotalMicro: 0,
        unattributedMicro: 0,
        treasuryExtraMicro: 0,
        payouts: [first, { ...first, identity: 'github:twin' }],
      },
      payTo,
      opsAddress: ops,
      treasuryAddress: treasury,
      assetId: ASSET_ID,
    })
    expect(atc.buildGroup()[1]?.txn.applicationCall?.accounts).toHaveLength(1)
  })
})

describe('buildAlgodCreditClient: checkPayoutAddress', () => {
  function clientWith(info: () => Promise<unknown>): CreditChainClient {
    const algod = {
      accountAssetInformation: () => ({ do: info }),
    } as unknown as algosdk.Algodv2
    const account = algosdk.generateAccount()
    return buildAlgodCreditClient(
      algod,
      {} as algosdk.Indexer,
      algosdk.secretKeyToMnemonic(account.sk),
      PAY_TO,
      31566704n,
    )
  }

  test('a holding that is not frozen is ok', async () => {
    const client = clientWith(async () => ({ assetHolding: { isFrozen: false } }))
    expect(await client.checkPayoutAddress('ADDR')).toBe('ok')
  })

  test('a frozen holding is frozen', async () => {
    const client = clientWith(async () => ({ assetHolding: { isFrozen: true } }))
    expect(await client.checkPayoutAddress('ADDR')).toBe('frozen')
  })

  test('a 404 from algod is not-opted-in', async () => {
    const client = clientWith(async () => {
      throw Object.assign(new Error('not found'), { response: { status: 404 } })
    })
    expect(await client.checkPayoutAddress('ADDR')).toBe('not-opted-in')
  })

  test('a response with no holding is not-opted-in', async () => {
    const client = clientWith(async () => ({}))
    expect(await client.checkPayoutAddress('ADDR')).toBe('not-opted-in')
  })

  test('any other algod failure propagates', async () => {
    const client = clientWith(async () => {
      throw Object.assign(new Error('algod down'), { response: { status: 500 } })
    })
    await expect(client.checkPayoutAddress('ADDR')).rejects.toThrow('algod down')
  })
})

describe('onboardPayee', () => {
  const VALID = algosdk.generateAccount().addr.toString()

  test('an opted-in address is stored with the check time and the onboarding date', async () => {
    await onboardPayee(stubClient(), 'GitHub:Carol', VALID, 777)
    expect(getPayee('github:carol')).toEqual({
      identity: 'github:carol',
      payout_address: VALID,
      onboarded_at: 777,
      last_optin_check: 777,
      last_payout_at: null,
    })
  })

  test('an address that is not opted in is refused and nothing is stored', async () => {
    const client = stubClient({ statuses: { [VALID]: 'not-opted-in' } })
    await expect(onboardPayee(client, 'github:carol', VALID, 1)).rejects.toThrow(/not-opted-in/)
    expect(getPayee('github:carol')).toBeUndefined()
  })

  test('a frozen address is refused', async () => {
    const client = stubClient({ statuses: { [VALID]: 'frozen' } })
    await expect(onboardPayee(client, 'github:carol', VALID, 1)).rejects.toThrow(/frozen/)
  })

  test('a string that is not an address is refused before any chain call', async () => {
    const client = stubClient()
    await expect(onboardPayee(client, 'github:carol', 'nope', 1)).rejects.toThrow(
      /not an Algorand address/,
    )
    expect(client.checkPayoutAddress).not.toHaveBeenCalled()
  })
})
