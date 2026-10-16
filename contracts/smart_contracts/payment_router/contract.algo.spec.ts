import * as fs from 'node:fs'
import * as path from 'node:path'
import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, test } from 'vitest'
import { PaymentRouter } from './contract.algo'

describe('PaymentRouter', () => {
  const ctx = new TestExecutionContext()

  afterEach(() => {
    ctx.reset()
  })

  // appId MUST be set on the scoped txn: Global.creatorAddress and the
  // box/global state the contract reads resolve against the txn's own
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

  const setup = (payToBalance = 0n, carryIn = 0n) => {
    const contract = ctx.contract.create(PaymentRouter)
    const admin = ctx.defaultSender
    const crediter = ctx.any.account()
    const payTo = ctx.any.account()
    const mockUsdc = ctx.any.asset()
    const auditor = ctx.any.account()
    const auditor2 = ctx.any.account()
    const ops = ctx.any.account()
    const treasury = ctx.any.account()

    callInScope(contract, () => contract.createApplication(payTo, mockUsdc, carryIn))
    callInScope(contract, () => contract.setCrediter(crediter))
    callInScope(contract, () => contract.setIdentity('github:alice', auditor))
    callInScope(contract, () => contract.setIdentity('github:bob', auditor2))
    callInScope(contract, () => contract.setIdentity('ops', ops))
    callInScope(contract, () => contract.setIdentity('treasury', treasury))

    if (payToBalance > 0n) {
      ctx.ledger.updateAssetHolding(payTo, mockUsdc, payToBalance)
    }

    return { contract, admin, crediter, payTo, mockUsdc, auditor, auditor2, ops, treasury }
  }

  const balanceOf = (contract: PaymentRouter, identity: string) =>
    contract.balances(identity).exists ? contract.balances(identity).value : 0n

  const credit = (
    contract: PaymentRouter,
    crediter: ReturnType<typeof ctx.any.account>,
    args: {
      seq?: bigint
      newTotal?: bigint
      unattributed?: bigint
      extra?: bigint
      entries?: Array<{ repo: string; identity: string; amount: bigint }>
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
          args.entries ?? [],
        ),
      { sender: crediter },
    )

  const entry = (identity: string, amount: bigint) => ({ repo: 'octo/repo', identity, amount })

  describe('credit()', () => {
    test('computes ops and the treasury cut, and credits entries, extra and unattributed', () => {
      const { contract, crediter } = setup(2_000n)

      credit(contract, crediter, {
        newTotal: 1_000n,
        unattributed: 7n,
        extra: 50n,
        entries: [entry('github:alice', 300n), entry('github:bob', 100n)],
      })

      expect(balanceOf(contract, 'ops')).toEqual(50n)
      expect(balanceOf(contract, 'treasury')).toEqual(200n + 50n + 7n)
      expect(balanceOf(contract, 'github:alice')).toEqual(300n)
      expect(balanceOf(contract, 'github:bob')).toEqual(100n)
      expect(contract.creditedUnclaimed.value).toEqual(50n + 257n + 400n)
      expect(contract.lastBatchSeq.value).toEqual(1n)
      expect(contract.poolIn.value).toEqual(750n)
      expect(contract.poolOut.value).toEqual(450n)
      expect(contract.declaredTotal.value).toEqual(1_007n)
    })

    test('rounds ops and the treasury cut down', () => {
      const { contract, crediter } = setup(1_019n)

      credit(contract, crediter, { newTotal: 1_019n })

      expect(balanceOf(contract, 'ops')).toEqual(50n)
      expect(balanceOf(contract, 'treasury')).toEqual(203n)
      expect(contract.poolIn.value).toEqual(1_019n - 50n - 203n)
    })

    test('unattributedTotal alone credits treasury, never ops', () => {
      const { contract, crediter } = setup(5_123n)

      credit(contract, crediter, { unattributed: 5_123n })

      expect(balanceOf(contract, 'treasury')).toEqual(5_123n)
      expect(balanceOf(contract, 'ops')).toEqual(0n)
    })

    test('carryIn starts poolIn and declaredTotal', () => {
      const { contract, crediter } = setup(500n, 500n)

      expect(contract.poolIn.value).toEqual(500n)
      expect(contract.declaredTotal.value).toEqual(500n)

      credit(contract, crediter, { extra: 100n, entries: [entry('github:alice', 400n)] })

      expect(balanceOf(contract, 'github:alice')).toEqual(400n)
      expect(balanceOf(contract, 'treasury')).toEqual(100n)
    })

    test('an unmapped identity still accrues a balance', () => {
      const { contract, crediter } = setup(1_000n)

      credit(contract, crediter, { newTotal: 1_000n, entries: [entry('github:dave', 300n)] })

      expect(balanceOf(contract, 'github:dave')).toEqual(300n)
    })

    test('rejects a non-crediter sender', () => {
      const { contract, admin } = setup(1_000n)

      expect(() => credit(contract, admin, {})).toThrow('not crediter')
    })

    test('poolOut above poolIn fails, by entries and by treasuryExtra', () => {
      const { contract, crediter } = setup(2_000n)

      expect(() =>
        credit(contract, crediter, { newTotal: 1_000n, entries: [entry('github:alice', 751n)] }),
      ).toThrow('pool payouts exceed the pool part')
      expect(() =>
        credit(contract, crediter, {
          newTotal: 1_000n,
          extra: 51n,
          entries: [entry('github:alice', 700n)],
        }),
      ).toThrow('pool payouts exceed the pool part')

      credit(contract, crediter, { newTotal: 1_000n, entries: [entry('github:alice', 750n)] })
      expect(balanceOf(contract, 'github:alice')).toEqual(750n)
    })

    test('poolOut accumulates over batches against the running poolIn', () => {
      const { contract, crediter } = setup(2_000n)

      credit(contract, crediter, { newTotal: 1_000n, entries: [entry('github:alice', 750n)] })

      expect(() =>
        credit(contract, crediter, { seq: 2n, entries: [entry('github:bob', 1n)] }),
      ).toThrow('pool payouts exceed the pool part')
    })

    test('declaredTotal above the arrived USDC fails, and money is never declared twice', () => {
      const { contract, crediter } = setup(1_000n)

      expect(() => credit(contract, crediter, { newTotal: 1_001n })).toThrow(
        'declared total exceeds the USDC that arrived',
      )

      credit(contract, crediter, { newTotal: 1_000n })
      expect(() => credit(contract, crediter, { seq: 2n, newTotal: 1n })).toThrow(
        'declared total exceeds the USDC that arrived',
      )
      expect(() => credit(contract, crediter, { seq: 2n, unattributed: 1n })).toThrow(
        'declared total exceeds the USDC that arrived',
      )
    })

    test('claimedTotal lets the declared total follow USDC that left payTo', () => {
      const { contract, crediter, payTo, mockUsdc, treasury } = setup(100_000n)

      credit(contract, crediter, { unattributed: 100_000n })
      callInScope(contract, () => contract.claim('treasury'), { sender: treasury, fee: 2_000n })
      expect(contract.claimedTotal.value).toEqual(100_000n)

      // The harness does not move USDC for inner transactions: mirror the claim by hand.
      ctx.ledger.updateAssetHolding(payTo, mockUsdc, 0n)
      expect(() => credit(contract, crediter, { seq: 2n, newTotal: 1n })).toThrow(
        'declared total exceeds the USDC that arrived',
      )

      ctx.ledger.updateAssetHolding(payTo, mockUsdc, 1_000n)
      credit(contract, crediter, { seq: 2n, newTotal: 1_000n })
      expect(balanceOf(contract, 'ops')).toEqual(50n)
    })

    test('an entry with amount 0 fails', () => {
      const { contract, crediter } = setup(1_000n)

      expect(() =>
        credit(contract, crediter, { newTotal: 1_000n, entries: [entry('github:alice', 0n)] }),
      ).toThrow('entry amount must be above 0')
    })

    test('an entry naming ops or treasury fails', () => {
      const { contract, crediter } = setup(1_000n)

      for (const identity of ['ops', 'treasury']) {
        expect(() =>
          credit(contract, crediter, { newTotal: 1_000n, entries: [entry(identity, 10n)] }),
        ).toThrow('entry must not name ops or treasury')
      }
    })

    test('batchSeq that is not last + 1 fails (gap and repeat)', () => {
      const { contract, crediter } = setup(2_000n)

      expect(() => credit(contract, crediter, { seq: 2n })).toThrow('batchSeq must follow')
      credit(contract, crediter, { seq: 1n, unattributed: 1_000n })
      expect(() => credit(contract, crediter, { seq: 1n })).toThrow('batchSeq must follow')
      credit(contract, crediter, { seq: 2n })
    })

    test('a batch total above payTo USDC minus creditedUnclaimed fails', () => {
      const { contract, crediter } = setup(1_000n)

      // Totals alone would pass. A creditedUnclaimed above the safe level
      // leaves too little unallocated USDC for this batch.
      callInScope(contract, () => {
        contract.creditedUnclaimed.value = 900n
      })

      expect(() => credit(contract, crediter, { unattributed: 200n })).toThrow(
        'batch total exceeds the unallocated balance',
      )
      credit(contract, crediter, { unattributed: 100n })
    })

    test('credit() fails once the app is retired', () => {
      const { contract, admin, crediter } = setup(1_000n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      expect(() => credit(contract, crediter, {})).toThrow('app is retired')
    })
  })

  test('admin methods reject a non-admin sender', () => {
    const contract = ctx.contract.create(PaymentRouter)
    const notAdmin = ctx.any.account()
    const someone = ctx.any.account()

    expect(() =>
      callInScope(contract, () => contract.setCrediter(someone), { sender: notAdmin }),
    ).toThrow('admin only')
    expect(() =>
      callInScope(contract, () => contract.setIdentity('ops', someone), { sender: notAdmin }),
    ).toThrow('admin only')
    expect(() =>
      callInScope(contract, () => contract.announceRelease(someone), { sender: notAdmin }),
    ).toThrow('admin only')
    expect(() =>
      callInScope(contract, () => contract.executeRelease(), { sender: notAdmin }),
    ).toThrow('admin only')
  })

  describe('claim()', () => {
    // newTotal 1,999,999 gives ops 99,999; newTotal 2,000,000 gives ops 100,000.
    test('a balance of 99,999 fails', () => {
      const { contract, crediter, ops } = setup(1_999_999n)

      credit(contract, crediter, { newTotal: 1_999_999n })
      expect(balanceOf(contract, 'ops')).toEqual(99_999n)

      expect(() =>
        callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 2_000n }),
      ).toThrow('balance below MIN_CLAIM')
    })

    test('a balance of 100,000 succeeds, pays the mapped address and counts the payout', () => {
      const { contract, crediter, payTo, ops } = setup(2_000_000n)

      credit(contract, crediter, { newTotal: 2_000_000n })
      callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 2_000n })

      const group = ctx.txn.lastGroup
      expect(group.itxnGroups).toHaveLength(1)
      const inner = group.itxnGroups[0].getAssetTransferInnerTxn(0)
      expect(inner.sender).toEqual(payTo)
      expect(inner.assetReceiver).toEqual(ops)
      expect(inner.assetAmount).toEqual(100_000n)
      expect(contract.claimedTotal.value).toEqual(100_000n)
      expect(balanceOf(contract, 'ops')).toEqual(0n)
    })

    test('the outer fee must be at least twice the minimum fee', () => {
      const { contract, crediter, ops } = setup(2_000_000n)

      credit(contract, crediter, { newTotal: 2_000_000n })

      expect(() =>
        callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 1_999n }),
      ).toThrow('outer fee must pool the inner fee')
      callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 2_000n })
    })

    test('a sender that is not the mapped address fails', () => {
      const { contract, crediter } = setup(2_000_000n)
      const stranger = ctx.any.account()

      credit(contract, crediter, { newTotal: 2_000_000n })

      expect(() =>
        callInScope(contract, () => contract.claim('ops'), { sender: stranger, fee: 2_000n }),
      ).toThrow('not the mapped address')
    })

    test('claim() fails once the app is retired', () => {
      const { contract, admin, crediter, ops } = setup(2_000_000n)

      credit(contract, crediter, { newTotal: 2_000_000n })
      const releaseTo = ctx.any.account()
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      expect(() =>
        callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 2_000n }),
      ).toThrow('app is retired')
    })
  })

  describe('setIdentity() / applyIdentity()', () => {
    const DELAY = 216_000n
    const WINDOW = 216_000n

    const withCreditedErin = () => {
      const base = setup(400_000n)
      const oldAddr = ctx.any.account()
      const newAddr = ctx.any.account()
      callInScope(base.contract, () => base.contract.setIdentity('github:erin', oldAddr))
      credit(base.contract, base.crediter, {
        newTotal: 400_000n,
        entries: [entry('github:erin', 120_000n)],
      })
      return { ...base, oldAddr, newAddr }
    }

    test('an identity with no address and no balance is mapped at once', () => {
      const { contract } = setup(0n)
      const addr = ctx.any.account()

      callInScope(contract, () => contract.setIdentity('github:fay', addr))

      expect(contract.identityAddress('github:fay').value).toEqual(addr.bytes)
      expect(contract.pendingAddress('github:fay').exists).toEqual(false)
    })

    test('a first mapping with a balance is pending and claim fails until apply', () => {
      const { contract, crediter } = setup(2_000_000n)
      const addr = ctx.any.account()

      credit(contract, crediter, {
        newTotal: 2_000_000n,
        entries: [entry('github:gus', 200_000n)],
      })
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.setIdentity('github:gus', addr))

      expect(contract.identityAddress('github:gus').exists).toEqual(false)
      expect(contract.pendingAddress('github:gus').value).toEqual(addr.bytes)
      expect(() =>
        callInScope(contract, () => contract.claim('github:gus'), { sender: addr, fee: 2_000n }),
      ).toThrow('unmapped identity')

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.applyIdentity('github:gus'))
      callInScope(contract, () => contract.claim('github:gus'), { sender: addr, fee: 2_000n })
      const inner = ctx.txn.lastGroup.itxnGroups[0].getAssetTransferInnerTxn(0)
      expect(inner.assetReceiver).toEqual(addr)
    })

    test('applyIdentity() fails once the app is retired', () => {
      const { contract, admin, newAddr } = withCreditedErin()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.setIdentity('github:erin', newAddr))
      callInScope(contract, () => contract.announceRelease(ctx.any.account()), { sender: admin })
      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      expect(() => callInScope(contract, () => contract.applyIdentity('github:erin'))).toThrow(
        'app is retired',
      )
    })

    test('a mapped identity only gets a pending address and keeps the old one', () => {
      const { contract, oldAddr, newAddr } = withCreditedErin()

      ctx.ledger.patchGlobalData({ round: 5_000n })
      callInScope(contract, () => contract.setIdentity('github:erin', newAddr))

      expect(contract.identityAddress('github:erin').value).toEqual(oldAddr.bytes)
      expect(contract.pendingAddress('github:erin').value).toEqual(newAddr.bytes)
      expect(contract.pendingRound('github:erin').value).toEqual(5_000n)
    })

    test('applyIdentity() without a pending address fails', () => {
      const { contract } = setup(0n)

      expect(() => callInScope(contract, () => contract.applyIdentity('github:alice'))).toThrow(
        'no pending address',
      )
    })

    test('applyIdentity() before the delay fails and claims still go to the old address', () => {
      const { contract, oldAddr, newAddr } = withCreditedErin()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.setIdentity('github:erin', newAddr))

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY - 1n })
      expect(() =>
        callInScope(contract, () => contract.applyIdentity('github:erin'), {
          sender: ctx.any.account(),
        }),
      ).toThrow('identity delay has not passed')

      expect(() =>
        callInScope(contract, () => contract.claim('github:erin'), {
          sender: newAddr,
          fee: 2_000n,
        }),
      ).toThrow('not the mapped address')
      callInScope(contract, () => contract.claim('github:erin'), { sender: oldAddr, fee: 2_000n })
      const inner = ctx.txn.lastGroup.itxnGroups[0].getAssetTransferInnerTxn(0)
      expect(inner.assetReceiver).toEqual(oldAddr)
    })

    test('anybody can apply after the delay, then claims go to the new address', () => {
      const { contract, oldAddr, newAddr } = withCreditedErin()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.setIdentity('github:erin', newAddr))

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.applyIdentity('github:erin'), {
        sender: ctx.any.account(),
      })

      expect(contract.pendingAddress('github:erin').exists).toEqual(false)
      expect(contract.pendingRound('github:erin').exists).toEqual(false)
      expect(() =>
        callInScope(contract, () => contract.claim('github:erin'), {
          sender: oldAddr,
          fee: 2_000n,
        }),
      ).toThrow('not the mapped address')

      callInScope(contract, () => contract.claim('github:erin'), { sender: newAddr, fee: 2_000n })
      const inner = ctx.txn.lastGroup.itxnGroups[0].getAssetTransferInnerTxn(0)
      expect(inner.assetReceiver).toEqual(newAddr)
      expect(inner.assetAmount).toEqual(120_000n)
    })

    test('applyIdentity() works on the last round of the window and fails after it', () => {
      const { contract, newAddr } = withCreditedErin()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.setIdentity('github:erin', newAddr))

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY + WINDOW })
      expect(() => callInScope(contract, () => contract.applyIdentity('github:erin'))).toThrow(
        'identity window has expired',
      )

      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY + WINDOW - 1n })
      callInScope(contract, () => contract.applyIdentity('github:erin'))
      expect(contract.identityAddress('github:erin').value).toEqual(newAddr.bytes)
    })

    test('a new setIdentity() replaces the pending address and restarts the delay', () => {
      const { contract, newAddr } = withCreditedErin()
      const laterAddr = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.setIdentity('github:erin', newAddr))
      ctx.ledger.patchGlobalData({ round: 1_000n + DELAY })
      callInScope(contract, () => contract.setIdentity('github:erin', laterAddr))

      expect(() => callInScope(contract, () => contract.applyIdentity('github:erin'))).toThrow(
        'identity delay has not passed',
      )

      ctx.ledger.patchGlobalData({ round: 1_000n + 2n * DELAY })
      callInScope(contract, () => contract.applyIdentity('github:erin'))
      expect(contract.identityAddress('github:erin').value).toEqual(laterAddr.bytes)
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

    test('executeRelease(): moves no USDC, keeps creditedUnclaimed and rekeys payTo', () => {
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
      expect(contract.creditedUnclaimed.value).toEqual(1_000_000n)
      expect(contract.retired.value).toEqual(true)
    })

    test('executeRelease(): needs no mapped treasury identity', () => {
      const contract = ctx.contract.create(PaymentRouter)
      const payTo = ctx.any.account()
      const releaseTo = ctx.any.account()

      callInScope(contract, () => contract.createApplication(payTo, ctx.any.asset(), 0n))
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo))
      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease())

      expect(contract.retired.value).toEqual(true)
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
