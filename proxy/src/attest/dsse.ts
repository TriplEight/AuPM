// proxy/src/attest/dsse.ts
//
// DSSE (Dead Simple Signing Envelope) plus in-toto Statement v1, signed
// with the SPM attestation key (see keys.ts).
//
// DSSE signs the exact payload bytes via the Pre-Authentication Encoding
// (PAE), so no JSON canonicalisation is needed.
//
// WARNING: do not sign with algosdk's MX-prefixing byte-signer. It
// prepends the bytes `MX` for domain separation and breaks standard DSSE
// verifiers. Sign the PAE with raw ed25519 (`@noble/ed25519`) using the
// 32-byte seed from the SPM attestation key.

import * as ed from '@noble/ed25519'
import algosdk from 'algosdk'
import type { SigningKey } from './keys.js'

const PAE_PREFIX = 'DSSEv1'
const encoder = new TextEncoder()

/** A DSSE envelope: base64 payload plus one or more ed25519 signatures. */
export interface Envelope {
  payloadType: string
  payload: string
  signatures: { keyid: string; sig: string }[]
}

/** An in-toto Statement v1 subject: a named artifact plus its digest(s). */
export interface StatementSubject {
  name: string
  digest: Record<string, string>
}

/** An in-toto Statement v1. */
export interface Statement {
  _type: 'https://in-toto.io/Statement/v1'
  subject: StatementSubject[]
  predicateType: string
  predicate: Record<string, unknown>
}

/** A key usable to verify an envelope signature. */
export interface VerificationKey {
  keyid: string
  publicKey: Uint8Array | string
}

/** The minimal key shape `signEnvelope` needs: a seed and its keyid. */
export type SigningKeyLike = Pick<SigningKey, 'seed' | 'keyid'>

/**
 * Builds the DSSE Pre-Authentication Encoding:
 * `"DSSEv1" SP len(type) SP type SP len(payload) SP payload`
 * where SP is a single ASCII space and `len()` is the byte length in
 * ASCII decimal. `payload` is the raw Statement bytes, not base64.
 */
export function pae(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(payloadType)
  const parts: Uint8Array[] = [
    encoder.encode(PAE_PREFIX),
    encoder.encode(' '),
    encoder.encode(String(typeBytes.length)),
    encoder.encode(' '),
    typeBytes,
    encoder.encode(' '),
    encoder.encode(String(payload.length)),
    encoder.encode(' '),
    payload,
  ]
  return ed.etc.concatBytes(...parts)
}

/**
 * Signs `payload` under `payloadType` with the SPM attestation key and
 * returns the DSSE envelope. `sig = ed25519_sign(PAE)` using the raw
 * 32-byte seed — never algosdk's MX-prefixing byte-signer.
 */
export async function signEnvelope(
  payload: Uint8Array,
  payloadType: string,
  key: SigningKeyLike,
): Promise<Envelope> {
  const message = pae(payloadType, payload)
  const sig = await ed.signAsync(message, key.seed)
  return {
    payloadType,
    payload: algosdk.bytesToBase64(payload),
    signatures: [{ keyid: key.keyid, sig: algosdk.bytesToBase64(sig) }],
  }
}

/**
 * Verifies a DSSE envelope. Returns true only when at least one signature
 * verifies against a key present in `publicKeys` under that key's keyid.
 */
export async function verifyEnvelope(
  envelope: Envelope,
  publicKeys: VerificationKey[],
): Promise<boolean> {
  const payloadBytes = algosdk.base64ToBytes(envelope.payload)
  const message = pae(envelope.payloadType, payloadBytes)

  for (const signature of envelope.signatures) {
    const key = publicKeys.find((candidate) => candidate.keyid === signature.keyid)
    if (!key) continue
    const publicKeyBytes =
      typeof key.publicKey === 'string' ? algosdk.base64ToBytes(key.publicKey) : key.publicKey
    const sigBytes = algosdk.base64ToBytes(signature.sig)
    const valid = await ed.verifyAsync(sigBytes, message, publicKeyBytes)
    if (valid) return true
  }
  return false
}

/** Builds an in-toto Statement v1 for a package-lock (multi-package) attestation. */
export function buildLockfileStatement(params: {
  subjectName: string
  sha256: string
  predicateType: string
  predicate: Record<string, unknown>
}): Statement {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: params.subjectName, digest: { sha256: params.sha256 } }],
    predicateType: params.predicateType,
    predicate: params.predicate,
  }
}

/** Builds an in-toto Statement v1 for a single-package attestation. */
export function buildSinglePackageStatement(params: {
  packageUrl: string
  sha512: string
  predicateType: string
  predicate: Record<string, unknown>
}): Statement {
  return {
    _type: 'https://in-toto.io/Statement/v1',
    subject: [{ name: params.packageUrl, digest: { sha512: params.sha512 } }],
    predicateType: params.predicateType,
    predicate: params.predicate,
  }
}
