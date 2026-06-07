#!/usr/bin/env node
// Completes remaining setup: opts treasury and ops into USDC, verifies app state.
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../mcp/package.json', import.meta.url))
const algosdk = require('algosdk')

// Load root .env
const envPath = path.join(__dirname, '..', '.env')
if (fs.existsSync(envPath)) {
  const lines = fs.readFileSync(envPath, 'utf8').split('\n')
  for (const line of lines) {
    const m = line.match(/^([A-Z_]+)="?([^"]*)"?$/)
    if (m) { if (!process.env[m[1]]) process.env[m[1]] = m[2] }
  }
}

const USDC_ASA_ID = 10458941
const algod = new algosdk.Algodv2(
  process.env['ALGOD_TOKEN'] ?? '',
  process.env['ALGOD_SERVER'] ?? 'https://testnet-api.algonode.cloud',
  Number(process.env['ALGOD_PORT'] ?? 443),
)

async function optInIfNeeded(name, mnemonic) {
  const acct = algosdk.mnemonicToSecretKey(mnemonic)
  const info = await algod.accountInformation(acct.addr.toString()).do()
  const optedIn = (info.assets ?? []).some(a => Number(a.assetId) === USDC_ASA_ID)
  if (optedIn) {
    console.log(`${name} (${acct.addr.toString().substring(0,8)}...) already opted into USDC.`)
    return
  }
  console.log(`Opting ${name} into USDC...`)
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: acct.addr.toString(),
    receiver: acct.addr.toString(),
    amount: 0,
    assetIndex: USDC_ASA_ID,
    suggestedParams: sp,
  })
  const signed = txn.signTxn(acct.sk)
  const { txid } = await algod.sendRawTransaction(signed).do()
  await algosdk.waitForConfirmation(algod, txid, 6)
  console.log(`  ${name} opted in. txid: ${txid}`)
}

console.log('== Finishing USDC opt-ins for treasury and ops ==')
await optInIfNeeded('treasury', process.env['TREASURY_MNEMONIC'])
await optInIfNeeded('ops', process.env['OPS_MNEMONIC'])

// Verify app state
const APP_ID = Number(process.env['SPLIT_APP_ID'])
if (APP_ID) {
  const appInfo = await algod.getApplicationByID(APP_ID).do()
  const gs = appInfo.params?.globalState ?? []
  console.log(`\nApp ${APP_ID} global state: ${gs.length} keys`)
}

// Check if PAYER has enough ALGO for the demo tx
const payerMnemonic = process.env['PAYER_MNEMONIC']
if (payerMnemonic) {
  const payer = algosdk.mnemonicToSecretKey(payerMnemonic)
  const info = await algod.accountInformation(payer.addr.toString()).do()
  const available = Number(info.amount) - Number(info['min-balance'])
  const usdc = (info.assets ?? []).find(a => Number(a.assetId) === USDC_ASA_ID)
  console.log(`\nPAYER available ALGO: ${available} µALGO`)
  console.log(`PAYER USDC balance: ${usdc ? usdc.amount : 'not opted in'} µUSDC`)
  if (available < 10000) {
    console.log('WARNING: PAYER needs more ALGO for demo tx fees (~10000 µALGO needed).')
    console.log('Fund via: https://bank.testnet.algorand.network/')
    console.log(`Address: ${payer.addr}`)
  }
  if (!usdc || usdc.amount < 1000) {
    console.log('WARNING: PAYER needs USDC for the demo payment (1000 µUSDC needed).')
    console.log('Fund via: https://faucet.circle.com/')
    console.log(`Address: ${payer.addr}`)
  }
}
console.log('\nSetup complete.')
