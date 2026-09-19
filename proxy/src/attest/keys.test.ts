// proxy/src/attest/keys.test.ts
import algosdk from 'algosdk'
import { describe, expect, test } from 'vitest'
import { loadSigningKey, publishedKeys } from './keys.js'

describe('loadSigningKey', () => {
  test('derives a 32-byte seed and a 58-character Algorand address keyid from a raw seed', async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32))

    const key = await loadSigningKey(seed)

    expect(key.seed.length).toBe(32)
    expect(key.publicKey.length).toBe(32)
    expect(key.keyid.length).toBe(58)
    expect(algosdk.isValidAddress(key.keyid)).toBe(true)
  })

  test('derives the same keyid from a mnemonic as from its underlying seed', async () => {
    const account = algosdk.generateAccount()
    const mnemonic = algosdk.secretKeyToMnemonic(account.sk)

    const key = await loadSigningKey(mnemonic)

    expect(key.keyid).toBe(account.addr.toString())
  })

  test('rejects a seed that is not exactly 32 bytes', async () => {
    await expect(loadSigningKey(new Uint8Array(16))).rejects.toThrow()
  })
})

describe('publishedKeys', () => {
  test('returns objects with keyid, publicKey, validFrom, and validUntil', async () => {
    const key = await loadSigningKey(crypto.getRandomValues(new Uint8Array(32)))

    const published = publishedKeys([
      { keyid: key.keyid, publicKey: key.publicKey, validFrom: '2026-09-19T00:00:00Z', validUntil: null },
    ])

    expect(published).toHaveLength(1)
    const entry = published[0]!
    expect(Object.keys(entry).sort()).toEqual(['keyid', 'publicKey', 'validFrom', 'validUntil'])
    expect(entry.keyid).toBe(key.keyid)
    expect(entry.validFrom).toBe('2026-09-19T00:00:00Z')
    expect(entry.validUntil).toBeNull()
    // publicKey is published as base64, and round-trips to the same bytes.
    expect(Array.from(algosdk.base64ToBytes(entry.publicKey))).toEqual(Array.from(key.publicKey))
  })

  test('never includes seed or secret-key material', async () => {
    const key = await loadSigningKey(crypto.getRandomValues(new Uint8Array(32)))

    const published = publishedKeys([
      { keyid: key.keyid, publicKey: key.publicKey, validFrom: '2026-09-19T00:00:00Z', validUntil: null },
    ])

    const serialized = JSON.stringify(published)
    expect(serialized).not.toContain(algosdk.bytesToBase64(key.seed))
  })
})
