import { Config, microAlgos } from '@algorandfoundation/algokit-utils'
import { algorandFixture } from '@algorandfoundation/algokit-utils/testing'
import algosdk from 'algosdk'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { SplitRouterFactory } from '../artifacts/split_router/SplitRouterClient'

const UNIT = 1000n // 1000 µUSDC = $0.001

const TOKEN = 'a'.repeat(64)
const LOCALNET_ALGOD = new algosdk.Algodv2(TOKEN, 'http://localhost', 4001)
const LOCALNET_INDEXER = new algosdk.Indexer(TOKEN, 'http://localhost', 8980)
const LOCALNET_KMD = new algosdk.Kmd(TOKEN, 'http://localhost', 4002)

describe('SplitRouter', () => {
  const localnet = algorandFixture({
    algod: LOCALNET_ALGOD,
    indexer: LOCALNET_INDEXER,
    kmd: LOCALNET_KMD,
  })

  beforeAll(() => {
    Config.configure({ debug: true })
  })
  beforeEach(localnet.newScope)

  const deploy = async (creator: string) => {
    const factory = new SplitRouterFactory({
      algorand: localnet.algorand,
      defaultSender: creator,
    })
    const { appClient } = await factory.deploy({ onUpdate: 'append', onSchemaBreak: 'append' })
    await localnet.algorand.send.payment({
      amount: (2).algo(),
      sender: creator,
      receiver: appClient.appAddress,
    })
    return appClient
  }

  const createMockUsdc = async (creator: string) => {
    const result = await localnet.algorand.send.assetCreate({
      sender: creator,
      total: BigInt(1_000_000_000),
      decimals: 6,
      assetName: 'Mock USDC',
      unitName: 'USDC',
      defaultFrozen: false,
    })
    return result.confirmation.assetIndex!
  }

  const setupFull = async () => {
    const { testAccount, generateAccount } = localnet.context
    const creator = testAccount.toString()
    const [auditor, maintainer, adversarial, treasury, ops] = await Promise.all(
      Array.from({ length: 5 }, () => generateAccount({ initialFunds: (1).algo() })),
    )
    const usdcId = await createMockUsdc(creator)
    const client = await deploy(creator)

    await client.send.optInToAsset({
      args: { asset: usdcId },
      coverAppCallInnerTransactionFees: true,
      maxFee: microAlgos(2_000), // outer + 1 inner = 2x minFee
    })

    for (const acct of [auditor, maintainer, adversarial, treasury, ops]) {
      await localnet.algorand.send.assetOptIn({ sender: acct.toString(), assetId: usdcId })
    }

    await client.send.setRecipients({
      args: {
        auditor: auditor.toString(),
        maintainer: maintainer.toString(),
        adversarial: adversarial.toString(),
        treasury: treasury.toString(),
        ops: ops.toString(),
        assetId: usdcId,
      },
    })

    return { creator, client, usdcId, auditor, maintainer, adversarial, treasury, ops }
  }

  test('split sum: 5 inner transfers sum to UNIT and have correct amounts', async () => {
    const { creator, client, usdcId, auditor, maintainer, adversarial, treasury, ops } =
      await setupFull()

    const paymentTxn = await localnet.algorand.createTransaction.assetTransfer({
      sender: creator,
      receiver: client.appAddress,
      assetId: usdcId,
      amount: UNIT,
    })

    const result = await client
      .newGroup()
      .pay({
        args: { payment: paymentTxn, pkg: 'lodash', ver: '4.17.21' },
        maxFee: microAlgos(6_000), // outer + 5 inner = 6x minFee
        accountReferences: [
          auditor.toString(),
          maintainer.toString(),
          adversarial.toString(),
          treasury.toString(),
          ops.toString(),
        ],
        assetReferences: [usdcId],
      })
      .send({ coverAppCallInnerTransactionFees: true, populateAppCallResources: false })

    // The group is: [assetTransfer (added by SDK as txn arg), appCall]
    // confirmations[1] is the app call (index 1 in the group)
    const appcallConfirmation = result.confirmations?.[1]
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const innerTxns: unknown[] = (appcallConfirmation as any)?.innerTxns ?? []
    expect(innerTxns).toHaveLength(5)

    // In algosdk v3 confirmations, inner txn amounts are at txn.txn.assetTransfer.amount
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const amounts = innerTxns.map((t: any) => BigInt(t.txn?.txn?.assetTransfer?.amount ?? 0))
    const total = amounts.reduce((a: bigint, b: bigint) => a + b, 0n)
    expect(total).toBe(UNIT)
    expect(amounts).toEqual([500n, 200n, 150n, 100n, 50n])

    // Verify recipients got the correct amounts
    const auditorAddr = auditor.toString()
    const maintainerAddr = maintainer.toString()
    const adversarialAddr = adversarial.toString()
    const treasuryAddr = treasury.toString()
    const opsAddr = ops.toString()

    const auditorBalance = await localnet.algorand.asset.getAccountInformation(auditorAddr, usdcId)
    const maintainerBalance = await localnet.algorand.asset.getAccountInformation(
      maintainerAddr,
      usdcId,
    )
    const adversarialBalance = await localnet.algorand.asset.getAccountInformation(
      adversarialAddr,
      usdcId,
    )
    const treasuryBalance = await localnet.algorand.asset.getAccountInformation(
      treasuryAddr,
      usdcId,
    )
    const opsBalance = await localnet.algorand.asset.getAccountInformation(opsAddr, usdcId)

    expect(auditorBalance.balance).toBe(500n)
    expect(maintainerBalance.balance).toBe(200n)
    expect(adversarialBalance.balance).toBe(150n)
    expect(treasuryBalance.balance).toBe(100n)
    expect(opsBalance.balance).toBe(50n)
  })

  test('attest() writes box and only auditor can call it', async () => {
    const { creator, client, usdcId, auditor } = await setupFull()

    const boxKeyStr = 'attest:lodash@4.17.21'
    const boxKey = new TextEncoder().encode(boxKeyStr)

    // Auditor can attest (status 2 = COMMUNITY_REVIEWED)
    await client.send.attest({
      args: { pkg: 'lodash', ver: '4.17.21', status: 2n },
      sender: auditor.toString(),
      boxReferences: [{ appId: client.appId, name: boxKey }],
    })

    // Box should exist and be 80 bytes: auditor(32) + txId(32) + status(8) + ts(8)
    const boxResult = await localnet.algorand.client.algod
      .getApplicationBoxByName(Number(client.appId), boxKey)
      .do()
    expect(boxResult.value).toBeDefined()
    expect(boxResult.value.length).toBe(80)

    // Non-auditor cannot attest
    await expect(
      client.send.attest({
        args: { pkg: 'lodash', ver: '4.17.21', status: 2n },
        sender: creator,
        boxReferences: [{ appId: client.appId, name: boxKey }],
      }),
    ).rejects.toThrow()
  })

  test('pay() rejects wrong asset', async () => {
    const { creator, client } = await setupFull()
    const wrongId = await createMockUsdc(creator)

    await localnet.algorand.send.assetOptIn({ sender: creator, assetId: wrongId })
    const badPayment = await localnet.algorand.createTransaction.assetTransfer({
      sender: creator,
      receiver: client.appAddress,
      assetId: wrongId,
      amount: UNIT,
    })

    await expect(
      client
        .newGroup()
        .pay({
          args: { payment: badPayment, pkg: 'lodash', ver: '4.17.21' },
          maxFee: microAlgos(6_000),
        })
        .send({ coverAppCallInnerTransactionFees: true }),
    ).rejects.toThrow()
  })

  test('pay() rejects wrong amount', async () => {
    const { creator, client, usdcId } = await setupFull()

    const badPayment = await localnet.algorand.createTransaction.assetTransfer({
      sender: creator,
      receiver: client.appAddress,
      assetId: usdcId,
      amount: 999n, // wrong amount
    })

    await expect(
      client
        .newGroup()
        .pay({
          args: { payment: badPayment, pkg: 'lodash', ver: '4.17.21' },
          maxFee: microAlgos(6_000),
        })
        .send({ coverAppCallInnerTransactionFees: true }),
    ).rejects.toThrow()
  })

  test('pay() rejects wrong receiver', async () => {
    const { creator, client, usdcId } = await setupFull()

    // Send USDC to creator instead of the app address
    const wrongReceiver = creator
    const badPayment = await localnet.algorand.createTransaction.assetTransfer({
      sender: creator,
      receiver: wrongReceiver,
      assetId: usdcId,
      amount: UNIT,
    })

    await expect(
      client
        .newGroup()
        .pay({
          args: { payment: badPayment, pkg: 'lodash', ver: '4.17.21' },
          maxFee: microAlgos(6_000),
        })
        .send({ coverAppCallInnerTransactionFees: true }),
    ).rejects.toThrow()
  })
})
