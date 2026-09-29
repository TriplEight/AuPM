import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importWithoutEnvMutation } from './assert-no-env-import.mjs'
import { assertMainnetConfirmed, parseNetworkFlag } from './network.mjs'
import {
  assertAppIsAuditedBuild,
  assertAppRoutesForPayTo,
  assertNetworkMatchesGenesis,
  assertPayToAddressEnvMatches,
  assertPayToReadyForRekey,
  decodeAppState,
  deriveAdminMultisigAddress,
  loadBuiltPrograms,
} from './rekey-payto.mjs'

const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))
const algosdk = requireFromProxy('algosdk')

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const rekeyPayToModuleHref = pathToFileURL(path.join(scriptsDir, 'rekey-payto.mjs')).href

// R3a Result 2: the module must never read the root .env just because a
// caller imports it — only main() (the CLI entry path) may. A regression
// here would make scripts/verify.sh inherit a real donor key through this
// module's own import chain (claim.mjs -> rekey-payto.mjs). Checked in a
// child process that never opens the real root .env (assert-no-env-import.mjs) —
// the main tree's .env holds real TestNet keys, and this test runs on
// every push.
test('importing rekey-payto.mjs never touches .env and never mutates process.env', () => {
  const report = importWithoutEnvMutation(rekeyPayToModuleHref)
  assert.deepEqual(report.envPaths, [])
  assert.equal(report.envKeysChanged, false)
})

const PAYTO = 'PAYTO_ADDR'
const APP_ADDR = 'APP_ADDR'

test('assertPayToReadyForRekey refuses when payTo is not opted into USDC', () => {
  assert.throws(
    () => assertPayToReadyForRekey({ holdsAsset: false, authAddr: undefined, payToAddress: PAYTO }),
    /not opted into USDC/,
  )
})

test('assertPayToReadyForRekey refuses when payTo is already rekeyed', () => {
  assert.throws(
    () => assertPayToReadyForRekey({ holdsAsset: true, authAddr: APP_ADDR, payToAddress: PAYTO }),
    /already rekeyed/,
  )
})

test('assertPayToReadyForRekey proceeds with a zero USDC balance once opted in', () => {
  // SPEC §10.2 requires only the opt-in before the rekey, not a balance.
  assert.doesNotThrow(() =>
    assertPayToReadyForRekey({ holdsAsset: true, authAddr: undefined, payToAddress: PAYTO }),
  )
})

test('assertPayToReadyForRekey proceeds with a non-zero USDC balance once opted in', () => {
  assert.doesNotThrow(() =>
    assertPayToReadyForRekey({ holdsAsset: true, authAddr: undefined, payToAddress: PAYTO }),
  )
})

test('assertPayToReadyForRekey treats an auth-addr equal to payTo itself as not rekeyed', () => {
  assert.doesNotThrow(() =>
    assertPayToReadyForRekey({ holdsAsset: true, authAddr: PAYTO, payToAddress: PAYTO }),
  )
})

test('assertPayToAddressEnvMatches refuses when PAY_TO_ADDRESS differs from the mnemonic', () => {
  assert.throws(
    () => assertPayToAddressEnvMatches('OTHER_ADDR', PAYTO),
    /PAY_TO_ADDRESS.*does not match/,
  )
})

test('assertPayToAddressEnvMatches passes when PAY_TO_ADDRESS matches the mnemonic', () => {
  assert.doesNotThrow(() => assertPayToAddressEnvMatches(PAYTO, PAYTO))
})

test('assertPayToAddressEnvMatches passes when PAY_TO_ADDRESS is unset', () => {
  assert.doesNotThrow(() => assertPayToAddressEnvMatches(undefined, PAYTO))
})

test('assertAppRoutesForPayTo refuses when the app routes for a different payTo', () => {
  assert.throws(
    () =>
      assertAppRoutesForPayTo({
        appPayTo: 'OTHER_ADDR',
        payToAddress: PAYTO,
        appAssetId: 31566704,
        expectedAssetId: 31566704,
      }),
    /does not equal payTo/,
  )
})

test('assertAppRoutesForPayTo refuses when the app was created with a different USDC asset id', () => {
  assert.throws(
    () =>
      assertAppRoutesForPayTo({
        appPayTo: PAYTO,
        payToAddress: PAYTO,
        appAssetId: 10458941,
        expectedAssetId: 31566704,
      }),
    /USDC asset id/,
  )
})

test('assertAppRoutesForPayTo passes when payTo and the asset id both match', () => {
  assert.doesNotThrow(() =>
    assertAppRoutesForPayTo({
      appPayTo: PAYTO,
      payToAddress: PAYTO,
      appAssetId: 31566704,
      expectedAssetId: 31566704,
    }),
  )
})

test('assertNetworkMatchesGenesis refuses a MainNet run against a TestNet algod', () => {
  assert.throws(
    () => assertNetworkMatchesGenesis('mainnet', 'testnet-v1.0'),
    /does not match NETWORK=mainnet/,
  )
})

test('assertNetworkMatchesGenesis refuses a TestNet run against a MainNet algod', () => {
  assert.throws(
    () => assertNetworkMatchesGenesis('testnet', 'mainnet-v1.0'),
    /does not match NETWORK=testnet/,
  )
})

test('assertNetworkMatchesGenesis passes when the genesis id matches the network', () => {
  assert.doesNotThrow(() => assertNetworkMatchesGenesis('mainnet', 'mainnet-v1.0'))
  assert.doesNotThrow(() => assertNetworkMatchesGenesis('testnet', 'testnet-v1.0'))
})

test('decodeAppState decodes the app payTo address and USDC asset id', () => {
  const account = algosdk.generateAccount()
  const payToBytes = algosdk.decodeAddress(account.addr.toString()).publicKey
  const appInfo = {
    params: {
      globalState: [
        { key: Buffer.from('pto'), value: { type: 1, bytes: payToBytes, uint: 0n } },
        { key: Buffer.from('ast'), value: { type: 2, bytes: new Uint8Array(), uint: 31566704n } },
      ],
    },
  }
  assert.deepEqual(decodeAppState(appInfo, algosdk), {
    payTo: account.addr.toString(),
    assetId: 31566704,
  })
})

test('decodeAppState returns undefined fields when global state is empty', () => {
  assert.deepEqual(decodeAppState({ params: { globalState: [] } }, algosdk), {
    payTo: undefined,
    assetId: undefined,
  })
})

// rekey-payto.mjs's main() runs this exact sequence (parseNetworkFlag then
// assertMainnetConfirmed) before it reads any mnemonic or touches algod, so
// this covers the MainNet guard for the rekey step directly.
test('a MainNet run refuses without --confirm-mainnet', () => {
  const argv = ['PAY_TO_MNEMONIC', '--network', 'mainnet']
  const network = parseNetworkFlag(argv)
  assert.throws(() => assertMainnetConfirmed(network, argv), /--confirm-mainnet/)
})

test('a MainNet run proceeds past the guard with --confirm-mainnet', () => {
  const argv = ['PAY_TO_MNEMONIC', '--network', 'mainnet', '--confirm-mainnet']
  const network = parseNetworkFlag(argv)
  assert.doesNotThrow(() => assertMainnetConfirmed(network, argv))
})

// H2 (pre-MainNet audit): assertAppRoutesForPayTo checks only global state,
// which any app can copy. The rekey must also refuse an app whose code or
// creator is not the audited build.
const built = loadBuiltPrograms()
const admin = algosdk.generateAccount().addr.toString()
const auditedApp = () => ({
  approvalProgram: new Uint8Array(built.approval),
  clearStateProgram: new Uint8Array(built.clear),
  extraProgramPages: undefined,
  creator: admin,
})
const expected = { approval: built.approval, clear: built.clear, creator: admin }

test('loadBuiltPrograms reads non-empty approval and clear bytes from the ARC-56 artifact', () => {
  assert.ok(built.approval.length > 0)
  assert.ok(built.clear.length > 0)
})

test('assertAppIsAuditedBuild passes for the audited programs and the expected creator', () => {
  assert.doesNotThrow(() => assertAppIsAuditedBuild(auditedApp(), expected))
})

test('assertAppIsAuditedBuild refuses an approval program that differs by one byte', () => {
  const app = auditedApp()
  app.approvalProgram[app.approvalProgram.length - 1] ^= 0x01
  assert.throws(() => assertAppIsAuditedBuild(app, expected), /approval program/)
})

test('assertAppIsAuditedBuild refuses an approval program with extra trailing bytes', () => {
  const app = auditedApp()
  app.approvalProgram = new Uint8Array([...built.approval, 0x00])
  assert.throws(() => assertAppIsAuditedBuild(app, expected), /approval program/)
})

test('assertAppIsAuditedBuild refuses a different clear program', () => {
  const app = auditedApp()
  app.clearStateProgram = new Uint8Array([0x0b, 0x81, 0x00, 0x43])
  assert.throws(() => assertAppIsAuditedBuild(app, expected), /clear program/)
})

test('assertAppIsAuditedBuild refuses an app with extra program pages', () => {
  const app = auditedApp()
  app.extraProgramPages = 1
  assert.throws(() => assertAppIsAuditedBuild(app, expected), /extra program page/)
})

test('assertAppIsAuditedBuild refuses an app created by another key', () => {
  const app = auditedApp()
  app.creator = algosdk.generateAccount().addr.toString()
  assert.throws(() => assertAppIsAuditedBuild(app, expected), /creator/)
})

test('loadBuiltPrograms refuses an ARC-56 file with no byteCode', async () => {
  const fs = await import('node:fs')
  const os = await import('node:os')
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'arc56-'))
  const file = path.join(dir, 'PaymentRouter.arc56.json')
  fs.writeFileSync(file, JSON.stringify({ name: 'PaymentRouter' }))
  assert.throws(() => loadBuiltPrograms(file), /no byteCode/)
})

test('deriveAdminMultisigAddress equals algosdk.multisigAddress for version 1, threshold 2', () => {
  const addrs = [0, 1, 2].map(() => algosdk.generateAccount().addr.toString())
  const want = algosdk.multisigAddress({ version: 1, threshold: 2, addrs }).toString()
  assert.equal(deriveAdminMultisigAddress(` ${addrs.join(' , ')} `, algosdk), want)
})

test('deriveAdminMultisigAddress refuses an unset value', () => {
  assert.throws(() => deriveAdminMultisigAddress(undefined, algosdk), /exactly 3 addresses, got 0/)
})

test('deriveAdminMultisigAddress refuses two addresses', () => {
  const addrs = [0, 1].map(() => algosdk.generateAccount().addr.toString())
  assert.throws(() => deriveAdminMultisigAddress(addrs.join(','), algosdk), /got 2/)
})

test('deriveAdminMultisigAddress refuses an invalid address', () => {
  const addrs = [0, 1].map(() => algosdk.generateAccount().addr.toString())
  assert.throws(
    () => deriveAdminMultisigAddress([...addrs, 'NOTANADDRESS'].join(','), algosdk),
    /invalid Algorand address/,
  )
})

test('deriveAdminMultisigAddress refuses a repeated address', () => {
  const a = algosdk.generateAccount().addr.toString()
  const b = algosdk.generateAccount().addr.toString()
  assert.throws(() => deriveAdminMultisigAddress([a, b, a].join(','), algosdk), /distinct/)
})
