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

  const setup = (payToBalance = 0n) => {
    const contract = ctx.contract.create(PaymentRouter)
    const admin = ctx.defaultSender
    const crediter = ctx.any.account()
    const payTo = ctx.any.account()
    const mockUsdc = ctx.any.asset()
    const auditor = ctx.any.account()
    const auditor2 = ctx.any.account()
    const auditor3 = ctx.any.account()
    const ops = ctx.any.account()

    callInScope(contract, () => contract.createApplication(payTo, mockUsdc))
    callInScope(contract, () => contract.setCrediter(crediter))
    callInScope(contract, () => contract.setIdentity('github:alice', auditor))
    callInScope(contract, () => contract.setIdentity('github:bob', auditor2))
    callInScope(contract, () => contract.setIdentity('github:carol', auditor3))
    callInScope(contract, () => contract.setIdentity('ops', ops))

    if (payToBalance > 0n) {
      ctx.ledger.updateAssetHolding(payTo, mockUsdc, payToBalance)
    }

    return { contract, admin, crediter, payTo, mockUsdc, auditor, auditor2, auditor3, ops }
  }

  const balanceOf = (contract: PaymentRouter, identity: string) => contract.balances(identity).value

  test('credit(): one tarball payment (1,000) credits auditor 300, ops 700', () => {
    const { contract, crediter, mockUsdc } = setup(1_000n)
    void mockUsdc

    callInScope(
      contract,
      () =>
        contract.credit(1n, 1000n, 0n, [
          { repo: 'octo/repo', identity: 'github:alice', amount: 300n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:alice')).toEqual(300n)
    expect(balanceOf(contract, 'ops')).toEqual(700n)
  })

  test('credit(): one lockfile payment (3,000, 3 reviewed packages) sums exactly', () => {
    const { contract, crediter } = setup(3_000n)

    callInScope(
      contract,
      () =>
        contract.credit(1n, 3000n, 0n, [
          { repo: 'octo/repo', identity: 'github:alice', amount: 300n },
          { repo: 'octo/repo', identity: 'github:bob', amount: 300n },
          { repo: 'octo/repo', identity: 'github:carol', amount: 300n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:alice')).toEqual(300n)
    expect(balanceOf(contract, 'github:bob')).toEqual(300n)
    expect(balanceOf(contract, 'github:carol')).toEqual(300n)
    expect(balanceOf(contract, 'ops')).toEqual(2_100n)
  })

  test('credit(): two payments for the same (repo, identity) collapse into one 600 entry', () => {
    const { contract, crediter } = setup(2_000n)

    callInScope(
      contract,
      () =>
        contract.credit(1n, 2000n, 0n, [
          { repo: 'octo/repo', identity: 'github:alice', amount: 600n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:alice')).toEqual(600n)
    expect(balanceOf(contract, 'ops')).toEqual(1_400n)
  })

  test('credit(): an odd attributedTotal (1,003) rounds the auditor share down', () => {
    // 1,003 x 300 / 1000 = 300.9 -> integer division floors to 300; ops
    // gets the remainder (703), never a fraction (invariant 7).
    const { contract, crediter } = setup(1_003n)

    callInScope(
      contract,
      () =>
        contract.credit(1n, 1003n, 0n, [
          { repo: 'octo/repo', identity: 'github:alice', amount: 300n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:alice')).toEqual(300n)
    expect(balanceOf(contract, 'ops')).toEqual(703n)
  })

  test('credit(): unattributedTotal 5,123 with attributedTotal 0 credits ops only', () => {
    const { contract, crediter } = setup(5_123n)

    callInScope(contract, () => contract.credit(1n, 0n, 5123n, []), { sender: crediter })

    expect(balanceOf(contract, 'ops')).toEqual(5_123n)
  })

  test('credit(): entries not summing to attributedTotal x 300 / 1000 fails', () => {
    const { contract, crediter } = setup(1_000n)

    expect(() =>
      callInScope(
        contract,
        () =>
          contract.credit(1n, 1000n, 0n, [
            { repo: 'octo/repo', identity: 'github:alice', amount: 200n },
          ]),
        { sender: crediter },
      ),
    ).toThrow()
  })

  test('credit(): batchSeq that is not last + 1 fails (gap)', () => {
    const { contract, crediter } = setup(1_000n)

    expect(() =>
      callInScope(contract, () => contract.credit(2n, 0n, 0n, []), { sender: crediter }),
    ).toThrow()
  })

  test('credit(): batchSeq that is not last + 1 fails (repeat)', () => {
    const { contract, crediter } = setup(2_000n)

    callInScope(contract, () => contract.credit(1n, 0n, 1000n, []), { sender: crediter })

    expect(() =>
      callInScope(contract, () => contract.credit(1n, 0n, 1000n, []), { sender: crediter }),
    ).toThrow()
  })

  test('credit(): attributedTotal + unattributedTotal above the unallocated balance fails', () => {
    const { contract, crediter } = setup(500n)

    expect(() =>
      callInScope(contract, () => contract.credit(1n, 0n, 1000n, []), { sender: crediter }),
    ).toThrow()
  })

  test('credit(): rejects a non-crediter sender', () => {
    const { contract, admin } = setup(1_000n)

    expect(() =>
      callInScope(contract, () => contract.credit(1n, 0n, 0n, []), { sender: admin }),
    ).toThrow()
  })

  test('credit(): an unmapped identity still accrues a balance', () => {
    const { contract, crediter } = setup(1_000n)

    callInScope(
      contract,
      () =>
        contract.credit(1n, 1000n, 0n, [
          { repo: 'octo/repo', identity: 'github:dave', amount: 300n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:dave')).toEqual(300n)
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

  test('claim(): a balance of 99,999 fails', () => {
    const { contract, crediter, ops } = setup(99_999n)

    callInScope(contract, () => contract.credit(1n, 0n, 99999n, []), { sender: crediter })

    expect(() =>
      callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 2000n }),
    ).toThrow()
  })

  test('claim(): a balance of 100,000 succeeds and pays the mapped ops address', () => {
    const { contract, crediter, payTo, mockUsdc, ops } = setup(100_000n)

    callInScope(contract, () => contract.credit(1n, 0n, 100000n, []), { sender: crediter })
    callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 2000n })

    const group = ctx.txn.lastGroup
    expect(group.itxnGroups).toHaveLength(1)
    const inner = group.itxnGroups[0].getAssetTransferInnerTxn(0)
    expect(inner.sender).toEqual(payTo)
    expect(inner.assetReceiver).toEqual(ops)
    expect(inner.assetAmount).toEqual(100_000n)
    void mockUsdc
  })

  test('claim(): an outer fee below 2,000 fails', () => {
    const { contract, crediter, ops } = setup(100_000n)

    callInScope(contract, () => contract.credit(1n, 0n, 100000n, []), { sender: crediter })

    expect(() =>
      callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 1_999n }),
    ).toThrow()
  })

  test('claim(): a sender that is not the mapped address fails', () => {
    const { contract, crediter, ops } = setup(100_000n)
    const stranger = ctx.any.account()
    void ops

    callInScope(contract, () => contract.credit(1n, 0n, 100000n, []), { sender: crediter })

    expect(() =>
      callInScope(contract, () => contract.claim('ops'), { sender: stranger, fee: 2000n }),
    ).toThrow('not the mapped address')
  })

  test('claim(): an admin remap moves future claims to the new address', () => {
    const { contract, admin, crediter } = setup(400_000n)
    const oldAddr = ctx.any.account()
    const newAddr = ctx.any.account()

    callInScope(contract, () => contract.setIdentity('github:erin', oldAddr), { sender: admin })
    callInScope(
      contract,
      () =>
        contract.credit(1n, 400000n, 0n, [
          { repo: 'octo/repo', identity: 'github:erin', amount: 120_000n },
        ]),
      { sender: crediter },
    )

    callInScope(contract, () => contract.setIdentity('github:erin', newAddr), { sender: admin })

    expect(() =>
      callInScope(contract, () => contract.claim('github:erin'), { sender: oldAddr, fee: 2000n }),
    ).toThrow('not the mapped address')

    callInScope(contract, () => contract.claim('github:erin'), { sender: newAddr, fee: 2000n })

    const group = ctx.txn.lastGroup
    const inner = group.itxnGroups[0].getAssetTransferInnerTxn(0)
    expect(inner.assetReceiver).toEqual(newAddr)
    expect(inner.assetAmount).toEqual(120_000n)
  })

  // ADR 0010 / SPEC §10.2a: announceRelease() then executeRelease() replace
  // releaseAuthority(). ctx.ledger.patchGlobalData({ round }) is the only
  // way this JavaScript harness can move Global.round; it does not build
  // the ARC-4 router, so no test here sends a real, separately-authorized
  // rekeyed transaction — see the UpdateApplication/DeleteApplication
  // caution below for the same limit applied to routing.
  describe('announceRelease() / executeRelease() (ADR 0010)', () => {
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
      const { contract, admin, ops } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 215_999n })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('release delay has not passed')
    })

    test('executeRelease(): succeeds on the last round of the execute window', () => {
      const { contract, admin, ops } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n + 215_999n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      const rekeyTxn = ctx.txn.lastGroup.itxnGroups[0].getPaymentInnerTxn(0)
      expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
    })

    test('executeRelease(): after the execute window closes fails', () => {
      // A stale announcement must not stay executable for good (audit L1).
      const { contract, admin, ops } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n + 216_000n })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('release window has expired')
    })

    test('executeRelease(): an expired announcement works again only after a new delay', () => {
      const { contract, admin, ops } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })

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

    test('executeRelease(): without "treasury" mapped fails, even after the delay', () => {
      const { contract, admin } = setup(0n)
      const releaseTo = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('treasury identity not mapped')
    })

    test('executeRelease(): a non-admin sender fails', () => {
      const { contract, admin, ops } = setup(0n)
      const releaseTo = ctx.any.account()
      const notAdmin = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: notAdmin }),
      ).toThrow('admin only')
    })

    test('executeRelease(): re-announcing overwrites the target and restarts the delay', () => {
      // Chosen behavior: the most recent announceRelease() call wins, and
      // the delay is measured from its round, not the first announcement's.
      const { contract, admin, ops } = setup(0n)
      const firstTarget = ctx.any.account()
      const secondTarget = ctx.any.account()

      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(firstTarget), { sender: admin })
      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.announceRelease(secondTarget), { sender: admin })

      // The delay from the first announcement has passed, but not from the
      // second (re-announcing) one.
      expect(() =>
        callInScope(contract, () => contract.executeRelease(), { sender: admin }),
      ).toThrow('release delay has not passed')

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      const group = ctx.txn.lastGroup
      const rekeyTxn = group.itxnGroups[0].getPaymentInnerTxn(0)
      expect(rekeyTxn.rekeyTo).toEqual(secondTarget)
    })

    test('executeRelease(): sweeps exactly creditedUnclaimed to treasury, zeroes it, and rekeys', () => {
      const { contract, admin, crediter, payTo, ops } = setup(1_000_000n)

      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })
      callInScope(contract, () => contract.credit(1n, 0n, 1_000_000n, []), { sender: crediter })

      const releaseTo = ctx.any.account()
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      const group = ctx.txn.lastGroup
      expect(group.itxnGroups).toHaveLength(2)
      const sweep = group.itxnGroups[0].getAssetTransferInnerTxn(0)
      expect(sweep.sender).toEqual(payTo)
      expect(sweep.assetReceiver).toEqual(ops)
      expect(sweep.assetAmount).toEqual(1_000_000n)
      const rekeyTxn = group.itxnGroups[1].getPaymentInnerTxn(0)
      expect(rekeyTxn.sender).toEqual(payTo)
      expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
    })

    test('executeRelease(): a zero creditedUnclaimed skips the sweep transfer', () => {
      const { contract, admin, ops } = setup(0n)
      const releaseTo = ctx.any.account()

      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })

      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      const group = ctx.txn.lastGroup
      expect(group.itxnGroups).toHaveLength(1)
      const rekeyTxn = group.itxnGroups[0].getPaymentInnerTxn(0)
      expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
    })

    test('credit() and claim() fail once the app is retired', () => {
      const { contract, admin, crediter, ops } = setup(1_000_000n)

      callInScope(contract, () => contract.setIdentity('treasury', ops), { sender: admin })
      callInScope(contract, () => contract.credit(1n, 0n, 1_000_000n, []), { sender: crediter })

      const releaseTo = ctx.any.account()
      ctx.ledger.patchGlobalData({ round: 1_000n })
      callInScope(contract, () => contract.announceRelease(releaseTo), { sender: admin })
      ctx.ledger.patchGlobalData({ round: 1_000n + 216_000n })
      callInScope(contract, () => contract.executeRelease(), { sender: admin })

      expect(() =>
        callInScope(contract, () => contract.credit(2n, 0n, 1n, []), { sender: crediter }),
      ).toThrow('app is retired')
      expect(() =>
        callInScope(contract, () => contract.claim('ops'), { sender: ops, fee: 2000n }),
      ).toThrow('app is retired')
    })
  })

  // CAUTION: algorand-typescript-testing calls contract methods directly.
  // It does not build or run the ARC-4 router the compiled approval program
  // uses to dispatch on OnCompletion. So this suite cannot send a real
  // UpdateApplication or DeleteApplication application call and observe the
  // router reject it; that only happens under Puya-compiled TEAL (see
  // docs/RUNBOOK-contract-build.md). Instead, this proves the two facts that
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
