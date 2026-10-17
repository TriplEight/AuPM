// Measures how many payees one credit() group reaches on LocalNet.
//
// Run: pnpm --dir contracts exec tsx scripts/measure-credit-group.ts
// Needs a running LocalNet (algokit localnet start). It deploys the app, uses a
// test asset as USDC, and sends one group per step: credit() plus refs() calls.
// Each refs() call carries the asset and up to 7 receiver accounts. N grows
// until a group fails. The script prints the largest N that succeeded.
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { PaymentRouterFactory } from '../smart_contracts/artifacts/payment_router/PaymentRouterClient'

const MAX_REFS_PER_GROUP = 15
const ACCOUNTS_PER_REFS = 7
const STEP = 5
const MAX_PAYEES = 150
const CARRY_IN = 1_000_000_000n
const FUND_PER_RECEIVER = microAlgos(300_000)

async function main(): Promise<void> {
  const algorand = AlgorandClient.defaultLocalNet()
  const dispenser = await algorand.account.localNetDispenser()
  const crediter = algorand.account.random()
  const payTo = algorand.account.random()
  const ops = algorand.account.random()
  const treasury = algorand.account.random()
  const core = [crediter, payTo, ops, treasury]

  for (const account of core) {
    await algorand.send.payment({
      sender: dispenser.addr,
      receiver: account.addr,
      amount: microAlgos(2_000_000),
    })
  }

  const created = await algorand.send.assetCreate({
    sender: dispenser.addr,
    total: 10_000_000_000_000n,
    decimals: 6,
    assetName: 'TestUSDC',
  })
  const assetId = created.assetId
  for (const account of [payTo, ops, treasury]) {
    await algorand.send.assetOptIn({ sender: account.addr, assetId })
  }
  await algorand.send.assetTransfer({
    sender: dispenser.addr,
    receiver: payTo.addr,
    assetId,
    amount: CARRY_IN,
  })

  const factory = algorand.client.getTypedAppFactory(PaymentRouterFactory, {
    defaultSender: dispenser.addr,
  })
  const { appClient } = await factory.send.create.createApplication({
    args: {
      payTo: payTo.addr.toString(),
      usdcAsset: assetId,
      carryIn: CARRY_IN,
      opsAddress: ops.addr.toString(),
      treasuryAddress: treasury.addr.toString(),
      payoutCap: CARRY_IN,
    },
  })
  await appClient.send.setCrediter({ args: { addr: crediter.addr.toString() } })
  await algorand.send.payment({
    sender: payTo.addr,
    receiver: payTo.addr,
    amount: microAlgos(0),
    rekeyTo: appClient.appAddress,
  })

  const receivers = Array.from({ length: MAX_PAYEES }, () => algorand.account.random())
  let best = 0
  let batchSeq = 1n
  let opted = 0

  for (let n = STEP; n <= MAX_PAYEES; n += STEP) {
    while (opted < n) {
      const receiver = receivers[opted]
      await algorand.send.payment({
        sender: dispenser.addr,
        receiver: receiver.addr,
        amount: FUND_PER_RECEIVER,
      })
      await algorand.send.assetOptIn({ sender: receiver.addr, assetId })
      opted += 1
    }

    const refsCount = Math.ceil(n / ACCOUNTS_PER_REFS)
    if (refsCount > MAX_REFS_PER_GROUP) {
      console.log(`N=${n}: needs ${refsCount} refs() calls, above the group limit; stop.`)
      break
    }

    const client = appClient.clone({ defaultSender: crediter.addr })
    const group = client.newGroup().credit({
      args: {
        batchSeq,
        newTotal: 0n,
        unattributedTotal: 0n,
        treasuryExtra: 0n,
        payouts: receivers.slice(0, n).map((r): [string, bigint] => [r.addr.toString(), 1n]),
      },
      accountReferences: [payTo.addr.toString()],
      assetReferences: [assetId],
      staticFee: microAlgos(1_000 * (n + 1)),
    })
    for (let i = 0; i < refsCount; i += 1) {
      group.refs({
        args: [],
        note: `refs-${i}`,
        assetReferences: [assetId],
        accountReferences: receivers
          .slice(i * ACCOUNTS_PER_REFS, (i + 1) * ACCOUNTS_PER_REFS)
          .map((r) => r.addr.toString()),
      })
    }

    try {
      await group.send({ populateAppCallResources: false })
    } catch (error) {
      console.log(`N=${n}: group failed: ${error instanceof Error ? error.message : error}`)
      break
    }
    console.log(`N=${n}: group ok (${refsCount} refs() calls).`)
    best = n
    batchSeq += 1n
  }

  console.log(`Max payees per group (step ${STEP}): ${best}`)
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
