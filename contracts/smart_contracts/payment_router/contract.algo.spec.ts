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

  test('credit(): one tarball payment (1,000) credits auditor 400, ops 600', () => {
    const { contract, crediter, mockUsdc } = setup(1_000n)
    void mockUsdc

    callInScope(
      contract,
      () =>
        contract.credit(1n, 1000n, 0n, [
          { repo: 'octo/repo', identity: 'github:alice', amount: 400n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:alice')).toEqual(400n)
    expect(balanceOf(contract, 'ops')).toEqual(600n)
  })

  test('credit(): one lockfile payment (3,000, 3 reviewed packages) sums exactly', () => {
    const { contract, crediter } = setup(3_000n)

    callInScope(
      contract,
      () =>
        contract.credit(1n, 3000n, 0n, [
          { repo: 'octo/repo', identity: 'github:alice', amount: 400n },
          { repo: 'octo/repo', identity: 'github:bob', amount: 400n },
          { repo: 'octo/repo', identity: 'github:carol', amount: 400n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:alice')).toEqual(400n)
    expect(balanceOf(contract, 'github:bob')).toEqual(400n)
    expect(balanceOf(contract, 'github:carol')).toEqual(400n)
    expect(balanceOf(contract, 'ops')).toEqual(1_800n)
  })

  test('credit(): two payments for the same (repo, identity) collapse into one 800 entry', () => {
    const { contract, crediter } = setup(2_000n)

    callInScope(
      contract,
      () =>
        contract.credit(1n, 2000n, 0n, [
          { repo: 'octo/repo', identity: 'github:alice', amount: 800n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:alice')).toEqual(800n)
    expect(balanceOf(contract, 'ops')).toEqual(1_200n)
  })

  test('credit(): unattributedTotal 5,123 with attributedTotal 0 credits ops only', () => {
    const { contract, crediter } = setup(5_123n)

    callInScope(contract, () => contract.credit(1n, 0n, 5123n, []), { sender: crediter })

    expect(balanceOf(contract, 'ops')).toEqual(5_123n)
  })

  test('credit(): entries not summing to attributedTotal x 400 / 1000 fails', () => {
    const { contract, crediter } = setup(1_000n)

    expect(() =>
      callInScope(
        contract,
        () =>
          contract.credit(1n, 1000n, 0n, [
            { repo: 'octo/repo', identity: 'github:alice', amount: 300n },
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
          { repo: 'octo/repo', identity: 'github:dave', amount: 400n },
        ]),
      { sender: crediter },
    )

    expect(balanceOf(contract, 'github:dave')).toEqual(400n)
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
      callInScope(contract, () => contract.releaseAuthority(someone), { sender: notAdmin }),
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
    const { contract, admin, crediter } = setup(250_000n)
    const oldAddr = ctx.any.account()
    const newAddr = ctx.any.account()

    callInScope(contract, () => contract.setIdentity('github:erin', oldAddr), { sender: admin })
    callInScope(
      contract,
      () =>
        contract.credit(1n, 250000n, 0n, [
          { repo: 'octo/repo', identity: 'github:erin', amount: 100_000n },
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
    expect(inner.assetAmount).toEqual(100_000n)
  })

  test('releaseAuthority(): rekeys payTo to the given address', () => {
    const { contract, admin, payTo } = setup(0n)
    const releaseTo = ctx.any.account()

    callInScope(contract, () => contract.releaseAuthority(releaseTo), { sender: admin })

    const group = ctx.txn.lastGroup
    expect(group.itxnGroups).toHaveLength(1)
    const rekeyTxn = group.itxnGroups[0].getPaymentInnerTxn(0)
    expect(rekeyTxn.sender).toEqual(payTo)
    expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
  })
})
