import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import {
  algodEndpoint,
  assertMainnetConfirmed,
  caip2NetworkId,
  hasConfirmMainnetFlag,
  indexerEndpoint,
  parseNetworkFlag,
  usdcAssetId,
} from './network.mjs'

const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))
const { ALGORAND_MAINNET_CAIP2, ALGORAND_TESTNET_CAIP2, USDC_MAINNET_ASA_ID, USDC_TESTNET_ASA_ID } =
  requireFromProxy('@x402-avm/avm')

test('parseNetworkFlag defaults to mainnet with no flag and no env', () => {
  assert.equal(parseNetworkFlag([], {}), 'mainnet')
})

test('parseNetworkFlag reads NETWORK from env when no flag is given', () => {
  assert.equal(parseNetworkFlag([], { NETWORK: 'testnet' }), 'testnet')
})

test('parseNetworkFlag prefers an explicit --network flag over env', () => {
  assert.equal(parseNetworkFlag(['--network', 'testnet'], { NETWORK: 'mainnet' }), 'testnet')
})

test('parseNetworkFlag throws on an invalid --network value', () => {
  assert.throws(() => parseNetworkFlag(['--network', 'devnet'], {}), /--network must be one of/)
})

test('parseNetworkFlag throws on a missing --network value', () => {
  assert.throws(() => parseNetworkFlag(['--network'], {}), /--network must be one of/)
})

test('parseNetworkFlag throws on an invalid NETWORK env value', () => {
  assert.throws(() => parseNetworkFlag([], { NETWORK: 'devnet' }), /NETWORK must be one of/)
})

test('usdcAssetId selects the asset id per network', () => {
  assert.equal(usdcAssetId('mainnet'), USDC_MAINNET_ASA_ID)
  assert.equal(usdcAssetId('testnet'), USDC_TESTNET_ASA_ID)
})

test('caip2NetworkId selects the CAIP-2 id per network', () => {
  assert.equal(caip2NetworkId('mainnet'), ALGORAND_MAINNET_CAIP2)
  assert.equal(caip2NetworkId('testnet'), ALGORAND_TESTNET_CAIP2)
})

test('algodEndpoint defaults to the per-network algonode.cloud host', () => {
  assert.deepEqual(algodEndpoint('mainnet', {}), {
    server: 'https://mainnet-api.algonode.cloud',
    port: 443,
    token: '',
  })
  assert.deepEqual(algodEndpoint('testnet', {}), {
    server: 'https://testnet-api.algonode.cloud',
    port: 443,
    token: '',
  })
})

test('algodEndpoint lets ALGOD_SERVER/ALGOD_PORT/ALGOD_TOKEN override the default', () => {
  const env = { ALGOD_SERVER: 'https://custom.example', ALGOD_PORT: '1234', ALGOD_TOKEN: 'tok' }
  assert.deepEqual(algodEndpoint('mainnet', env), {
    server: 'https://custom.example',
    port: 1234,
    token: 'tok',
  })
})

test('indexerEndpoint defaults to the per-network algonode.cloud indexer host', () => {
  assert.deepEqual(indexerEndpoint('mainnet', {}), {
    server: 'https://mainnet-idx.algonode.cloud',
    port: 443,
    token: '',
  })
  assert.deepEqual(indexerEndpoint('testnet', {}), {
    server: 'https://testnet-idx.algonode.cloud',
    port: 443,
    token: '',
  })
})

test('indexerEndpoint lets INDEXER_URL/INDEXER_PORT/INDEXER_TOKEN override the default', () => {
  const env = {
    INDEXER_URL: 'https://custom-idx.example',
    INDEXER_PORT: '1234',
    INDEXER_TOKEN: 'tok',
  }
  assert.deepEqual(indexerEndpoint('mainnet', env), {
    server: 'https://custom-idx.example',
    port: 1234,
    token: 'tok',
  })
})

test('indexerEndpoint never falls back to ALGOD_* overrides', () => {
  const env = { ALGOD_SERVER: 'https://mainnet-api.algonode.cloud', ALGOD_TOKEN: 'algod-tok' }
  assert.deepEqual(indexerEndpoint('mainnet', env), {
    server: 'https://mainnet-idx.algonode.cloud',
    port: 443,
    token: '',
  })
})

test('hasConfirmMainnetFlag reads --confirm-mainnet from argv', () => {
  assert.equal(hasConfirmMainnetFlag([]), false)
  assert.equal(hasConfirmMainnetFlag(['--confirm-mainnet']), true)
})

test('assertMainnetConfirmed refuses MainNet without --confirm-mainnet', () => {
  assert.throws(() => assertMainnetConfirmed('mainnet', []), /--confirm-mainnet/)
})

test('assertMainnetConfirmed allows MainNet with --confirm-mainnet', () => {
  assert.doesNotThrow(() => assertMainnetConfirmed('mainnet', ['--confirm-mainnet']))
})

test('assertMainnetConfirmed is a no-op on TestNet, flag or not', () => {
  assert.doesNotThrow(() => assertMainnetConfirmed('testnet', []))
  assert.doesNotThrow(() => assertMainnetConfirmed('testnet', ['--confirm-mainnet']))
})
