import * as fs from 'node:fs'
import * as path from 'node:path'
import { op } from '@algorandfoundation/algorand-typescript'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { PaymentRouter } from './contract.algo'

const DELAY = 216_000n
const WINDOW = 216_000n
const PERIOD = 30_000n

const itob = (n: bigint) => op.itob(n)

describe('PaymentRouter', () => {
  const ctx = new TestExecutionContext()

  const setReleaseRounds = (delay: bigint, window: bigint) => {
    ctx.setTemplateVar('RELEASE_DELAY_ROUNDS', delay)
    ctx.setTemplateVar('RELEASE_WINDOW_ROUNDS', window)
  }

  beforeEach(() => {
    setReleaseRounds(DELAY, WINDOW)
  })

  afterEach(() => {
    ctx.reset()
  })

  // appId MUST be set on the scoped txn: Global.creatorAddress and the
  // global state the contract reads resolve against the txn's own
  // appId, not the contract under test implicitly.
  const callInScope = <T>(
    contract: PaymentRouter,
    fn: () => T,
    options?: { sender?: ReturnType<typeof ctx.any.account>; fee?: bigint },
  ): T => {
    const sender = options?.sender ?? ctx.defaultSender
    const fee = options?.fee ?? 1000n
    const txn = ctx.any.txn.applicationCall({ sender, fee, appId: contract })
    return ctx.txn.createScope([txn], 0).execute(fn)
  }

  const setup = (payToBalance = 0n, carryIn = 0n, cap = 10_000_000n) => {
    const contract = ctx.contract.create(PaymentRouter)
    const admin = ctx.defaultSender
    const crediter = ctx.any.account()
    const payTo = ctx.any.account()
    const mockUsdc = ctx.any.asset()
    const alice = ctx.any.account()
    const bob = ctx.any.account()
    const ops = ctx.any.account()
    const treasury = ctx.any.account()

    callInScope(contract, () =>
      contract.createApplication(payTo, mockUsdc, carryIn, ops, treasury, cap),
    )
    callInScope(contract, () => contract.setCrediter(crediter))

    if (payToBalance > 0n) {
      ctx.ledger.updateAssetHolding(payTo, mockUsdc, payToBalance)
    }

    return { contract, admin, crediter, payTo, mockUsdc, alice, bob, ops, treasury }
  }

  type Account = ReturnType<typeof ctx.any.account>
  type Payout = { receiver: Account; amount: bigint }

  const credit = (
    contract: PaymentRouter,
    crediter: Account,
    args: {
      seq?: bigint
      newTotal?: bigint
      unattributed?: bigint
      extra?: bigint
      payouts?: Payout[]
    },
  ) =>
    callInScope(
      contract,
      () =>
        contract.credit(
          args.seq ?? 1n,
          args.newTotal ?? 0n,
          args.unattributed ?? 0n,
          args.extra ?? 0n,
          args.payouts ?? [],
        ),
      { sender: crediter },
    )

  const transfers = () => {
    const group = ctx.txn.lastGroup.itxnGroups
    return group.map((g) => g.getAssetTransferInnerTxn(0))
  }

  describe('credit()', () => {
    test('pays payouts, ops and treasury from payTo and counts every transfer', () => {
      const { contract, crediter, payTo, alice, bob, ops, treasury } = setup(2_000n)

      credit(contract, crediter, {
        newTotal: 1_000n,
        unattributed: 7n,
        extra: 50n,
        payouts: [
          { receiver: alice, amount: 300n },
          { receiver: bob, amount: 100n },
        ],
      })

      const sent = transfers()
      expect(sent).toHaveLength(4)
      expect(sent.map((t) => [t.assetReceiver, t.assetAmount])).toEqual([
        [alice, 300n],
        [bob, 100n],
        [ops, 50n],
        [treasury, 257n],
      ])
      for (const t of sent) {
        expect(t.sender).toEqual(payTo)
        expect(t.fee).toEqual(0n)
      }
      expect(contract.paidTotal.value).toEqual(707n)
      expect(contract.lastBatchSeq.value).toEqual(1n)
      expect(contract.poolIn.value).toEqual(750n)
      expect(contract.poolOut.value).toEqual(450n)
      expect(contract.declaredTotal.value).toEqual(1_007n)
    })

    test('rounds ops and the treasury cut down', () => {
      const { contract, crediter, ops, treasury } = setup(1_019n)

      credit(contract, crediter, { newTotal: 1_019n })

      expect(transfers().map((t) => [t.assetReceiver, t.assetAmount])).toEqual([
        [ops, 50n],
        [treasury, 203n],
      ])
      expect(contract.poolIn.value).toEqual(1_019n - 50n - 203n)
    })

    test('sends no transfer for an amount of 0', () => {
      const { contract, crediter, treasury } = setup(5_123n)

      credit(contract, crediter, { unattributed: 5_123n })

      const sent = transfers()
      expect(sent).toHaveLength(1)
      expect(sent[0].assetReceiver).toEqual(treasury)
      expect(sent[0].assetAmount).toEqual(5_123n)
    })

    test('carryIn starts poolIn and declaredTotal', () => {
      const { contract, crediter, alice, treasury } = setup(500n, 500n)

      expect(contract.poolIn.value).toEqual(500n)
      expect(contract.declaredTotal.value).toEqual(500n)

      credit(contract, crediter, { extra: 100n, payouts: [{ receiver: alice, amount: 400n }] })

      expect(transfers().map((t) => [t.assetReceiver, t.assetAmount])).toEqual([
        [alice, 400n],
        [treasury, 100n],
      ])
    })

    test('rejects a non-crediter sender', () => {
      const { contract, admin } = setup(1_000n)

      expect(() => credit(contract, admin, {})).toThrow('not crediter')
    })

    // Check 2.
    test('poolOut above poolIn fails, by payouts and by treasuryExtra', () => {
      const { contract, crediter, alice } = setup(2_000n)

      expect(() =>
        credit(contract, crediter, {
          newTotal: 1_000n,
          payouts: [{ receiver: alice, amount: 751n }],
        }),
      ).toThrow('pool payouts exceed the pool part')
      expect(() =>
        credit(contract, crediter, {
          newTotal: 1_000n,
          extra: 51n,
          payouts: [{ receiver: alice, amount: 700n }],
        }),
      ).toThrow('pool payouts exceed the pool part')

      credit(contract, crediter, {
        newTotal: 1_000n,
        payouts: [{ receiver: alice, amount: 750n }],
      })
      expect(contract.poolOut.value).toEqual(750n)
    })

    test('poolOut accumulates over batches against the running poolIn', () => {
      const { contract, crediter, alice, bob } = setup(2_000n)

      credit(contract, crediter, {
        newTotal: 1_000n,
        payouts: [{ receiver: alice, amount: 750n }],
      })

      expect(() =>
        credit(contract, crediter, { seq: 2n, payouts: [{ receiver: bob, amount: 1n }] }),
      ).toThrow('pool payouts exceed the pool part')
    })

    // Check 3.
    test('declaredTotal above the arrived USDC fails, and money is never declared twice', () => {
      const { contract, crediter } = setup(1_000n)

      // The harness does not move USDC for inner transactions, so a declared
      // total from an earlier batch is set by hand.
      callInScope(contract, () => {
        contract.declaredTotal.value = 1_100n
      })
      expect(() => credit(contract, crediter, { newTotal: 1_000n })).toThrow(
        'declared total exceeds the USDC that arrived',
      )

      callInScope(contract, () => {
        contract.declaredTotal.value = 0n
      })
      credit(contract, crediter, { newTotal: 1_000n })
    })

    test('paidTotal lets the declared total follow USDC that left payTo', () => {
      const { contract, crediter, payTo, mockUsdc } = setup(100_000n)

      credit(contract, crediter, { unattributed: 100_000n })
      expect(contract.paidTotal.value).toEqual(100_000n)

      // The harness does not move USDC for inner transactions: mirror the transfer by hand.
      ctx.ledger.updateAssetHolding(payTo, mockUsdc, 0n)
      expect(() => credit(contract, crediter, { seq: 2n, newTotal: 1n })).toThrow(
        'declared total exceeds the USDC that arrived',
      )

      ctx.ledger.updateAssetHolding(payTo, mockUsdc, 1_000n)
      credit(contract, crediter, { seq: 2n, newTotal: 1_000n })
      expect(contract.declaredTotal.value).toEqual(101_000n)
    })

    // Check 4.
    test('batchSeq that is not last + 1 fails (gap and repeat)', () => {
      const { contract, crediter } = setup(2_000n)

      expect(() => credit(contract, crediter, { seq: 2n })).toThrow('batchSeq must follow')
      credit(contract, crediter, { seq: 1n, unattributed: 1_000n })
      expect(() => credit(contract, crediter, { seq: 1n })).toThrow('batchSeq must follow')
      credit(contract, crediter, { seq: 2n })
    })

    // Check 5.
    test('a batch total above the balance of payTo fails, at the boundary', () => {
      const { contract, crediter, alice } = setup(1_000n)

      expect(() =>
        credit(contract, crediter, {
          unattributed: 1_000n,
          payouts: [{ receiver: alice, amount: 1n }],
        }),
      ).toThrow('batch total exceeds the balance of payTo')
      credit(contract, crediter, { unattributed: 1_000n })
    })

    test('a failed call leaves batchSeq where it was', () => {
      const { contract, crediter } = setup(100n)

      expect(() => credit(contract, crediter, { unattributed: 101n })).toThrow()
      expect(contract.lastBatchSeq.hasValue).toEqual(false)
      credit(contract, crediter, { unattributed: 100n })
    })

    // Check 6.
    test('payouts above the cap fail, at the boundary', () => {
      const { contract, crediter, alice, bob } = setup(2_000n, 2_000n, 500n)

      expect(() =>
        credit(contract, crediter, { payouts: [{ receiver: alice, amount: 501n }] }),
      ).toThrow('payouts exceed the cap of this period')
      credit(contract, crediter, { payouts: [{ receiver: alice, amount: 500n }] })
      expect(() =>
        credit(contract, crediter, { seq: 2n, payouts: [{ receiver: bob, amount: 1n }] }),
      ).toThrow('payouts exceed the cap of this period')
    })

    test('the cap bounds payouts only, not ops or treasury', () => {
      const { contract, crediter } = setup(2_000n, 0n, 0n)

      credit(contract, crediter, { newTotal: 1_000n, unattributed: 500n, extra: 0n })
      expect(contract.paidTotal.value).toEqual(750n)
    })

    test('paidInPeriod resets when the period index changes', () => {
      const { contract, crediter, alice } = setup(2_000n, 2_000n, 500n)

      ctx.ledger.patchGlobalData({ round: 5n * PERIOD })
      credit(contract, crediter, { payouts: [{ receiver: alice, amount: 500n }] })
      expect(contract.paidInPeriod.value).toEqual(500n)

      ctx.ledger.patchGlobalData({ round: 6n * PERIOD - 1n })
      expect(() =>
        credit(contract, crediter, { seq: 2n, payouts: [{ receiver: alice, amount: 1n }] }),
      ).toThrow('payouts exceed the cap of this period')

      ctx.ledger.patchGlobalData({ round: 6n * PERIOD })
      credit(contract, crediter, { seq: 2n, payouts: [{ receiver: alice, amount: 500n }] })
      expect(contract.capPeriodIndex.value).toEqual(6n)
      expect(contract.paidInPeriod.value).toEqual(500n)
    })

    test('a payout to payTo fails', () => {
      const { contract, crediter, payTo } = setup(1_000n)

      expect(() =>
        credit(contract, crediter, { payouts: [{ receiver: payTo, amount: 10n }] }),
      ).toThrow('payout must not name payTo or the app')
    })

    test('a payout to the app address fails', () => {
      const { contract, crediter } = setup(1_000n)
      const app = ctx.ledger.getApplicationForContract(contract)

      expect(() =>
        credit(contract, crediter, { payouts: [{ receiver: app.address, amount: 10n }] }),
      ).toThrow('payout must not name payTo or the app')
    })

    test('a payout with amount 0 fails', () => {
      const { contract, crediter, alice } = setup(1_000n)

      expect(() =>
        credit(contract, crediter, { payouts: [{ receiver: alice, amount: 0n }] }),
      ).toThrow('payout amount must be above 0')
    })

    test('credit() fails once the app is retired', () => {
      const { contract, admin, crediter } = setup(1_000n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      expect(() => credit(contract, crediter, {})).toThrow('app is retired')
    })
  })

  describe('refs()', () => {
    test('does nothing', () => {
      const { contract } = setup(0n)

      callInScope(contract, () => contract.refs())

      expect(ctx.txn.lastGroup.itxnGroups).toHaveLength(0)
    })
  })

  describe('admin methods', () => {
    test('reject a non-admin sender', () => {
      const contract = ctx.contract.create(PaymentRouter)
      const notAdmin = ctx.any.account()
      const someone = ctx.any.account()
      const asNotAdmin = (fn: () => unknown) => () =>
        callInScope(contract, fn, { sender: notAdmin })

      expect(asNotAdmin(() => contract.setCrediter(someone))).toThrow('admin only')
      expect(asNotAdmin(() => contract.lowerPayoutCap(0n))).toThrow('admin only')
      expect(asNotAdmin(() => contract.announceChange('cap', itob(1n)))).toThrow('admin only')
      expect(asNotAdmin(() => contract.applyChange())).toThrow('admin only')
      expect(asNotAdmin(() => contract.announceRelease(someone))).toThrow('admin only')
      expect(asNotAdmin(() => contract.executeRelease())).toThrow('admin only')
    })
  })

  describe('lowerPayoutCap()', () => {
    test('lowers the cap at once', () => {
      const { contract } = setup(0n, 0n, 1_000n)

      callInScope(contract, () => contract.lowerPayoutCap(400n))

      expect(contract.payoutCap.value).toEqual(400n)
      callInScope(contract, () => contract.lowerPayoutCap(400n))
    })

    test('refuses a raise', () => {
      const { contract } = setup(0n, 0n, 1_000n)

      expect(() => callInScope(contract, () => contract.lowerPayoutCap(1_001n))).toThrow(
        'cap can only be lowered',
      )
    })
  })

  describe('announceChange() / applyChange()', () => {
    test('rejects an unknown key and a value of the wrong length', () => {
      const { contract } = setup(0n)

      expect(() => callInScope(contract, () => contract.announceChange('xyz', itob(1n)))).toThrow(
        'unknown change key',
      )
      expect(() =>
        callInScope(contract, () => contract.announceChange('cap', ctx.any.account().bytes)),
      ).toThrow('cap must be 8 bytes')
      expect(() => callInScope(contract, () => contract.announceChange('ops', itob(1n)))).toThrow(
        'address must be 32 bytes',
      )
    })

    test('applyChange() without a pending change fails', () => {
      const { contract } = setup(0n)

      expect(() => callInScope(contract, () => contract.applyChange())).toThrow('no pending change')
    })

    test('applyChange() before the delay fails', () => {
      const { contract } = setup(0n, 0n, 1_000n)

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceChange('cap', itob(5_000n)))

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY - 1n })
      expect(() => callInScope(contract, () => contract.applyChange())).toThrow(
        'change delay has not passed',
      )
      expect(contract.payoutCap.value).toEqual(1_000n)
    })

    test('applyChange() works from the delay to the last round of the window', () => {
      const { contract } = setup(0n, 0n, 1_000n)

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceChange('cap', itob(5_000n)))

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY + WINDOW - 1n })
      callInScope(contract, () => contract.applyChange())

      expect(contract.payoutCap.value).toEqual(5_000n)
      expect(contract.pendingKey.value).toEqual('')
      expect(contract.pendingRound.value).toEqual(0n)
    })

    test('applyChange() works on the first round of the delay', () => {
      const { contract } = setup(0n, 0n, 1_000n)

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceChange('cap', itob(5_000n)))
      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.applyChange())

      expect(contract.payoutCap.value).toEqual(5_000n)
    })

    test('applyChange() after the window fails and a second apply finds nothing', () => {
      const { contract } = setup(0n, 0n, 1_000n)

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceChange('cap', itob(5_000n)))

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY + WINDOW })
      expect(() => callInScope(contract, () => contract.applyChange())).toThrow(
        'change window has expired',
      )

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.applyChange())
      expect(() => callInScope(contract, () => contract.applyChange())).toThrow('no pending change')
    })

    test('a new announcement replaces the old one and restarts the delay', () => {
      const { contract } = setup(0n, 0n, 1_000n)

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceChange('cap', itob(5_000n)))
      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.announceChange('cap', itob(7_000n)))

      expect(() => callInScope(contract, () => contract.applyChange())).toThrow(
        'change delay has not passed',
      )

      ctx.ledger.patchGlobalData({ round: 1_000n + 2n * DELAY })
      callInScope(contract, () => contract.applyChange())
      expect(contract.payoutCap.value).toEqual(7_000n)
    })

    test('a change of ops or trs sets the receiver used by credit()', () => {
      const { contract, crediter, ops, treasury } = setup(2_000n)
      const newOps = ctx.any.account()
      const newTreasury = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceChange('ops', newOps.bytes))
      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.applyChange())
      callInScope(contract, () => contract.announceChange('trs', newTreasury.bytes))
      ctx.ledger.patchGlobalData({ round: 1_000n + 2n * DELAY })
      callInScope(contract, () => contract.applyChange())

      credit(contract, crediter, { newTotal: 1_000n })
      const receivers = transfers().map((t) => t.assetReceiver)
      expect(receivers).toEqual([newOps, newTreasury])
      expect(receivers).not.toContain(ops)
      expect(receivers).not.toContain(treasury)
    })
  })

  describe('announceRelease() / executeRelease()', () => {
    test('announceRelease(): a non-admin sender fails', () => {
      const { contract } = setup(0n)
      const notAdmin = ctx.any.account()
      const releaseTo = ctx.any.account()

      expect(() =>
        callInScope(contract, () => contract.announceRelease(releaseTo), { sender: notAdmin }),
      ).toThrow('admin only')
    })

    test('executeRelease(): without an announcement fails', () => {
      const { contract, admin } = setup(0n)

      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('no release announced')
    })

    test('executeRelease(): before the delay has passed fails', () => {
      const { contract, admin } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 215_999n })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('release delay has not passed')
    })

    test('executeRelease(): succeeds on the last round of the execute window', () => {
      const { contract, admin } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n + 215_999n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      const rekeyTxn = ctx.txn.lastGroup.itxnGroups[0].getPaymentInnerTxn(0)
      expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
    })

    test('executeRelease(): after the execute window closes fails', () => {
      const { contract, admin } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n + 216_000n })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('release window has expired')
    })

    test('executeRelease(): an expired announcement works again only after a new delay', () => {
      const { contract, admin } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      const reannounced = 1_000n + 500_000n
      ctx.ledger.patchGlobalData({ round: reannounced })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('release delay has not passed')

      ctx.ledger.patchGlobalData({ round: reannounced + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })
      const rekeyTxn = ctx.txn.lastGroup.itxnGroups[0].getPaymentInnerTxn(0)
      expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
    })

    test('executeRelease(): a non-admin sender fails', () => {
      const { contract, admin } = setup(0n)
      const releaseTo = ctx.any.account()
      const notAdmin = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: notAdmin }),
      ).toThrow('admin only')
    })

    test('executeRelease(): re-announcing overwrites the target and restarts the delay', () => {
      const { contract, admin } = setup(0n)
      const firstTarget = ctx.any.account()
      const secondTarget = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(firstTarget), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.announceRelease(secondTarget), { sender: admin })

      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('release delay has not passed')

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      const rekeyTxn = ctx.txn.lastGroup.itxnGroups[0].getPaymentInnerTxn(0)
      expect(rekeyTxn.rekeyTo).toEqual(secondTarget)
    })

    test('executeRelease(): moves no USDC and rekeys payTo', () => {
      const { contract, admin, crediter, payTo } = setup(1_000_000n)

      credit(contract, crediter, { unattributed: 1_000_000n })

      const releaseTo = ctx.any.account()
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      const group = ctx.txn.lastGroup
      expect(group.itxnGroups).toHaveLength(1)
      const rekeyTxn = group.itxnGroups[0].getPaymentInnerTxn(0)
      expect(rekeyTxn.sender).toEqual(payTo)
      expect(rekeyTxn.receiver).toEqual(payTo)
      expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
      expect(contract.paidTotal.value).toEqual(1_000_000n)
      expect(contract.retired.value).toEqual(true)
    })

    test('executeRelease(): needs no payee setup', () => {
      const contract = ctx.contract.create(PaymentRouter)
      const payTo = ctx.any.account()
      const releaseTo = ctx.any.account()

      callInScope(contract, () =>
        contract.createApplication(
          payTo,
          ctx.any.asset(),
          0n,
          ctx.any.account(),
          ctx.any.account(),
          0n,
        ),
      )
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo))
      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease())

      expect(contract.retired.value).toEqual(true)
    })
  })

  describe('release timing template values', () => {
    const SHORT_DELAY = 20n
    const SHORT_WINDOW = 200n

    test('createApplication() stores the delay and the window in global state', () => {
      setReleaseRounds(SHORT_DELAY, SHORT_WINDOW)
      const { contract } = setup(0n)

      expect(contract.releaseDelay.value).toEqual(SHORT_DELAY)
      expect(contract.releaseWindow.value).toEqual(SHORT_WINDOW)
    })

    test('the stored values are the MainNet pair when the template is set to it', () => {
      const { contract } = setup(0n)

      expect(contract.releaseDelay.value).toEqual(216_000n)
      expect(contract.releaseWindow.value).toEqual(216_000n)
    })

    describe('applyChange() with a short delay and window', () => {
      const announced = () => {
        setReleaseRounds(SHORT_DELAY, SHORT_WINDOW)
        const fixture = setup(0n, 0n, 1_000n)
        ctx.ledger.patchGlobalData({ round: 1_000n })
        callInScope(fixture.contract, () => fixture.contract.announceChange('cap', itob(5_000n)))
        return fixture.contract
      }

      test('fails one round before the delay', () => {
        const contract = announced()
        ctx.ledger.patchGlobalData({ round: 1_000n + SHORT_DELAY - 1n })
        expect(() => callInScope(contract, () => contract.applyChange())).toThrow(
          'change delay has not passed',
        )
      })

      test('works on the first and on the last round of the window', () => {
        for (const round of [1_000n + SHORT_DELAY, 1_000n + SHORT_DELAY + SHORT_WINDOW - 1n]) {
          const contract = announced()
          ctx.ledger.patchGlobalData({ round })
          callInScope(contract, () => contract.applyChange())
          expect(contract.payoutCap.value).toEqual(5_000n)
        }
      })

      test('fails when the window has expired', () => {
        const contract = announced()
        ctx.ledger.patchGlobalData({ round: 1_000n + SHORT_DELAY + SHORT_WINDOW })
        expect(() => callInScope(contract, () => contract.applyChange())).toThrow(
          'change window has expired',
        )
      })
    })

    describe('executeRelease() with a short delay and window', () => {
      const announced = () => {
        setReleaseRounds(SHORT_DELAY, SHORT_WINDOW)
        const fixture = setup(0n)
        const releaseTo = ctx.any.account()
        ctx.ledger.patchGlobalData({ round: 1_000n })
        callInScope(fixture.contract, () => fixture.contract.announceRelease(releaseTo), {
          sender: fixture.admin,
        })
        return { ...fixture, releaseTo }
      }

      test('fails one round before the delay', () => {
        const { contract, admin } = announced()
        ctx.ledger.patchGlobalData({ round: 1_000n + SHORT_DELAY - 1n })
        expect(() =>
          callInScope(contract, () => contract.executeRelease(), { sender: admin }),
        ).toThrow('release delay has not passed')
      })

      test('works on the first and on the last round of the window', () => {
        for (const round of [1_000n + SHORT_DELAY, 1_000n + SHORT_DELAY + SHORT_WINDOW - 1n]) {
          const { contract, admin, releaseTo } = announced()
          ctx.ledger.patchGlobalData({ round })
          callInScope(contract, () => contract.executeRelease(), { sender: admin })
          const rekeyTxn = ctx.txn.lastGroup.itxnGroups[0].getPaymentInnerTxn(0)
          expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
        }
      })

      test('fails when the window has expired', () => {
        const { contract, admin } = announced()
        ctx.ledger.patchGlobalData({ round: 1_000n + SHORT_DELAY + SHORT_WINDOW })
        expect(() =>
          callInScope(contract, () => contract.executeRelease(), { sender: admin }),
        ).toThrow('release window has expired')
      })

      test('a program built with the MainNet pair still blocks a round the short pair allows', () => {
        const { contract, admin } = announced()
        setReleaseRounds(DELAY, WINDOW)
        ctx.ledger.patchGlobalData({ round: 1_000n + SHORT_DELAY })
        expect(() =>
          callInScope(contract, () => contract.executeRelease(), { sender: admin }),
        ).toThrow('release delay has not passed')
      })
    })
  })

  // CAUTION: algorand-typescript-testing calls contract methods directly.
  // It does not build or run the ARC-4 router the compiled approval program
  // uses to dispatch on OnCompletion. So this suite cannot send a real
  // UpdateApplication or DeleteApplication application call and observe the
  // router reject it; that only happens under Puya-compiled TEAL. Instead, this proves the two facts that
  // make that rejection follow: the class defines no handler PaymentRouter
  // routes to either OnCompletion, and the generated ARC-56 spec lists
  // neither action for any method or bare call.
  describe('UpdateApplication / DeleteApplication have no route', () => {
    test('the contract defines no updateApplication() or deleteApplication() method', () => {
      const contract = ctx.contract.create(PaymentRouter)

      expect(typeof (contract as unknown as Record<string, unknown>).updateApplication).toEqual(
        'undefined',
      )
      expect(typeof (contract as unknown as Record<string, unknown>).deleteApplication).toEqual(
        'undefined',
      )
    })

    test('the ARC-56 spec routes no method or bare call to UpdateApplication or DeleteApplication', () => {
      const arc56Path = path.join(
        __dirname,
        '..',
        'artifacts',
        'payment_router',
        'PaymentRouter.arc56.json',
      )
      const arc56 = JSON.parse(fs.readFileSync(arc56Path, 'utf8')) as {
        methods: Array<{ name: string; actions: { create: string[]; call: string[] } }>
        bareActions: { create: string[]; call: string[] }
      }

      const forbidden = ['UpdateApplication', 'DeleteApplication']
      for (const method of arc56.methods) {
        for (const action of forbidden) {
          expect(method.actions.create).not.toContain(action)
          expect(method.actions.call).not.toContain(action)
        }
      }
      for (const action of forbidden) {
        expect(arc56.bareActions.create).not.toContain(action)
        expect(arc56.bareActions.call).not.toContain(action)
      }
    })
  })
})
