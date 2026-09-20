// cli/src/verify.test.ts
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'
import {
  type Envelope,
  pae,
  parseEnvelope,
  parseKeyListJson,
  runVerify,
  verifyLockfileDigest,
  verifySignatures,
} from './verify.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const FIXTURES_DIR = join(HERE, '..', 'test-fixtures')

function loadFixtureEnvelope(): Envelope {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'attestation.json'), 'utf8'))
  return parseEnvelope(raw)
}

function loadFixtureKeys() {
  const raw = JSON.parse(readFileSync(join(FIXTURES_DIR, 'spm-keys.json'), 'utf8'))
  return parseKeyListJson(raw)
}

describe('pae', () => {
  test('matches the DSSE spec text for a known short input', () => {
    // "DSSEv1" SP len("app") SP "app" SP len([1,2,3]) SP [1,2,3]
    const expected = Uint8Array.from([
      68,
      83,
      83,
      69,
      118,
      49, // "DSSEv1"
      32, // SP
      51, // "3"
      32, // SP
      97,
      112,
      112, // "app"
      32, // SP
      51, // "3"
      32, // SP
      1,
      2,
      3,
    ])
    const actual = pae('app', new Uint8Array([1, 2, 3]))
    expect(Array.from(actual)).toEqual(Array.from(expected))
  })
})

describe('verifySignatures', () => {
  test('the golden fixture, signed by the proxy signer, verifies with the correct key', async () => {
    const envelope = loadFixtureEnvelope()
    const keys = loadFixtureKeys()
    const results = await verifySignatures(envelope, keys)
    expect(results).toHaveLength(1)
    // biome-ignore lint/style/noNonNullAssertion: length asserted above
    expect(results[0]!.ok).toBe(true)
  })

  test('flipping one byte of the payload makes verification fail', async () => {
    const envelope = loadFixtureEnvelope()
    const keys = loadFixtureKeys()

    const payloadBytes = Buffer.from(envelope.payload, 'base64')
    // biome-ignore lint/style/noNonNullAssertion: payloadBytes is a real, non-empty decoded buffer
    payloadBytes[0] = payloadBytes[0]! ^ 0xff
    const tampered: Envelope = { ...envelope, payload: payloadBytes.toString('base64') }

    const results = await verifySignatures(tampered, keys)
    // biome-ignore lint/style/noNonNullAssertion: verifySignatures returns one result per supplied key
    expect(results[0]!.ok).toBe(false)
  })

  test('a keyid absent from the supplied key list makes verification fail', async () => {
    const envelope = loadFixtureEnvelope()
    // A key list with a well-formed but unrelated keyid/pubkey — not the fixture's signer.
    const foreignKeys = [
      {
        keyid: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        publicKey: new Uint8Array(32),
      },
    ]

    const results = await verifySignatures(envelope, foreignKeys)
    // biome-ignore lint/style/noNonNullAssertion: verifySignatures returns one result per supplied key
    expect(results[0]!.ok).toBe(false)
    // biome-ignore lint/style/noNonNullAssertion: verifySignatures returns one result per supplied key
    expect(results[0]!.line).toContain('not in supplied key list')
  })
})

describe('verifyLockfileDigest', () => {
  test('a lockfile whose sha256 differs from the subject digest makes verification fail', () => {
    const envelope = loadFixtureEnvelope()
    const wrongBytes = new TextEncoder().encode('this is not the fixture lockfile')
    const result = verifyLockfileDigest(envelope, wrongBytes)
    expect(result.ok).toBe(false)
  })

  test('a matching lockfile passes', () => {
    const envelope = loadFixtureEnvelope()
    const lockfileBytes = readFileSync(join(FIXTURES_DIR, 'package-lock.json'))
    const result = verifyLockfileDigest(envelope, new Uint8Array(lockfileBytes))
    expect(result.ok).toBe(true)

    // Sanity: the fixture digest really is the sha256 of the raw file bytes.
    const sha256 = createHash('sha256').update(lockfileBytes).digest('hex')
    const payload = JSON.parse(Buffer.from(envelope.payload, 'base64').toString('utf8'))
    expect(payload.subject[0].digest.sha256).toBe(sha256)
  })
})

describe('runVerify (end to end, exit code)', () => {
  test('exits 0 when the golden fixture verifies against the correct key and lockfile', async () => {
    const logs: string[] = []
    const originalLog = console.log
    console.log = (...args: unknown[]) => logs.push(args.join(' '))
    try {
      const code = await runVerify([
        join(FIXTURES_DIR, 'attestation.json'),
        '--keys',
        join(FIXTURES_DIR, 'spm-keys.json'),
        '--lockfile',
        join(FIXTURES_DIR, 'package-lock.json'),
      ])
      expect(code).toBe(0)
      expect(logs.join('\n')).toContain('verify: PASS')
    } finally {
      console.log = originalLog
    }
  })

  test('exits 1 when the fixture payload is tampered', async () => {
    const envelope = loadFixtureEnvelope()
    const payloadBytes = Buffer.from(envelope.payload, 'base64')
    // biome-ignore lint/style/noNonNullAssertion: payloadBytes is a real, non-empty decoded buffer
    payloadBytes[0] = payloadBytes[0]! ^ 0xff
    const tampered: Envelope = { ...envelope, payload: payloadBytes.toString('base64') }

    const dir = mkdtempSync(join(tmpdir(), 'spm-verify-test-'))
    const tamperedPath = join(dir, 'tampered.json')
    writeFileSync(tamperedPath, JSON.stringify(tampered))
    try {
      const logs: string[] = []
      const originalLog = console.log
      console.log = (...args: unknown[]) => logs.push(args.join(' '))
      let code: number
      try {
        code = await runVerify([tamperedPath, '--keys', join(FIXTURES_DIR, 'spm-keys.json')])
      } finally {
        console.log = originalLog
      }
      expect(code).toBe(1)
      expect(logs.join('\n')).toContain('verify: FAIL')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
