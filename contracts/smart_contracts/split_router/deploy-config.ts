import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import dotenv from 'dotenv'
import path from 'node:path'
import { SplitRouterFactory } from '../artifacts/split_router/SplitRouterClient'

// Load root .env first, then override with contracts-level .env if present
dotenv.config({ path: path.resolve(__dirname, '../../../.env') })
dotenv.config({ path: path.resolve(process.cwd(), '.env') })

const USDC_TESTNET_ASA_ID = 10458941n

function loadAccount(envVar: string): algosdk.Account {
  const mnemonic = process.env[envVar]
  if (!mnemonic) throw new Error(`Missing env var: ${envVar}`)
  return algosdk.mnemonicToSecretKey(mnemonic)
}

export async function deploy() {
  console.log('=== Deploying SplitRouter ===')

  const algorand = AlgorandClient.fromEnvironment()
  const deployer = loadAccount('PAYER_MNEMONIC')

  algorand.setSigner(
    deployer.addr,
    algosdk.makeBasicAccountTransactionSigner(deployer),
  )
  algorand.setDefaultSigner(algosdk.makeBasicAccountTransactionSigner(deployer))

  const recipients = {
    auditor: loadAccount('AUDITOR_MNEMONIC'),
    maintainer: loadAccount('MAINTAINER_MNEMONIC'),
    adversarial: loadAccount('ADVERSARIAL_MNEMONIC'),
    treasury: loadAccount('TREASURY_MNEMONIC'),
    ops: loadAccount('OPS_MNEMONIC'),
  }

  const factory = algorand.client.getTypedAppFactory(SplitRouterFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({
    onUpdate: 'append',
    onSchemaBreak: 'append',
  })

  console.log(`APP_ID=${appClient.appId}`)
  console.log(`APP_ADDRESS=${appClient.appAddress}`)

  // Fund app account on first deploy (box MBR + ASA opt-in MBR)
  if (result.operationPerformed === 'create' || result.operationPerformed === 'replace') {
    await algorand.send.payment({
      sender: deployer.addr,
      receiver: appClient.appAddress,
      amount: microAlgos(2_000_000),
    })
    console.log('App account funded with 2 ALGO.')
  }

  // Set recipients
  await appClient.send.setRecipients({
    args: {
      auditor: recipients.auditor.addr.toString(),
      maintainer: recipients.maintainer.addr.toString(),
      adversarial: recipients.adversarial.addr.toString(),
      treasury: recipients.treasury.addr.toString(),
      ops: recipients.ops.addr.toString(),
      assetId: USDC_TESTNET_ASA_ID,
    },
  })
  console.log('Recipients set.')

  // App account opts into USDC
  await appClient.send.optInToAsset({
    args: { asset: USDC_TESTNET_ASA_ID },
    coverAppCallInnerTransactionFees: true,
  })
  console.log('App account opted into USDC.')

  // Fund each recipient with 0.3 ALGO from PAYER so they can cover opt-in MBR + fee
  algorand.setSigner(deployer.addr, algosdk.makeBasicAccountTransactionSigner(deployer))
  for (const [name, acct] of Object.entries(recipients)) {
    await algorand.send.payment({
      sender: deployer.addr,
      receiver: acct.addr,
      amount: microAlgos(300_000), // 0.3 ALGO covers 0.2 MBR + 0.001 fee + buffer
    })
    console.log(`Funded ${name} with 0.3 ALGO.`)
  }

  // Each recipient opts into USDC
  for (const [name, acct] of Object.entries(recipients)) {
    algorand.setSigner(acct.addr, algosdk.makeBasicAccountTransactionSigner(acct))
    await algorand.send.assetOptIn({
      sender: acct.addr,
      assetId: USDC_TESTNET_ASA_ID,
    })
    console.log(`${name} opted into USDC.`)
  }

  console.log('\n=== Deploy complete ===')
  console.log(`APP_ID=${appClient.appId}`)
  console.log(`APP_ADDRESS=${appClient.appAddress}`)
  console.log('\nAdd these to root .env:')
  console.log(`SPLIT_APP_ID=${appClient.appId}`)
  console.log(`SPLIT_APP_ADDRESS=${appClient.appAddress}`)
}
