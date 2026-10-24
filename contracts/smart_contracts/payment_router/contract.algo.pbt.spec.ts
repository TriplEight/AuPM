import { Bytes, op } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import * as fc from 'fast-check'
import { afterAll, describe, expect, test } from 'vitest'
import { PaymentRouter } from './contract.algo'
import {
  CAP_PERIOD,
  type Call,
  type Coverage,
  EMULATOR_SUCCESSES,
  expectCoverage,
  type Globals,
  initArb,
  type Label,
  Model,
  type Outcome,
  type Snap,
  type Sut,
  stepArb,
} from './pbt-model'

const DELAY = 4n
const WINDOW = 3n
const START_ROUND = 5n * CAP_PERIOD + 7n

const ctx = new TestExecutionContext()

type Account = ReturnType<typeof ctx.any.account>

const big = (v: unknown): bigint => BigInt(v as bigint)

// The emulator does not roll back state when a call fails, and it does not move USDC for
// inner transfers. This system under test undoes the first and mirrors the second.
class EmulatorSut implements Sut {
  readonly movesUsdc = false
  readonly hasGhost = false
  readonly canJumpPeriod = true

  private round = START_ROUND
  private readonly contract: PaymentRouter
  private readonly accounts = {} as Record<Label, Account>
  private readonly usdc: ReturnType<typeof ctx.any.asset>
  private readonly bal: Partial<Record<Label, bigint>> = {}
  private readonly labels = new Map<string, Label>()

  constructor(init: { carryIn: bigint; cap: bigint }) {
    ctx.reset()
    ctx.setTemplateVar('RELEASE_DELAY_ROUNDS', DELAY)
    ctx.setTemplateVar('RELEASE_WINDOW_ROUNDS', WINDOW)
    ctx.ledger.patchGlobalData({ round: this.round })
    this.usdc = ctx.any.asset()
    this.contract = ctx.contract.create(PaymentRouter)
    const names: Label[] = ['crediter', 'c2', 'stranger', 'alice', 'bob', 'ops', 'treasury']
    this.accounts.admin = ctx.defaultSender
    for (const n of [...names, 'ops2', 'trs2', 'payTo'] as Label[]) {
      this.accounts[n] = ctx.any.account()
    }
    this.accounts.app = ctx.ledger.getApplicationForContract(this.contract).address
    for (const [label, acct] of Object.entries(this.accounts)) {
      this.labels.set(acct.bytes.toString(), label as Label)
    }
    this.bal.payTo = init.carryIn
    ctx.ledger.updateAssetHolding(this.accounts.payTo, this.usdc, init.carryIn)
    const a = this.accounts
    this.scoped('admin', () =>
      this.contract.createApplication(
        a.payTo,
        this.usdc,
        init.carryIn,
        a.ops,
        a.treasury,
        init.cap,
      ),
    )
    this.scoped('admin', () => this.contract.setCrediter(a.crediter))
  }

  private scoped<T>(sender: Label, fn: () => T): T {
    const txn = ctx.any.txn.applicationCall({
      sender: this.accounts[sender],
      fee: 1000n,
      appId: this.contract,
    })
    return ctx.txn.createScope([txn], 0).execute(fn)
  }

  private label(acct: Account): Label {
    const l = this.labels.get(acct.bytes.toString())
    if (!l) throw new Error('unknown account in global state')
    return l
  }

  private labelOf(bytes: { toString(): string }): Label {
    const l = this.labels.get(bytes.toString())
    if (!l) throw new Error('unknown address bytes in global state')
    return l
  }

  async nextRound(): Promise<bigint> {
    return this.round
  }

  async deposit(amount: bigint): Promise<void> {
    this.bal.payTo = (this.bal.payTo ?? 0n) + amount
    ctx.ledger.updateAssetHolding(this.accounts.payTo, this.usdc, this.bal.payTo)
  }

  async advance(rounds: bigint): Promise<void> {
    this.round += rounds
    ctx.ledger.patchGlobalData({ round: this.round })
  }

  private globals(): Globals {
    const c = this.contract
    const pendingKey = c.pendingKey.value
    const pendingBytes = c.pendingValue.value
    let pendingValue = ''
    if (pendingKey === 'cap') pendingValue = `u:${big(op.btoi(pendingBytes))}`
    else if (pendingKey !== '') pendingValue = this.labelOf(pendingBytes)
    else if (big(pendingBytes.length) !== 0n) pendingValue = 'stale bytes'
    return {
      crediter: c.crediter.hasValue ? this.labelOf(c.crediter.value) : 'none',
      lastSeq: c.lastBatchSeq.hasValue ? big(c.lastBatchSeq.value) : 0n,
      poolIn: big(c.poolIn.value),
      poolOut: big(c.poolOut.value),
      declared: big(c.declaredTotal.value),
      paid: big(c.paidTotal.value),
      ops: this.labelOf(c.opsAddress.value),
      treasury: this.labelOf(c.treasuryAddress.value),
      cap: big(c.payoutCap.value),
      periodIndex: big(c.capPeriodIndex.value),
      paidInPeriod: big(c.paidInPeriod.value),
      pendingKey,
      pendingValue,
      pendingRound: big(c.pendingRound.value),
      announcedTo: c.announcedTo.hasValue ? this.labelOf(c.announcedTo.value) : 'none',
      announcedRound: c.announcedRound.hasValue ? big(c.announcedRound.value) : 0n,
      retired: c.retired.hasValue ? c.retired.value : false,
      delay: big(c.releaseDelay.value),
      window: big(c.releaseWindow.value),
    }
  }

  async snapshot(): Promise<Snap> {
    return { globals: this.globals(), bal: { ...this.bal } }
  }

  private action(call: Call): () => void {
    const c = this.contract
    const a = this.accounts
    switch (call.m) {
      case 'setCrediter':
        return () => c.setCrediter(a[call.addr])
      case 'lowerPayoutCap':
        return () => c.lowerPayoutCap(call.cap)
      case 'announceChange': {
        const v = call.value
        const value =
          v.k === 'u64' ? op.itob(v.v) : v.k === 'addr' ? a[v.to].bytes : op.bzero(BigInt(v.len))
        return () => c.announceChange(call.key, value)
      }
      case 'applyChange':
        return () => c.applyChange()
      case 'refs':
        return () => c.refs()
      case 'announceRelease':
        return () => c.announceRelease(a[call.to])
      case 'executeRelease':
        return () => c.executeRelease()
      case 'credit': {
        const payouts = call.payouts.map((p) => ({ receiver: a[p.to], amount: p.amount }))
        return () => c.credit(call.seq, call.newTotal, call.unattributed, call.extra, payouts)
      }
    }
  }

  async exec(call: Call): Promise<Outcome> {
    const before = this.globals()
    try {
      this.scoped(call.sender, this.action(call))
    } catch (e) {
      this.rollBack(call, before)
      return { ok: false, error: e instanceof Error ? e.message : String(e) }
    }
    return { ok: true, receivers: call.m === 'credit' ? this.mirrorTransfers() : undefined }
  }

  // The emulator keeps the writes of a failed call. The cap bookkeeping of credit() runs
  // before its later checks, so a failed credit may leave it dirty. Every other write must
  // come after the last check; the test fails when that is not so.
  private rollBack(call: Call, before: Globals): void {
    const after = this.globals()
    if (call.m === 'credit') {
      const { periodIndex, paidInPeriod, ...rest } = after
      const { periodIndex: _p, paidInPeriod: _q, ...restBefore } = before
      expect(rest, 'failed credit changed global state').toEqual(restBefore)
      this.scoped('admin', () => {
        this.contract.capPeriodIndex.value = before.periodIndex
        this.contract.paidInPeriod.value = before.paidInPeriod
      })
      void periodIndex
      void paidInPeriod
    } else {
      expect(after, `failed ${call.m} changed global state`).toEqual(before)
    }
  }

  private mirrorTransfers(): Label[] {
    const receivers: Label[] = []
    for (const g of ctx.txn.lastGroup.itxnGroups) {
      const t = g.getAssetTransferInnerTxn(0)
      const to = this.label(t.assetReceiver)
      const amount = big(t.assetAmount)
      this.bal.payTo = (this.bal.payTo ?? 0n) - amount
      this.bal[to] = (this.bal[to] ?? 0n) + amount
      receivers.push(to)
    }
    ctx.ledger.updateAssetHolding(this.accounts.payTo, this.usdc, this.bal.payTo ?? 0n)
    return receivers
  }
}

describe('PaymentRouter stateful property tests (emulator)', () => {
  const coverage: Coverage = {}

  afterAll(() => {
    console.log('pbt coverage', JSON.stringify(coverage))
    expectCoverage(coverage, EMULATOR_SUCCESSES)
  })

  test('random command sequences keep every invariant', async () => {
    const opts = { hasGhost: false, canJumpPeriod: true }
    await fc.assert(
      fc.asyncProperty(
        initArb(),
        fc.commands([stepArb(opts, coverage)], { maxCommands: 30, size: 'large' }),
        async (init, cmds) => {
          await fc.asyncModelRun(async () => {
            const real = new EmulatorSut(init)
            const model = new Model({
              carryIn: init.carryIn,
              cap: init.cap,
              startRound: START_ROUND,
              delay: DELAY,
              window: WINDOW,
              movesUsdc: false,
              hasGhost: false,
            })
            await real.deposit(init.arrived)
            model.deposit(init.arrived)
            return { model, real }
          }, cmds)
        },
      ),
      { numRuns: 500 },
    )
  })

  test('every admin method rejects a stranger at both ends of the address order', () => {
    ctx.reset()
    ctx.setTemplateVar('RELEASE_DELAY_ROUNDS', DELAY)
    ctx.setTemplateVar('RELEASE_WINDOW_ROUNDS', WINDOW)
    ctx.ledger.patchGlobalData({ round: START_ROUND })
    const contract = ctx.contract.create(PaymentRouter)
    const admin = ctx.defaultSender
    const other = ctx.any.account()
    const low = ctx.any.account({ address: op.bzero(32) })
    const high = ctx.any.account({ address: Bytes(new Uint8Array(32).fill(255)) })
    const as = (sender: Account, fn: () => void) => {
      const txn = ctx.any.txn.applicationCall({ sender, fee: 1000n, appId: contract })
      ctx.txn.createScope([txn], 0).execute(fn)
    }
    as(admin, () => contract.createApplication(other, ctx.any.asset(), 0n, other, other, 100n))
    as(admin, () => contract.announceChange('cap', op.itob(200n)))
    as(admin, () => contract.announceRelease(other))
    ctx.ledger.patchGlobalData({ round: START_ROUND + DELAY })

    for (const stranger of [low, high]) {
      const calls = [
        () => contract.setCrediter(other),
        () => contract.lowerPayoutCap(0n),
        () => contract.announceChange('cap', op.itob(1n)),
        () => contract.applyChange(),
        () => contract.announceRelease(other),
        () => contract.executeRelease(),
      ]
      for (const call of calls) expect(() => as(stranger, call)).toThrow('admin only')
    }
  })
})
