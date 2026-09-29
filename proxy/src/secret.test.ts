// proxy/src/secret.test.ts
//
// Covers the shared secret loader and its two call sites: the attestation
// signing key (config.ts) and the crediter client (claims/nightly-wiring.ts).
import { randomUUID } from 'node:crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-secret-test-${randomUUID()}.db`)

const { buildAlgodCreditClient } = vi.hoisted(() => ({ buildAlgodCreditClient: vi.fn() }))
vi.mock('./claims/credit.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./claims/credit.js')>()),
  buildAlgodCreditClient,
}))

const SEED_HEX = 'fc982b5f02591ece632fde9d22879692daafd28398f928369c5f1c1f9ff0fd3a'
const MNEMONIC_WORDS = `${'abandon '.repeat(24)}art`

let dir: string

function writeSecretFile(content: string, mode = 0o400): string {
  const file = path.join(dir, `secret-${randomUUID()}`)
  writeFileSync(file, content)
  chmodSync(file, mode)
  return file
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'aupm-secret-'))
  vi.resetModules()
  buildAlgodCreditClient.mockReset()
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  delete process.env.SECRET_TEST
  delete process.env.SECRET_TEST_FILE
  delete process.env.ATTEST_SIGNING_KEY
  delete process.env.ATTEST_SIGNING_KEY_FILE
  delete process.env.CREDITER_MNEMONIC
  delete process.env.CREDITER_MNEMONIC_FILE
})

describe('readSecret', () => {
  test('returns undefined when neither variable is set', async () => {
    const { readSecret } = await import('./secret.js')
    expect(readSecret('SECRET_TEST')).toBeUndefined()
  })

  test('returns the plain variable', async () => {
    process.env.SECRET_TEST = 'plain-value'
    const { readSecret } = await import('./secret.js')
    expect(readSecret('SECRET_TEST')).toBe('plain-value')
  })

  test('reads the file value', async () => {
    process.env.SECRET_TEST_FILE = writeSecretFile('file-value')
    const { readSecret } = await import('./secret.js')
    expect(readSecret('SECRET_TEST')).toBe('file-value')
  })

  test('refuses when both the variable and the file are set', async () => {
    process.env.SECRET_TEST = 'plain-value'
    process.env.SECRET_TEST_FILE = writeSecretFile('file-value')
    const { readSecret } = await import('./secret.js')
    expect(() => readSecret('SECRET_TEST')).toThrow(/SECRET_TEST and SECRET_TEST_FILE/)
  })

  test.each([
    ['group-readable', 0o440],
    ['other-readable', 0o404],
    ['group-writable', 0o620],
  ])('refuses a %s file and does not leak the value', async (_label, mode) => {
    const file = writeSecretFile('super-secret-value', mode)
    process.env.SECRET_TEST_FILE = file
    const { readSecret } = await import('./secret.js')
    let message = ''
    try {
      readSecret('SECRET_TEST')
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('SECRET_TEST_FILE')
    expect(message).toContain(file)
    expect(message).not.toContain('super-secret-value')
  })

  test('accepts mode 0600', async () => {
    process.env.SECRET_TEST_FILE = writeSecretFile('v', 0o600)
    const { readSecret } = await import('./secret.js')
    expect(readSecret('SECRET_TEST')).toBe('v')
  })

  test('refuses a missing file and names the variable and the path', async () => {
    const file = path.join(dir, 'does-not-exist')
    process.env.SECRET_TEST_FILE = file
    const { readSecret } = await import('./secret.js')
    expect(() => readSecret('SECRET_TEST')).toThrow(/SECRET_TEST_FILE.*does-not-exist/)
  })

  test.each([[''], ['\n'], ['\r\n']])('refuses an empty file value %j', async (content) => {
    process.env.SECRET_TEST_FILE = writeSecretFile(content)
    const { readSecret } = await import('./secret.js')
    expect(() => readSecret('SECRET_TEST')).toThrow(/empty/)
  })

  test.each([
    ['abc\n', 'abc'],
    ['abc\r\n', 'abc'],
    ['abc\n\n', 'abc\n'],
    ['a b\nc\n', 'a b\nc'],
    ['abc', 'abc'],
  ])('trims one trailing newline only: %j', async (content, expected) => {
    process.env.SECRET_TEST_FILE = writeSecretFile(content)
    const { readSecret } = await import('./secret.js')
    expect(readSecret('SECRET_TEST')).toBe(expected)
  })
})

describe('assertValidSecretSources', () => {
  test('passes when nothing is set', async () => {
    const { assertValidSecretSources } = await import('./secret.js')
    expect(() => assertValidSecretSources()).not.toThrow()
  })

  test('refuses a bad ATTEST_SIGNING_KEY_FILE at boot', async () => {
    process.env.ATTEST_SIGNING_KEY_FILE = writeSecretFile(SEED_HEX, 0o444)
    const { assertValidSecretSources } = await import('./secret.js')
    expect(() => assertValidSecretSources()).toThrow(/ATTEST_SIGNING_KEY_FILE/)
  })

  test('refuses a bad CREDITER_MNEMONIC_FILE at boot', async () => {
    process.env.CREDITER_MNEMONIC_FILE = path.join(dir, 'missing')
    const { assertValidSecretSources } = await import('./secret.js')
    expect(() => assertValidSecretSources()).toThrow(/CREDITER_MNEMONIC_FILE/)
  })
})

describe('attestation signing key', () => {
  test('the key from a file equals the key from the variable', async () => {
    process.env.ATTEST_SIGNING_KEY = SEED_HEX
    const fromEnv = await (await import('./config.js')).getAttestationSigningKey()

    vi.resetModules()
    delete process.env.ATTEST_SIGNING_KEY
    process.env.ATTEST_SIGNING_KEY_FILE = writeSecretFile(`${SEED_HEX}\n`)
    const fromFile = await (await import('./config.js')).getAttestationSigningKey()

    expect(fromFile.keyid).toBe(fromEnv.keyid)
    expect(Buffer.from(fromFile.publicKey).equals(Buffer.from(fromEnv.publicKey))).toBe(true)
  })

  test('still throws the existing error when neither is set', async () => {
    const { getAttestationSigningKey } = await import('./config.js')
    expect(() => getAttestationSigningKey()).toThrow(
      'ATTEST_SIGNING_KEY is not set: cannot sign attestations',
    )
  })
})

describe('crediter client', () => {
  test('is built from the file value', async () => {
    process.env.CREDITER_MNEMONIC_FILE = writeSecretFile(`${MNEMONIC_WORDS}\n`)
    const { buildRealNightlyDeps } = await import('./claims/nightly-wiring.js')
    buildRealNightlyDeps()
    expect(buildAlgodCreditClient).toHaveBeenCalledTimes(1)
    expect(buildAlgodCreditClient.mock.calls[0]?.[2]).toBe(MNEMONIC_WORDS)
  })

  test('is null when neither variable is set', async () => {
    const { buildRealNightlyDeps } = await import('./claims/nightly-wiring.js')
    expect(buildRealNightlyDeps().creditClient).toBeNull()
    expect(buildAlgodCreditClient).not.toHaveBeenCalled()
  })

  test('refuses a group-readable file without leaking the words', async () => {
    process.env.CREDITER_MNEMONIC_FILE = writeSecretFile(MNEMONIC_WORDS, 0o640)
    const { buildRealNightlyDeps } = await import('./claims/nightly-wiring.js')
    let message = ''
    try {
      buildRealNightlyDeps()
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toContain('CREDITER_MNEMONIC_FILE')
    expect(message).not.toContain('abandon')
  })
})
