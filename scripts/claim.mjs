#!/usr/bin/env node
// Claims one identity's PaymentRouter balance (SPEC §13.3, ADR 0005). The
// address the admin mapped to `identity` (via setIdentity, an admin-only,
// out-of-band step this script never performs) signs claim(identity); the
// contract pays the whole balances[identity] box to the sender and deletes
// it. Refuses below MIN_CLAIM, refuses when the signer is not the mapped
// address, refuses on MainNet without --confirm-mainnet, refuses when the
// connected algod is on the wrong network, and pools the inner axfer fee
// through an outer fee of at least MIN_CLAIM_FEE.
//
// Usage: node scripts/claim.mjs <IDENTITY> <CLAIMANT_MNEMONIC_ENV_VAR> [--network testnet|mainnet] [--confirm-mainnet]
// Example: node scripts/claim.mjs ops OPS_CLAIM_MNEMONIC --network testnet
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { algodEndpoint, assertMainnetConfirmed, parseNetworkFlag, usdcAssetId } from './network.mjs'
import { assertNetworkMatchesGenesis } from './rekey-payto.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../proxy/package.json', import.meta.url))
const algosdk = require('algosdk')

/**
 * Loads the root `.env` into `process.env`, without overwriting a variable
 * already set. Called only from the CLI entry path below, never at module
 * import time — an importer (scripts/e2e.mjs and this module's own test
 * file) must never gain a real mnemonic just by importing this file (R3a
 * Result 2: the former top-level load made scripts/verify.sh inherit a
 * real donor key through this module's own import chain).
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
    'Usage: node scripts/claim.mjs <IDENTITY> <CLAIMANT_MNEMONIC_ENV_VAR> ' +
      '[--network testnet|mainnet] [--confirm-mainnet]',
  )
  console.error('Example: node scripts/claim.mjs ops OPS_CLAIM_MNEMONIC --network testnet')
}

// The contract's own floors (contracts/smart_contracts/payment_router/contract.algo.ts:
// MIN_CLAIM, MIN_CLAIM_FEE). Kept as literal copies, not an import — scripts/ never
// depends on contracts/ (mirrors proxy/src/claims/credit.ts's own
// CREDIT_METHOD_SIGNATURE comment). Keep these in sync by hand if the contract changes.
export const MIN_CLAIM = 100_000
export const MIN_CLAIM_FEE = 2_000
export const CLAIM_METHOD_SIGNATURE = 'claim(string)void'

// AVM app-call limit: accounts, assets, apps and boxes together must not
// exceed this many foreign references on one application-call transaction
// (mirrors proxy/src/claims/credit.ts's MAX_TOTAL_REFERENCES).
const MAX_TOTAL_REFERENCES = 8

/**
 * Box key encoding for `identityAddress = BoxMap<string, bytes>({ keyPrefix: 'id:' })`
 * and `balances = BoxMap<string, uint64>({ keyPrefix: 'bal:' })`: the literal utf8
 * bytes of the identity string after the prefix — never ARC-4 length-prefixed
 * (verified against PaymentRouter.approval.teal's claim() branch: `bytec 6 // "id:"`
 * / `bytec 7 // "bal:"` concatenated directly onto the ARC-4-decoded identity bytes).
 */
export function identityBoxName(identity) {
  return new TextEncoder().encode(`id:${identity}`)
}

export function balanceBoxName(identity) {
  return new TextEncoder().encode(`bal:${identity}`)
}

/**
 * Decodes a `balances` box value: an 8-byte big-endian uint64, written by
 * the contract's own `itob`-backed box_put (contract.algo.ts's `balances`
 * BoxMap). Pure: real algosdk, no network access.
 */
export function decodeBoxUint64(bytes, algosdkImpl = algosdk) {
  return Number(algosdkImpl.decodeUint64(bytes, 'safe'))
}

/**
 * Decodes an `identityAddress` box value: the raw 32-byte public key an
 * `Account` writes as `bytes` (contract.algo.ts's `setIdentity`). Pure:
 * real algosdk, no network access.
 */
export function decodeBoxAddress(bytes, algosdkImpl = algosdk) {
  return algosdkImpl.encodeAddress(bytes)
}

/**
 * Refuses a claim below MIN_CLAIM — the same floor claim() itself asserts
 * (contract.algo.ts: "balance below MIN_CLAIM"). Pure: no network access,
 * so claim.test.mjs covers this refusal with no algod call.
 *
 * @param {number} balanceMicro
 * @param {number} [minClaim]
 */
export function assertBalanceAtLeastMinClaim(balanceMicro, minClaim = MIN_CLAIM) {
  if (balanceMicro < minClaim) {
    throw new Error(
      `identity balance ${balanceMicro} microUSDC is below MIN_CLAIM (${minClaim}); claim() ` +
        'would reject this — wait for more batches to credit before claiming',
    )
  }
}

/**
 * Refuses when the claimant's own address is not the identity's mapped
 * address, or when the identity carries no mapping at all — the same
 * checks claim() itself asserts (contract.algo.ts: "unmapped identity",
 * "not the mapped address"). Pure: no network access.
 *
 * @param {string|null} mappedAddress
 * @param {string} signerAddress
 */
export function assertSignerIsMappedAddress(mappedAddress, signerAddress) {
  if (!mappedAddress) {
    throw new Error(
      'identity is not mapped to any address on-chain; an admin must call setIdentity() first',
    )
  }
  if (mappedAddress !== signerAddress) {
    throw new Error(
      `signer address (${signerAddress}) is not the address mapped to this identity ` +
        `(${mappedAddress}); claim() would reject this`,
    )
  }
}

/**
 * The outer app-call fee claim() requires: at least MIN_CLAIM_FEE, since
 * the inner axfer's own fee is 0 and the claimant pools it through the
 * outer fee (contract.algo.ts: "outer fee must pool the inner fee"). Pure:
 * no network access.
 *
 * @param {number} baseFee - the network's own suggested minimum fee.
 * @param {number} [minFee]
 */
export function resolveOuterFee(baseFee, minFee = MIN_CLAIM_FEE) {
  return baseFee >= minFee ? baseFee : minFee
}

/** The exact resource references one claim() call needs. */
export function buildClaimCallRefs(identity, payToAddress, assetId) {
  const boxes = [
    { appIndex: 0, name: identityBoxName(identity) },
    { appIndex: 0, name: balanceBoxName(identity) },
  ]
  const accounts = [payToAddress]
  const assets = [assetId]
  const total = boxes.length + accounts.length + assets.length
  if (total > MAX_TOTAL_REFERENCES) {
    throw new Error(
      `buildClaimCallRefs: needs ${total} foreign references, over the AVM's ` +
        `per-transaction limit of ${MAX_TOTAL_REFERENCES}`,
    )
  }
  return { boxes, accounts, assets }
}

function isBoxNotFound(error) {
  const message = String(error?.message ?? error)
  return /box not found/i.test(message) || error?.status === 404 || error?.statusCode === 404
}

/** Reads `identity`'s credited, unclaimed balance box; 0 when the box does not exist. */
export async function readIdentityBalance(algod, appId, identity) {
  try {
    const box = await algod.getApplicationBoxByName(appId, balanceBoxName(identity)).do()
    return decodeBoxUint64(box.value)
  } catch (error) {
    if (isBoxNotFound(error)) return 0
    throw error
  }
}

/** Reads `identity`'s mapped claimant address; null when unmapped. */
export async function readMappedAddress(algod, appId, identity) {
  try {
    const box = await algod.getApplicationBoxByName(appId, identityBoxName(identity)).do()
    return decodeBoxAddress(box.value)
  } catch (error) {
    if (isBoxNotFound(error)) return null
    throw error
  }
}

/**
 * Submits `claim(identity)`, signed by `account`. Sets the outer fee to at
 * least MIN_CLAIM_FEE (resolveOuterFee) and attaches the resource
 * references claim() needs (buildClaimCallRefs). Returns the confirmed
 * transaction id.
 */
export async function submitClaim(algod, appId, identity, account, payToAddress, assetId) {
  const method = algosdk.ABIMethod.fromSignature(CLAIM_METHOD_SIGNATURE)
  const signer = algosdk.makeBasicAccountTransactionSigner(account)
  const suggestedParams = await algod.getTransactionParams().do()
  suggestedParams.flatFee = true
  suggestedParams.fee = BigInt(resolveOuterFee(Number(suggestedParams.minFee)))

  const refs = buildClaimCallRefs(identity, payToAddress, assetId)
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addMethodCall({
    appID: appId,
    method,
    methodArgs: [identity],
    sender: account.addr,
    suggestedParams,
    signer,
    appAccounts: refs.accounts,
    appForeignAssets: refs.assets,
    boxes: refs.boxes,
  })
  const result = await atc.execute(algod, 4)
  const txid = result.txIDs[0]
  if (!txid) {
    throw new Error('submitClaim: claim() call confirmed with no transaction id')
  }
  return txid
}

async function main() {
  loadRootEnv()

  const argv = process.argv.slice(2)
  const identity = argv[0]
  const envVarName = argv[1]
  if (!identity || !envVarName || identity.startsWith('--') || envVarName.startsWith('--')) {
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

  const appIdRaw = process.env.PAYMENT_ROUTER_APP_ID
  if (!appIdRaw) {
    console.error('PAYMENT_ROUTER_APP_ID not set in .env')
    process.exit(1)
  }
  const payToAddress = process.env.PAY_TO_ADDRESS
  if (!payToAddress) {
    console.error('PAY_TO_ADDRESS not set in .env')
    process.exit(1)
  }
  const appId = BigInt(appIdRaw)

  const usdcAsaId = BigInt(usdcAssetId(network))
  const { server, port, token } = algodEndpoint(network)
  const algod = new algosdk.Algodv2(token, server, port)

  const sp = await algod.getTransactionParams().do()
  assertNetworkMatchesGenesis(network, sp.genesisID ?? '')

  const account = algosdk.mnemonicToSecretKey(mnemonic)
  const signerAddress = account.addr.toString()

  const mappedAddress = await readMappedAddress(algod, appId, identity)
  assertSignerIsMappedAddress(mappedAddress, signerAddress)

  const balance = await readIdentityBalance(algod, appId, identity)
  assertBalanceAtLeastMinClaim(balance)

  console.log(
    `Claiming ${balance} microUSDC for identity "${identity}" (${signerAddress}) on ${network}...`,
  )
  const txid = await submitClaim(algod, appId, identity, account, payToAddress, usdcAsaId)
  await algosdk.waitForConfirmation(algod, txid, 6)
  console.log(`claim() confirmed. txid: ${txid}`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
  })
}
