import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { test } from 'node:test'
import { checkRequirements, resolveExpectedFeePayer } from './check-402.mjs'

const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))
const { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } = requireFromProxy('@x402-avm/avm')

const TESTNET_USDC_ASA_ID = '10458941'
const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAJ2EU'

function goodAccept(overrides = {}) {
  return {
    scheme: 'exact',
    network: ALGORAND_MAINNET_CAIP2,
    extra: { asset: USDC_MAINNET_ASA_ID, feePayer: FEE_PAYER, tag: 'x402-global-challenge' },
    ...overrides,
  }
}

function decodedWith(accept) {
  return { accepts: accept === undefined ? [] : [accept] }
}

function allOk(results) {
  return results.every((r) => r.ok)
}

function fieldOf(results, name) {
  return results.find((r) => r.field === name)
}

test('all fields pass for a correctly configured MainNet accept', () => {
  const results = checkRequirements(decodedWith(goodAccept()), FEE_PAYER)
  assert.equal(allOk(results), true)
  assert.equal(results.length, 4)
})

test('wrong tag fails only extra.tag', () => {
  const accept = goodAccept({
    extra: { asset: USDC_MAINNET_ASA_ID, feePayer: FEE_PAYER, tag: 'direct' },
  })
  const results = checkRequirements(decodedWith(accept), FEE_PAYER)
  assert.equal(fieldOf(results, 'extra.tag').ok, false)
  assert.equal(fieldOf(results, 'extra.asset').ok, true)
  assert.equal(fieldOf(results, 'network').ok, true)
  assert.equal(fieldOf(results, 'extra.feePayer').ok, true)
})

test('missing (omitted) asset fails extra.asset', () => {
  const accept = goodAccept({ extra: { feePayer: FEE_PAYER, tag: 'x402-global-challenge' } })
  const results = checkRequirements(decodedWith(accept), FEE_PAYER)
  const assetField = fieldOf(results, 'extra.asset')
  assert.equal(assetField.ok, false)
  assert.equal(assetField.actual, undefined)
})

test('TestNet USDC asset id fails extra.asset on a MainNet check', () => {
  const accept = goodAccept({
    extra: { asset: TESTNET_USDC_ASA_ID, feePayer: FEE_PAYER, tag: 'x402-global-challenge' },
  })
  const results = checkRequirements(decodedWith(accept), FEE_PAYER)
  assert.equal(fieldOf(results, 'extra.asset').ok, false)
})

test('wrong network fails the network field', () => {
  const accept = goodAccept({ network: 'algorand:wrongnetworkhash' })
  const results = checkRequirements(decodedWith(accept), FEE_PAYER)
  assert.equal(fieldOf(results, 'network').ok, false)
})

test('feePayer mismatch fails extra.feePayer only', () => {
  const results = checkRequirements(decodedWith(goodAccept()), 'SOMEOTHERFEEPAYER')
  assert.equal(fieldOf(results, 'extra.feePayer').ok, false)
  assert.equal(fieldOf(results, 'extra.tag').ok, true)
})

test('empty accepts fails every field', () => {
  const results = checkRequirements(decodedWith(undefined), FEE_PAYER)
  assert.equal(allOk(results), false)
  assert.equal(results.length, 4)
  for (const r of results) assert.equal(r.actual, undefined)
})

test('resolveExpectedFeePayer reads extra.feePayer for the matching network+scheme', () => {
  const supported = {
    kinds: [
      { network: 'other-network', scheme: 'exact', extra: { feePayer: 'WRONG' } },
      { network: ALGORAND_MAINNET_CAIP2, scheme: 'exact', extra: { feePayer: FEE_PAYER } },
    ],
  }
  assert.equal(resolveExpectedFeePayer(supported, ALGORAND_MAINNET_CAIP2), FEE_PAYER)
})

test('resolveExpectedFeePayer throws when no matching kind advertises one', () => {
  const supported = { kinds: [{ network: ALGORAND_MAINNET_CAIP2, scheme: 'upto', extra: {} }] }
  assert.throws(
    () => resolveExpectedFeePayer(supported, ALGORAND_MAINNET_CAIP2),
    /does not advertise/,
  )
})
