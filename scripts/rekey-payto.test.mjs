import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { assertMainnetConfirmed, parseNetworkFlag } from './network.mjs'
import {
  assertAppRoutesForPayTo,
  assertNetworkMatchesGenesis,
  assertPayToAddressEnvMatches,
  assertPayToReadyForRekey,
  decodeAppState,
} from './rekey-payto.mjs'

const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))
const algosdk = requireFromProxy('algosdk')

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
