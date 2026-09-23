#!/usr/bin/env node
// Opts an account into USDC. Signs and sends a transaction, so on MainNet
// it refuses without --confirm-mainnet (scripts/network.mjs). Takes the
// mnemonic env var name as an argument rather than hardcoding one account —
// scripts/deploy-testnet.sh used to always opt in the donor; the payTo
// account needs the same opt-in before the PaymentRouter rekey (R2), and
// this script now serves both.
//
// Usage: node scripts/optin-usdc.mjs <MNEMONIC_ENV_VAR> [--network testnet|mainnet] [--confirm-mainnet]
// Example: node scripts/optin-usdc.mjs SPM_DONOR_MNEMONIC --network testnet
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { algodEndpoint, assertMainnetConfirmed, parseNetworkFlag, usdcAssetId } from './network.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../mcp/package.json', import.meta.url))
const algosdk = require('algosdk')

// Load root .env
const envPath = path.join(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) {
      const val = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      if (!process.env[m[1]]) process.env[m[1]] = val
    }
  }
}

function printUsage() {
  console.error(
    'Usage: node scripts/optin-usdc.mjs <MNEMONIC_ENV_VAR> [--network testnet|mainnet] [--confirm-mainnet]',
  )
  console.error('Example: node scripts/optin-usdc.mjs SPM_DONOR_MNEMONIC --network testnet')
}

async function main() {
  const argv = process.argv.slice(2)
  const envVarName = argv[0]
  if (!envVarName || envVarName.startsWith('--')) {
    printUsage()
    process.exit(2)
  }

  const network = parseNetworkFlag(argv)
  assertMainnetConfirmed(network, argv)

  const mnemonic = process.env[envVarName]
  if (!mnemonic) {
    console.error(`${envVarName} not set in .env`)
    process.exit(1)
  }

  const usdcAsaId = Number(usdcAssetId(network))
  const { server, port, token } = algodEndpoint(network)
  const algod = new algosdk.Algodv2(token, server, port)

  const account = algosdk.mnemonicToSecretKey(mnemonic)

  // Check if already opted in
  const acctInfo = await algod.accountInformation(account.addr.toString()).do()
  // algosdk v3 uses camelCase: assetId (bigint)
  const alreadyOptedIn = (acctInfo.assets ?? []).some((a) => Number(a.assetId) === usdcAsaId)
  if (alreadyOptedIn) {
    console.log(
      `${envVarName} (${account.addr}) already opted into USDC (ASA ${usdcAsaId}). Nothing to do.`,
    )
    process.exit(0)
  }

  console.log(
    `Opting ${envVarName} (${account.addr}) into USDC (ASA ${usdcAsaId}) on ${network}...`,
  )
  const sp = await algod.getTransactionParams().do()
  const optinTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.addr.toString(),
    receiver: account.addr.toString(),
    amount: 0,
    assetIndex: usdcAsaId,
    suggestedParams: sp,
  })

  const signedTxn = optinTxn.signTxn(account.sk)
  const { txid } = await algod.sendRawTransaction(signedTxn).do()
  await algosdk.waitForConfirmation(algod, txid, 6)
  console.log(`${envVarName} opted into USDC. txid: ${txid}`)
  if (network === 'testnet') {
    console.log(`\nNow fund ${envVarName} with USDC at:`)
    console.log(`  https://faucet.circle.com/`)
    console.log(`  Address: ${account.addr}`)
  }
}

main().catch((e) => {
  console.error(`FAIL  ${e.message}`)
  process.exit(1)
})
