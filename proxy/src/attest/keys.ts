// proxy/src/attest/keys.ts
//
// SPM attestation key management.
//
// The SPM attestation key is a dedicated ed25519 key, generated as an
// Algorand account so its address doubles as a familiar 58-character
// `keyid`. The key is never funded and never used on-chain — it only
// signs DSSE envelopes (see dsse.ts).
//
// WARNING: never log, print, or return the private key or the seed from
// any function in this module except `loadSigningKey`, whose caller is
// trusted to hold key material. `publishedKeys` must never expose seed
// or secret-key bytes.

import * as ed from '@noble/ed25519'
import algosdk from 'algosdk'

/** Either a 25-word Algorand mnemonic, or a raw 32-byte ed25519 seed. */
export type MnemonicOrSeed = string | Uint8Array

/**
 * The SPM attestation signing key, held only on the server.
 * `seed` is the 32-byte ed25519 secret-key seed. Treat it as a secret:
 * never log it, print it, or include it in an HTTP response.
 */
export interface SigningKey {
  seed: Uint8Array
  publicKey: Uint8Array
  keyid: string
}

/** One entry of the `/.well-known/spm-keys.json` published key list. */
export interface PublishedKeyEntry {
  keyid: string
  publicKey: string
  validFrom: string
  validUntil: string | null
}

/** Input record describing a key's publication window. */
export interface PublishedKeyInput {
  keyid: string
  publicKey: Uint8Array
  validFrom: string
  validUntil: string | null
}

/**
 * Derives the 32-byte ed25519 seed and the 58-character Algorand address
 * (used as `keyid`) from a mnemonic or a raw seed.
 *
 * Accepts either a 25-word Algorand mnemonic string, or a 32-byte seed
 * (`Uint8Array`) directly. The seed is the value expected by
 * `signEnvelope` in dsse.ts — do not pass the 64-byte algosdk secret key.
 */
export async function loadSigningKey(mnemonicOrSeed: MnemonicOrSeed): Promise<SigningKey> {
  let seed: Uint8Array
  if (typeof mnemonicOrSeed === 'string') {
    const account = algosdk.mnemonicToSecretKey(mnemonicOrSeed)
    // algosdk's `sk` is the 64-byte tweetnacl-style secret key: the
    // 32-byte seed followed by the 32-byte public key. We only need the
    // seed — raw ed25519 signing derives the public key from it.
    seed = account.sk.slice(0, 32)
  } else {
    seed = mnemonicOrSeed
  }
  if (seed.length !== 32) {
    throw new Error('loadSigningKey: seed must be exactly 32 bytes')
  }
  const publicKey = await ed.getPublicKeyAsync(seed)
  const keyid = algosdk.encodeAddress(publicKey)
  return { seed, publicKey, keyid }
}

/**
 * Formats key records into the `/.well-known/spm-keys.json` array shape.
 * Only public material is accepted as input, so no secret can leak here.
 */
export function publishedKeys(keys: PublishedKeyInput[]): PublishedKeyEntry[] {
  return keys.map((key) => ({
    keyid: key.keyid,
    publicKey: algosdk.bytesToBase64(key.publicKey),
    validFrom: key.validFrom,
    validUntil: key.validUntil,
  }))
}
