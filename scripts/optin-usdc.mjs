#!/usr/bin/env node
// Opts the PAYER account into USDC (ASA 10458941) on TestNet.
// Must run AFTER PAYER has at least 0.3 ALGO, BEFORE funding PAYER with USDC.
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
    const m = line.match(/^([A-Z_]+)=(.*)$/)
    if (m) {
      const val = m[2].replace(/^"(.*)"$/, '$1').replace(/^'(.*)'$/, '$1')
      if (!process.env[m[1]]) process.env[m[1]] = val
    }
  }
}

const USDC_ASA_ID = 10458941
const mnemonic = process.env['PAYER_MNEMONIC']
if (!mnemonic) { console.error('PAYER_MNEMONIC not set in .env'); process.exit(1) }

const payer = algosdk.mnemonicToSecretKey(mnemonic)
const algod = new algosdk.Algodv2(
  process.env['ALGOD_TOKEN'] ?? '',
  process.env['ALGOD_SERVER'] ?? 'https://testnet-api.algonode.cloud',
  Number(process.env['ALGOD_PORT'] ?? 443),
)

// Check if already opted in
const acctInfo = await algod.accountInformation(payer.addr.toString()).do()
// algosdk v3 uses camelCase: assetId (bigint)
const alreadyOptedIn = (acctInfo.assets ?? []).some(a => Number(a.assetId) === USDC_ASA_ID)
if (alreadyOptedIn) {
  console.log(`PAYER already opted into USDC (ASA ${USDC_ASA_ID}). Nothing to do.`)
  process.exit(0)
}

console.log(`Opting PAYER (${payer.addr}) into USDC (ASA ${USDC_ASA_ID})...`)
const sp = await algod.getTransactionParams().do()
const optinTxn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
  sender: payer.addr.toString(),
  receiver: payer.addr.toString(),
  amount: 0,
  assetIndex: USDC_ASA_ID,
  suggestedParams: sp,
})

const signedTxn = optinTxn.signTxn(payer.sk)
const { txid } = await algod.sendRawTransaction(signedTxn).do()
await algosdk.waitForConfirmation(algod, txid, 6)
console.log(`PAYER opted into USDC. txid: ${txid}`)
console.log(`\nNow fund PAYER with USDC at:`)
console.log(`  https://faucet.circle.com/`)
console.log(`  Address: ${payer.addr}`)
