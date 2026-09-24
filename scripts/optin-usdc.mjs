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
const require = createRequire(new URL('../proxy/package.json', import.meta.url))
const algosdk = require('algosdk')

/**
 * Loads the root `.env` into `process.env`, without overwriting a variable
 * already set. Called only from the CLI entry path below, never at module
 * import time (R3a Result 2: an importer must never gain a real mnemonic
 * just by importing this file).
 */
function loadRootEnv() {
  const envPath = path.join(__dirname, '..', '.env')
  if (!fs.existsSync(envPath)) return
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

/**
 * Opts `account` into `network`'s USDC asset, unless it already holds it.
 * Returns the confirmed opt-in transaction id, or null when `account` was
 * already opted in. Explicit-argument core of `main()` below, so a TestNet
 * rehearsal script can opt in a fresh, in-memory account without this
 * module's own CLI/.env plumbing (R3a).
 *
 * @param {object} params
 * @param {import('algosdk').Algodv2} params.algod
 * @param {'testnet'|'mainnet'} params.network
 * @param {{addr: {toString(): string}, sk: Uint8Array}} params.account
 * @returns {Promise<string|null>}
 */
export async function optinAccountToUsdc({ algod, network, account }) {
  const usdcAsaId = Number(usdcAssetId(network))
  const address = account.addr.toString()
  const acctInfo = await algod.accountInformation(address).do()
  const alreadyOptedIn = (acctInfo.assets ?? []).some((a) => Number(a.assetId) === usdcAsaId)
  if (alreadyOptedIn) return null

  const sp = await algod.getTransactionParams().do()
  const optinTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    assetIndex: usdcAsaId,
    suggestedParams: sp,
  })
  const signedTxn = optinTxn.signTxn(account.sk)
  const { txid } = await algod.sendRawTransaction(signedTxn).do()
  await algosdk.waitForConfirmation(algod, txid, 6)
  return txid
}

async function main() {
  loadRootEnv()

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

  const txid = await optinAccountToUsdc({ algod, network, account })
  if (!txid) {
    console.log(
      `${envVarName} (${account.addr}) already opted into USDC (ASA ${usdcAsaId}). Nothing to do.`,
    )
    return
  }
  console.log(`${envVarName} opted into USDC. txid: ${txid}`)
  if (network === 'testnet') {
    console.log(`\nNow fund ${envVarName} with USDC at:`)
    console.log(`  https://faucet.circle.com/`)
    console.log(`  Address: ${account.addr}`)
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
  })
}
