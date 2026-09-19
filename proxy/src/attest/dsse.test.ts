// proxy/src/attest/dsse.test.ts
import algosdk from 'algosdk'
import { describe, expect, test } from 'vitest'
import { pae, signEnvelope, verifyEnvelope, type Envelope } from './dsse.js'
import { loadSigningKey } from './keys.js'

describe('pae', () => {
  test('matches a hand-computed expected byte string for a known short input', () => {
    // payloadType = "app" (3 bytes), payload = [1, 2, 3] (3 bytes).
    // Expected: "DSSEv1" SP "3" SP "app" SP "3" SP <payload bytes>
    // ASCII: D S S E v 1 _ 3 _ a  p   p   _  3  _  1 2 3
    const expected = Uint8Array.from([
      68, 83, 83, 69, 118, 49, // "DSSEv1"
      32, // SP
      51, // "3" (len("app"))
      32, // SP
      97, 112, 112, // "app"
      32, // SP
      51, // "3" (len(payload))
      32, // SP
      1, 2, 3, // payload bytes
    ])

    const actual = pae('app', new Uint8Array([1, 2, 3]))

    expect(Array.from(actual)).toEqual(Array.from(expected))
  })
})

describe('signEnvelope / verifyEnvelope', () => {
  test('a signature verifies with the correct public key', async () => {
    const key = await loadSigningKey(crypto.getRandomValues(new Uint8Array(32)))
    const payload = new TextEncoder().encode('{"hello":"world"}')

    const envelope = await signEnvelope(payload, 'application/vnd.in-toto+json', key)
    const ok = await verifyEnvelope(envelope, [{ keyid: key.keyid, publicKey: key.publicKey }])

    expect(ok).toBe(true)
  })

  test('a signature fails when one payload byte changes', async () => {
    const key = await loadSigningKey(crypto.getRandomValues(new Uint8Array(32)))
    const payload = new TextEncoder().encode('{"hello":"world"}')

    const envelope = await signEnvelope(payload, 'application/vnd.in-toto+json', key)

    const tamperedBytes = algosdk.base64ToBytes(envelope.payload)
    tamperedBytes[0] = tamperedBytes[0]! ^ 0xff
    const tampered: Envelope = { ...envelope, payload: algosdk.bytesToBase64(tamperedBytes) }

    const ok = await verifyEnvelope(tampered, [{ keyid: key.keyid, publicKey: key.publicKey }])

    expect(ok).toBe(false)
  })

  test('a signature fails when the keyid is not in the accepted key list', async () => {
    const key = await loadSigningKey(crypto.getRandomValues(new Uint8Array(32)))
    const otherKey = await loadSigningKey(crypto.getRandomValues(new Uint8Array(32)))
    const payload = new TextEncoder().encode('{"hello":"world"}')

    const envelope = await signEnvelope(payload, 'application/vnd.in-toto+json', key)

    // Accepted key list only contains a different keyid.
    const ok = await verifyEnvelope(envelope, [{ keyid: otherKey.keyid, publicKey: otherKey.publicKey }])

    expect(ok).toBe(false)
  })

  test('the signature does not contain the algosdk MX domain-separation prefix', async () => {
    const account = algosdk.generateAccount()
    const seed = account.sk.slice(0, 32)
    const message = pae('application/vnd.in-toto+json', new TextEncoder().encode('{"a":1}'))

    // algosdk.signBytes prepends "MX" to the message before signing.
    const algosdkSig = algosdk.signBytes(message, account.sk)
    // Our signing path signs the raw PAE bytes directly, with no prefix.
    const { signAsync } = await import('@noble/ed25519')
    const rawSig = await signAsync(message, seed)

    expect(Array.from(rawSig)).not.toEqual(Array.from(algosdkSig))

    // Verifying the algosdk (MX-prefixed) signature against the raw PAE
    // message must fail, proving it signed different bytes.
    const { verifyAsync } = await import('@noble/ed25519')
    const rawVerifiesAlgosdkSig = await verifyAsync(algosdkSig, message, account.addr.publicKey)
    expect(rawVerifiesAlgosdkSig).toBe(false)

    // Our raw signature does verify directly against the raw PAE message.
    const rawVerifiesOwnSig = await verifyAsync(rawSig, message, account.addr.publicKey)
    expect(rawVerifiesOwnSig).toBe(true)
  })
})

describe('buildLockfileStatement / buildSinglePackageStatement', () => {
  test('builds a lockfile statement with sha256 subject digest', async () => {
    const { buildLockfileStatement } = await import('./dsse.js')
    const statement = buildLockfileStatement({
      subjectName: 'package-lock.json',
      sha256: 'a'.repeat(64),
      predicateType: 'https://spm.dev/attestation/lockfile/v1',
      predicate: { issuer: 'spm', issuedAt: '2026-09-19T00:00:00Z', network: 'testnet', registryAppId: 0 },
    })

    expect(statement._type).toBe('https://in-toto.io/Statement/v1')
    expect(statement.subject).toEqual([{ name: 'package-lock.json', digest: { sha256: 'a'.repeat(64) } }])
    expect(statement.predicateType).toBe('https://spm.dev/attestation/lockfile/v1')
  })

  test('builds a single-package statement with sha512 subject digest', async () => {
    const { buildSinglePackageStatement } = await import('./dsse.js')
    const statement = buildSinglePackageStatement({
      packageUrl: 'pkg:npm/ms@2.1.3',
      sha512: 'b'.repeat(128),
      predicateType: 'https://spm.dev/attestation/lockfile/v1',
      predicate: { issuer: 'spm' },
    })

    expect(statement.subject).toEqual([{ name: 'pkg:npm/ms@2.1.3', digest: { sha512: 'b'.repeat(128) } }])
  })
})
