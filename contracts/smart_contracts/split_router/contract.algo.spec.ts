import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, test } from 'vitest'
import { SplitRouter } from './contract.algo'

const UNIT = 1000n

describe('SplitRouter', () => {
  const ctx = new TestExecutionContext()

  afterEach(() => {
    ctx.reset()
  })

  const callInScope = <T>(
    fn: () => T,
    options?: { sender?: ReturnType<typeof ctx.any.account> },
  ): T => {
    const sender = options?.sender ?? ctx.defaultSender
    const txn = ctx.any.txn.applicationCall({ sender })
    return ctx.txn.createScope([txn], 0).execute(fn)
  }

  const setupFull = () => {
    const contract = ctx.contract.create(SplitRouter)
    const creator = ctx.defaultSender

    const auditor = ctx.any.account()
    const maintainer = ctx.any.account()
    const adversarial = ctx.any.account()
    const treasury = ctx.any.account()
    const ops = ctx.any.account()
    const mockUsdc = ctx.any.asset()

    callInScope(() =>
      contract.setRecipients(auditor, maintainer, adversarial, treasury, ops, mockUsdc),
    )

    const appRef = ctx.ledger.getApplicationForContract(contract)
    return { contract, creator, auditor, maintainer, adversarial, treasury, ops, mockUsdc, appRef }
  }

  test('split sum: 5 inner transfers sum to UNIT and have correct amounts', () => {
    const { contract, creator, auditor, maintainer, adversarial, treasury, ops, mockUsdc, appRef } =
      setupFull()

    const paymentTxn = ctx.any.txn.assetTransfer({
      sender: creator,
      assetReceiver: appRef.address,
      xferAsset: mockUsdc,
      assetAmount: UNIT,
    })
    const appCallTxn = ctx.any.txn.applicationCall({ sender: creator, appId: contract })

    ctx.txn.createScope([paymentTxn, appCallTxn], 1).execute(() => {
      contract.pay(paymentTxn, 'lodash', '4.17.21')
    })

    // submitGroup creates 5 separate itxnGroups (one per txn)
    const payGroup = ctx.txn.lastGroup
    expect(payGroup.itxnGroups).toHaveLength(5)

    const amounts = payGroup.itxnGroups.map((g) => g.getAssetTransferInnerTxn(0).assetAmount)
    expect(amounts).toEqual([500n, 200n, 150n, 100n, 50n])

    const total = amounts.reduce((a: bigint, b: bigint) => a + b, 0n)
    expect(total).toEqual(UNIT)

    const receivers = payGroup.itxnGroups.map(
      (g) => g.getAssetTransferInnerTxn(0).assetReceiver,
    )
    expect(receivers[0]).toEqual(auditor)
    expect(receivers[1]).toEqual(maintainer)
    expect(receivers[2]).toEqual(adversarial)
    expect(receivers[3]).toEqual(treasury)
    expect(receivers[4]).toEqual(ops)
  })

  test('attest() writes box and only auditor can call it', () => {
    const { contract, creator, auditor } = setupFull()

    callInScope(() => contract.attest('lodash', '4.17.21', 2n), { sender: auditor })

    const boxValue = contract.attests('lodash@4.17.21').value
    expect(boxValue.length).toEqual(80n)

    expect(() =>
      callInScope(() => contract.attest('lodash', '4.17.21', 2n), { sender: creator }),
    ).toThrow()
  })

  test('pay() rejects wrong asset', () => {
    const { contract, creator, appRef } = setupFull()
    const wrongAsset = ctx.any.asset()

    const badPayment = ctx.any.txn.assetTransfer({
      sender: creator,
      assetReceiver: appRef.address,
      xferAsset: wrongAsset,
      assetAmount: UNIT,
    })
    const appCallTxn = ctx.any.txn.applicationCall({ sender: creator, appId: contract })

    expect(() =>
      ctx.txn.createScope([badPayment, appCallTxn], 1).execute(() => {
        contract.pay(badPayment, 'lodash', '4.17.21')
      }),
    ).toThrow()
  })

  test('pay() rejects wrong amount', () => {
    const { contract, creator, mockUsdc, appRef } = setupFull()

    const badPayment = ctx.any.txn.assetTransfer({
      sender: creator,
      assetReceiver: appRef.address,
      xferAsset: mockUsdc,
      assetAmount: 999n,
    })
    const appCallTxn = ctx.any.txn.applicationCall({ sender: creator, appId: contract })

    expect(() =>
      ctx.txn.createScope([badPayment, appCallTxn], 1).execute(() => {
        contract.pay(badPayment, 'lodash', '4.17.21')
      }),
    ).toThrow()
  })

  test('pay() rejects wrong receiver', () => {
    const { contract, creator, mockUsdc } = setupFull()
    const wrongReceiver = ctx.any.account()

    const badPayment = ctx.any.txn.assetTransfer({
      sender: creator,
      assetReceiver: wrongReceiver,
      xferAsset: mockUsdc,
      assetAmount: UNIT,
    })
    const appCallTxn = ctx.any.txn.applicationCall({ sender: creator, appId: contract })

    expect(() =>
      ctx.txn.createScope([badPayment, appCallTxn], 1).execute(() => {
        contract.pay(badPayment, 'lodash', '4.17.21')
      }),
    ).toThrow()
  })
})
