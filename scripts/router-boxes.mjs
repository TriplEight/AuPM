// PaymentRouter box reads shared by claim.mjs and record-review.mjs. The server image ships
// this file for record-review.mjs (proxy/Dockerfile), so it imports only algosdk.
import { createRequire } from 'node:module'

const require = createRequire(new URL('../proxy/package.json', import.meta.url))
const algosdk = require('algosdk')

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
