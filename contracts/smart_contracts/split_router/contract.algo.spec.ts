import { TestExecutionContext } from '@algorandfoundation/algorand-typescript-testing'
import { afterEach, describe, expect, test } from 'vitest'
import { SplitRouter } from './contract.algo'

describe('SplitRouter', () => {
  const ctx = new TestExecutionContext()

  afterEach(() => {
    ctx.reset()
  })

  // appId MUST be set on the scoped txn: Global.currentApplicationAddress (used
  // by setRecipients' payTo default and by distribute()) only resolves against
  // the txn's own appId, not the contract under test implicitly.
  const callInScope = <T>(
    contract: SplitRouter,
    fn: () => T,
    options?: { sender?: ReturnType<typeof ctx.any.account>; fee?: bigint },
  ): T => {
    const sender = options?.sender ?? ctx.defaultSender
    const fee = options?.fee ?? 1000n
    const txn = ctx.any.txn.applicationCall({ sender, fee, appId: contract })
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

    callInScope(contract, () =>
      contract.setRecipients(auditor, maintainer, adversarial, treasury, ops, mockUsdc),
    )

    const appRef = ctx.ledger.getApplicationForContract(contract)
    return { contract, creator, auditor, maintainer, adversarial, treasury, ops, mockUsdc, appRef }
  }

  test('distribute(): 5-way split of the divisible balance, dust carries to the next call', () => {
    const { contract, auditor, maintainer, adversarial, treasury, ops, mockUsdc, appRef } =
      setupFull()

    // Stage 1: fund payTo (the app address) with 777,700 microUSDC.
    ctx.ledger.updateAssetHolding(appRef.address, mockUsdc, 777_700n)

    callInScope(contract, () => contract.distribute(), { fee: 6000n })

    const group1 = ctx.txn.lastGroup
    expect(group1.itxnGroups).toHaveLength(5)

    const amounts1 = group1.itxnGroups.map((g) => g.getAssetTransferInnerTxn(0).assetAmount)
    expect(amounts1).toEqual([388_500n, 155_400n, 116_550n, 77_700n, 38_850n])
    const distributed1 = amounts1.reduce((a: bigint, b: bigint) => a + b, 0n)
    expect(distributed1).toEqual(777_000n)
    // dust: the emulator does not auto-debit itxn amounts from ledger balances,
    // so the untouched remainder is the funded balance minus what distribute()
    // actually moved.
    expect(777_700n - distributed1).toEqual(700n)

    const senders1 = group1.itxnGroups.map((g) => g.getAssetTransferInnerTxn(0).sender)
    for (const s of senders1) {
      expect(s).toEqual(appRef.address)
    }

    const receivers1 = group1.itxnGroups.map((g) => g.getAssetTransferInnerTxn(0).assetReceiver)
    expect(receivers1[0]).toEqual(auditor)
    expect(receivers1[1]).toEqual(maintainer)
    expect(receivers1[2]).toEqual(adversarial)
    expect(receivers1[3]).toEqual(treasury)
    expect(receivers1[4]).toEqual(ops)

    // Stage 2: add 99,300 to the 700 dust -> balance is exactly 100,000, the
    // MIN_DISTRIBUTE boundary.
    ctx.ledger.updateAssetHolding(appRef.address, mockUsdc, 100_000n)

    callInScope(contract, () => contract.distribute(), { fee: 6000n })

    const group2 = ctx.txn.lastGroup
    expect(group2.itxnGroups).toHaveLength(5)

    const amounts2 = group2.itxnGroups.map((g) => g.getAssetTransferInnerTxn(0).assetAmount)
    expect(amounts2).toEqual([50_000n, 20_000n, 15_000n, 10_000n, 5_000n])
    const distributed2 = amounts2.reduce((a: bigint, b: bigint) => a + b, 0n)
    expect(distributed2).toEqual(100_000n)
    expect(100_000n - distributed2).toEqual(0n)
  })

  test('distribute() rejects a balance below MIN_DISTRIBUTE (100,000 microUSDC)', () => {
    const { contract, mockUsdc, appRef } = setupFull()
    // 99,999 floors to a divisible portion of 99,000 (1000-unit granularity),
    // which is below the 100,000 gate.
    ctx.ledger.updateAssetHolding(appRef.address, mockUsdc, 99_999n)

    expect(() => callInScope(contract, () => contract.distribute(), { fee: 6000n })).toThrow()
  })

  test('distribute() rejects an outer fee below 6000 microALGO', () => {
    const { contract, mockUsdc, appRef } = setupFull()
    ctx.ledger.updateAssetHolding(appRef.address, mockUsdc, 500_000n)

    expect(() => callInScope(contract, () => contract.distribute(), { fee: 5_999n })).toThrow()
  })

  test('attest() rejects a non-auditor sender', () => {
    const { contract, creator } = setupFull()

    expect(() =>
      callInScope(contract, () => contract.attest('lodash', '4.17.21', 2n, 'sha512-abc123=='), {
        sender: creator,
      }),
    ).toThrow()
  })

  test('attest() from the auditor writes the integrity string into the box', () => {
    const { contract, auditor } = setupFull()
    const integrity = 'sha512-Zx9F+deadbeef=='

    callInScope(contract, () => contract.attest('lodash', '4.17.21', 2n, integrity), {
      sender: auditor,
    })

    const boxValue = contract.attests('lodash@4.17.21').value
    // Pack layout: auditor(32) + txId(32) + status(8) + ts(8) + integrity(variable)
    const tail = boxValue.slice(80).toString()
    expect(tail).toEqual(integrity)
  })

  test('releaseAuthority() rejects a non-admin sender', () => {
    const { contract, auditor } = setupFull()
    const someoneElse = ctx.any.account()

    expect(() =>
      callInScope(contract, () => contract.releaseAuthority(someoneElse), { sender: auditor }),
    ).toThrow()
  })

  test('releaseAuthority() rejects when payTo is still the application address', () => {
    const { contract, creator } = setupFull()
    const someoneElse = ctx.any.account()

    // setupFull() never overrides payTo, so it still defaults to the app
    // address here. An app account cannot be rekeyed.
    expect(() =>
      callInScope(contract, () => contract.releaseAuthority(someoneElse), { sender: creator }),
    ).toThrow('payTo is the application address; an app account cannot be rekeyed')
  })

  test('setPayTo() rejects a non-admin sender', () => {
    const contract = ctx.contract.create(SplitRouter)
    const notCreator = ctx.any.account()
    const external = ctx.any.account()

    expect(() =>
      callInScope(contract, () => contract.setPayTo(external), { sender: notCreator }),
    ).toThrow('admin only')
  })

  test('setPayTo() rejects the application address', () => {
    const contract = ctx.contract.create(SplitRouter)
    const appRef = ctx.ledger.getApplicationForContract(contract)
    const appAddress = ctx.ledger.getAccount(appRef.address)

    expect(() => callInScope(contract, () => contract.setPayTo(appAddress))).toThrow(
      'use the default app-address path instead',
    )
  })

  test('setPayTo() with an external address succeeds; setRecipients() then leaves it alone', () => {
    const contract = ctx.contract.create(SplitRouter)
    const external = ctx.any.account()

    callInScope(contract, () => contract.setPayTo(external))
    expect(contract.payTo.value).toEqual(external.bytes)

    const auditor = ctx.any.account()
    const maintainer = ctx.any.account()
    const adversarial = ctx.any.account()
    const treasury = ctx.any.account()
    const ops = ctx.any.account()
    const mockUsdc = ctx.any.asset()

    callInScope(contract, () =>
      contract.setRecipients(auditor, maintainer, adversarial, treasury, ops, mockUsdc),
    )

    // setRecipients' `if (!this.payTo.hasValue)` guard must leave the
    // already-set external payTo untouched.
    expect(contract.payTo.value).toEqual(external.bytes)
  })

  test('setPayTo() is write-once: a second call is rejected after the first succeeds', () => {
    const contract = ctx.contract.create(SplitRouter)
    const first = ctx.any.account()
    const second = ctx.any.account()

    callInScope(contract, () => contract.setPayTo(first))

    expect(() => callInScope(contract, () => contract.setPayTo(second))).toThrow(
      'payTo already set',
    )
    expect(contract.payTo.value).toEqual(first.bytes)
  })

  test('default path: setRecipients() alone leaves payTo at the app address', () => {
    const { contract, appRef } = setupFull()

    expect(contract.payTo.value).toEqual(appRef.address.bytes)
  })

  test('variant B: releaseAuthority() succeeds once payTo is an external, rekeyed account', () => {
    const contract = ctx.contract.create(SplitRouter)
    const creator = ctx.defaultSender
    const external = ctx.any.account()

    callInScope(contract, () => contract.setPayTo(external))

    const auditor = ctx.any.account()
    const maintainer = ctx.any.account()
    const adversarial = ctx.any.account()
    const treasury = ctx.any.account()
    const ops = ctx.any.account()
    const mockUsdc = ctx.any.asset()

    callInScope(contract, () =>
      contract.setRecipients(auditor, maintainer, adversarial, treasury, ops, mockUsdc),
    )

    const releaseTo = ctx.any.account()
    callInScope(contract, () => contract.releaseAuthority(releaseTo), { sender: creator })

    const group = ctx.txn.lastGroup
    expect(group.itxnGroups).toHaveLength(1)
    const rekeyTxn = group.itxnGroups[0].getPaymentInnerTxn(0)
    expect(rekeyTxn.sender).toEqual(external)
    expect(rekeyTxn.rekeyTo).toEqual(releaseTo)
  })
})
