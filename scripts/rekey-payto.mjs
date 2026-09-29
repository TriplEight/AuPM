#!/usr/bin/env node
// Rekeys payTo to the PaymentRouter app address (R2, SPEC §10.2). This is
// the payTo key's second and last signing action: after this call the key
// has no signing power over payTo. Order is not reversible — payTo must
// already be opted into USDC (scripts/optin-usdc.mjs) before this runs. On
// MainNet, refuses without --confirm-mainnet (scripts/network.mjs) and
// refuses unless the connected algod's genesis id matches NETWORK. Refuses
// unless the app's approval and clear programs equal the committed
// PaymentRouter.arc56.json byteCode and its creator equals the 2-of-3 admin
// multisig derived from AUPM_ADMIN_MSIG_ADDRS.
//
// Usage: node scripts/rekey-payto.mjs <PAY_TO_MNEMONIC_ENV_VAR> [--network testnet|mainnet] [--confirm-mainnet]
// Example: node scripts/rekey-payto.mjs PAY_TO_MNEMONIC --network testnet
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
 * import time — an importer (claim.mjs, scripts/e2e.mjs, and this module's
 * own test file) must never gain a real mnemonic just by importing this
 * file (R3a Result 2: the former top-level load made scripts/verify.sh
 * inherit a real donor key through this module's own import chain).
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

// algod genesis id per network. A MainNet-looking run against a TestNet
// algod (or vice versa) must refuse rather than rekey against the wrong
// chain — see assertNetworkMatchesGenesis.
const GENESIS_ID = { mainnet: 'mainnet-v1.0', testnet: 'testnet-v1.0' }

function printUsage() {
  console.error(
    'Usage: node scripts/rekey-payto.mjs <PAY_TO_MNEMONIC_ENV_VAR> ' +
      '[--network testnet|mainnet] [--confirm-mainnet]',
  )
  console.error('Example: node scripts/rekey-payto.mjs PAY_TO_MNEMONIC --network testnet')
}

/**
 * Refuses to rekey payTo when it is not ready. Pure: no network access, so
 * scripts/rekey-payto.test.mjs covers every refusal with no algod call.
 *
 * Order matches SPEC §10.2: opt-in before rekey, and a rekey is one-shot
 * (a rekeyed payTo cannot sign a second rekey with its own key). SPEC §10.2
 * does not require a USDC balance before the rekey, only the opt-in, so
 * this checks the opt-in and the auth-addr only.
 *
 * @param {object} state
 * @param {boolean} state.holdsAsset - whether payTo's account holds the USDC asset (opted in).
 * @param {string|undefined} state.authAddr - payTo's current auth-addr, if any.
 * @param {string} state.payToAddress - payTo's own address.
 */
export function assertPayToReadyForRekey({ holdsAsset, authAddr, payToAddress }) {
  if (authAddr && authAddr !== payToAddress) {
    throw new Error(
      `payTo is already rekeyed (auth-addr ${authAddr}); refusing a second rekey ` +
        '(SPEC §10.2: after the rekey the key has no signing power)',
    )
  }
  if (!holdsAsset) {
    throw new Error(
      'payTo is not opted into USDC; opt in first with scripts/optin-usdc.mjs ' +
        '(order is not reversible, SPEC §10.2)',
    )
  }
}

/**
 * Refuses when PAY_TO_ADDRESS is set and differs from the mnemonic's own
 * address — running the rekey with the wrong key would strand the address
 * the rest of the system already points at. Pure: no network access.
 *
 * @param {string|undefined} envPayToAddress - the configured PAY_TO_ADDRESS, if any.
 * @param {string} payToAddress - the address derived from the mnemonic.
 */
export function assertPayToAddressEnvMatches(envPayToAddress, payToAddress) {
  if (envPayToAddress && envPayToAddress !== payToAddress) {
    throw new Error(
      `PAY_TO_ADDRESS (${envPayToAddress}) does not match the mnemonic's address ` +
        `(${payToAddress}); refusing to rekey the wrong account`,
    )
  }
}

/**
 * Refuses to rekey to an app that does not route for this exact payTo and
 * this network's USDC asset. Rekeying to an app configured for a different
 * payTo or asset strands the funds — see contract.algo.ts's createApplication
 * (payTo and assetId are fixed at creation and never change). Pure: no
 * network access.
 *
 * @param {object} state
 * @param {string|undefined} state.appPayTo - the app's stored payTo address.
 * @param {string} state.payToAddress - the address derived from the mnemonic.
 * @param {number|undefined} state.appAssetId - the app's stored USDC asset id.
 * @param {number} state.expectedAssetId - the USDC asset id for this network.
 */
export function assertAppRoutesForPayTo({ appPayTo, payToAddress, appAssetId, expectedAssetId }) {
  if (appPayTo !== payToAddress) {
    throw new Error(
      `the app's stored payTo (${appPayTo}) does not equal payTo (${payToAddress}); ` +
        'refusing to rekey to an app that routes for a different payTo',
    )
  }
  if (appAssetId !== expectedAssetId) {
    throw new Error(
      `the app's stored USDC asset id (${appAssetId}) does not equal the expected id ` +
        `for this network (${expectedAssetId})`,
    )
  }
}

const ARC56_PATH = path.join(
  __dirname,
  '..',
  'contracts',
  'smart_contracts',
  'artifacts',
  'payment_router',
  'PaymentRouter.arc56.json',
)

/**
 * Reads the approval and clear program bytes that `algokit project run build`
 * wrote into PaymentRouter.arc56.json. These are the audited programs; the
 * MainNet createApplication call (deploy-config.ts) sends these exact bytes.
 *
 * @param {string} [arc56Path] - path to the ARC-56 spec; defaults to the committed artifact.
 * @returns {{approval: Uint8Array, clear: Uint8Array}}
 */
export function loadBuiltPrograms(arc56Path = ARC56_PATH) {
  const spec = JSON.parse(fs.readFileSync(arc56Path, 'utf8'))
  if (!spec.byteCode?.approval || !spec.byteCode?.clear) {
    throw new Error(`${arc56Path} has no byteCode; run \`algokit project run build\` first`)
  }
  return {
    approval: new Uint8Array(Buffer.from(spec.byteCode.approval, 'base64')),
    clear: new Uint8Array(Buffer.from(spec.byteCode.clear, 'base64')),
  }
}

/**
 * Derives the 2-of-3 admin multisig address from AUPM_ADMIN_MSIG_ADDRS
 * ("addr1,addr2,addr3"). Same derivation as deploy-config.ts
 * (parseAdminMultisigAddrs + deriveAdminMultisigAddress): version 1,
 * threshold 2, addresses in the given order.
 *
 * @param {string|undefined} addrsEnv - the raw AUPM_ADMIN_MSIG_ADDRS value.
 * @param {typeof import('algosdk')} algosdkImpl
 * @returns {string} the multisig address, which is Global.creatorAddress of the app.
 */
export function deriveAdminMultisigAddress(addrsEnv, algosdkImpl) {
  const addrs = (addrsEnv ?? '')
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  if (addrs.length !== 3) {
    throw new Error(
      `AUPM_ADMIN_MSIG_ADDRS must list exactly 3 addresses, got ${addrs.length} ` +
        '(ADR 0010: the app creator is a 2-of-3 multisig)',
    )
  }
  for (const addr of addrs) {
    if (!algosdkImpl.isValidAddress(addr)) {
      throw new Error(`AUPM_ADMIN_MSIG_ADDRS contains an invalid Algorand address: ${addr}`)
    }
  }
  if (new Set(addrs).size !== addrs.length) {
    throw new Error('AUPM_ADMIN_MSIG_ADDRS addresses must be distinct')
  }
  return algosdkImpl.multisigAddress({ version: 1, threshold: 2, addrs }).toString()
}

function bytesEqual(a, b) {
  return a.length === b.length && a.every((v, i) => v === b[i])
}

/**
 * Refuses to rekey to an app whose code or creator is not the audited build.
 * The rekey is not reversible by the payTo key, and assertAppRoutesForPayTo
 * checks only global state, which any app can copy. Pure: no network access.
 *
 * @param {object} app - the on-chain app, from algod getApplicationByID().params.
 * @param {Uint8Array} app.approvalProgram
 * @param {Uint8Array} app.clearStateProgram
 * @param {number|undefined} app.extraProgramPages
 * @param {string} app.creator - the creator address, as a string.
 * @param {object} expected
 * @param {Uint8Array} expected.approval - approval bytes from loadBuiltPrograms().
 * @param {Uint8Array} expected.clear - clear bytes from loadBuiltPrograms().
 * @param {string} expected.creator - the admin address (the multisig on MainNet).
 */
export function assertAppIsAuditedBuild(app, expected) {
  if (!bytesEqual(app.approvalProgram, expected.approval)) {
    throw new Error(
      "the app's approval program does not equal PaymentRouter.arc56.json byteCode.approval; " +
        'refusing to rekey payTo to code that is not the audited build',
    )
  }
  if (!bytesEqual(app.clearStateProgram, expected.clear)) {
    throw new Error(
      "the app's clear program does not equal PaymentRouter.arc56.json byteCode.clear; " +
        'refusing to rekey payTo to code that is not the audited build',
    )
  }
  if ((app.extraProgramPages ?? 0) !== 0) {
    throw new Error(
      `the app has ${app.extraProgramPages} extra program page(s); the audited build has 0`,
    )
  }
  if (app.creator !== expected.creator) {
    throw new Error(
      `the app's creator (${app.creator}) does not equal the expected admin ` +
        `(${expected.creator}); refusing to rekey payTo to an app another key administers`,
    )
  }
}

/**
 * Refuses when the connected algod's genesis id does not match the
 * selected network. AlgorandClient/algod is picked by ALGOD_SERVER, which
 * is independent of NETWORK — an operator could point NETWORK=testnet at a
 * MainNet algod (or the reverse) and silently act on the wrong chain. Pure:
 * no network access (the genesis id itself is read over the network by the
 * caller; this only compares the two strings).
 *
 * @param {'mainnet'|'testnet'} network
 * @param {string} genesisId - the connected algod's genesis id.
 */
export function assertNetworkMatchesGenesis(network, genesisId) {
  const expected = GENESIS_ID[network]
  if (genesisId !== expected) {
    throw new Error(
      `algod genesis id "${genesisId}" does not match NETWORK=${network} ` +
        `(expected "${expected}"); ALGOD_SERVER may be pointed at the wrong network`,
    )
  }
}

/**
 * Decodes PaymentRouter's payTo and assetId global state into an
 * {payTo, assetId} pair. algosdkImpl.encodeAddress is deterministic and
 * network-free, so this is exercised directly in tests with a real algosdk
 * and a fabricated app-info object — no algod call.
 *
 * @param {{params?: {globalState?: {key: Uint8Array, value: {type: number, bytes: Uint8Array, uint: bigint}}[]}}} appInfo
 * @param {{encodeAddress(bytes: Uint8Array): string}} algosdkImpl
 * @returns {{payTo: string|undefined, assetId: number|undefined}}
 */
export function decodeAppState(appInfo, algosdkImpl) {
  const entries = appInfo?.params?.globalState ?? []
  const byKey = new Map(entries.map((kv) => [Buffer.from(kv.key).toString(), kv.value]))
  const pto = byKey.get('pto')
  const ast = byKey.get('ast')
  return {
    payTo: pto ? algosdkImpl.encodeAddress(new Uint8Array(pto.bytes)) : undefined,
    assetId: ast !== undefined ? Number(ast.uint) : undefined,
  }
}

/**
 * Rekeys `payToAccount` to PaymentRouter app `appId`'s address: checks
 * payTo's current opt-in/auth-addr state and the app's own stored
 * payTo/asset (assertPayToReadyForRekey, assertAppRoutesForPayTo), the
 * app's program bytes and creator (assertAppIsAuditedBuild), then signs
 * and sends the rekey payment, and returns the confirmed transaction id.
 * Explicit-argument core of `main()` below, so a TestNet rehearsal script
 * can rekey a fresh, in-memory payTo without this module's own CLI/.env
 * plumbing (R3a).
 *
 * @param {object} params
 * @param {import('algosdk').Algodv2} params.algod
 * @param {'testnet'|'mainnet'} params.network
 * @param {{addr: {toString(): string}, sk: Uint8Array}} params.payToAccount
 * @param {bigint|number} params.appId
 * @param {string} params.expectedCreator - the app's admin: the 2-of-3 multisig on the CLI
 *   path, the single deployer key in the TestNet rehearsal.
 * @returns {Promise<string>} the confirmed rekey transaction id.
 */
export async function rekeyPayToToApp({ algod, network, payToAccount, appId, expectedCreator }) {
  const usdcAsaId = Number(usdcAssetId(network))
  const payToAddress = payToAccount.addr.toString()

  const acctInfo = await algod.accountInformation(payToAddress).do()
  const assetEntry = (acctInfo.assets ?? []).find((a) => Number(a.assetId) === usdcAsaId)
  const authAddr = acctInfo.authAddr ? acctInfo.authAddr.toString() : undefined
  assertPayToReadyForRekey({ holdsAsset: Boolean(assetEntry), authAddr, payToAddress })

  const appInfo = await algod.getApplicationByID(BigInt(appId)).do()
  const appState = decodeAppState(appInfo, algosdk)
  assertAppRoutesForPayTo({
    appPayTo: appState.payTo,
    payToAddress,
    appAssetId: appState.assetId,
    expectedAssetId: usdcAsaId,
  })
  const built = loadBuiltPrograms()
  assertAppIsAuditedBuild(
    {
      approvalProgram: appInfo.params.approvalProgram,
      clearStateProgram: appInfo.params.clearStateProgram,
      extraProgramPages: appInfo.params.extraProgramPages,
      creator: appInfo.params.creator.toString(),
    },
    { approval: built.approval, clear: built.clear, creator: expectedCreator },
  )

  const appAddress = algosdk.getApplicationAddress(BigInt(appId)).toString()
  const sp = await algod.getTransactionParams().do()
  const rekeyTxn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: payToAddress,
    receiver: payToAddress,
    amount: 0,
    rekeyTo: appAddress,
    suggestedParams: sp,
  })
  const signedTxn = rekeyTxn.signTxn(payToAccount.sk)
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

  const appId = process.env.PAYMENT_ROUTER_APP_ID
  if (!appId) {
    console.error('PAYMENT_ROUTER_APP_ID not set in .env')
    process.exit(1)
  }

  const { server, port, token } = algodEndpoint(network)
  const algod = new algosdk.Algodv2(token, server, port)

  const sp = await algod.getTransactionParams().do()
  assertNetworkMatchesGenesis(network, sp.genesisID ?? '')

  const account = algosdk.mnemonicToSecretKey(mnemonic)
  const payToAddress = account.addr.toString()
  assertPayToAddressEnvMatches(process.env.PAY_TO_ADDRESS, payToAddress)

  const expectedCreator = deriveAdminMultisigAddress(process.env.AUPM_ADMIN_MSIG_ADDRS, algosdk)

  const appAddress = algosdk.getApplicationAddress(BigInt(appId)).toString()
  console.log(
    `Rekeying payTo (${payToAddress}) to PaymentRouter app ${appId} (${appAddress}) on ${network}...`,
  )
  const txid = await rekeyPayToToApp({
    algod,
    network,
    payToAccount: account,
    appId,
    expectedCreator,
  })
  console.log(`payTo rekeyed to PaymentRouter. txid: ${txid}`)
  console.log('The payTo key has no signing power from here on (SPEC §10.2).')
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
  })
}
