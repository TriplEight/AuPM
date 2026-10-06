import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { mnemonicFromSeed } from '@algorandfoundation/algokit-utils/algo25'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { donorKeyFilePath, loadDonorMnemonic, writeDonorKeyFile } from './donor-key.js'

const KEY_VAR = 'AUPM_DONOR_MNEMONIC'
// Throwaway mnemonics: generated per run, never funded.
const FILE_VALUE = mnemonicFromSeed(crypto.randomBytes(32))
const ENV_VALUE = mnemonicFromSeed(crypto.randomBytes(32))

let configHome: string

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-donor-key-'))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env[KEY_VAR]
  delete process.env.XDG_CONFIG_HOME
  fs.rmSync(configHome, { recursive: true, force: true })
})

function messageOf(action: () => unknown): string {
  try {
    action()
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('donor key file', () => {
  it('defaults to ~/.config/aupm/donor.key without XDG_CONFIG_HOME', () => {
    delete process.env.XDG_CONFIG_HOME
    expect(donorKeyFilePath()).toBe(path.join(os.homedir(), '.config', 'aupm', 'donor.key'))
  })

  it('holds exactly the words and a newline, 0600 in a 0700 directory', () => {
    const file = writeDonorKeyFile(FILE_VALUE)
    expect(fs.readFileSync(file, 'utf8')).toBe(`${FILE_VALUE}\n`)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(loadDonorMnemonic()).toBe(FILE_VALUE)
  })

  it('refuses a second write, names the path and never says remove', () => {
    const file = writeDonorKeyFile(FILE_VALUE)
    const message = messageOf(() => writeDonorKeyFile(ENV_VALUE))
    expect(message).toContain(file)
    expect(message).toContain('aupm donor status')
    expect(message).not.toMatch(/remove/i)
    expect(fs.readFileSync(file, 'utf8')).toBe(`${FILE_VALUE}\n`)
  })

  it('lets the env var win over the file', () => {
    writeDonorKeyFile(FILE_VALUE)
    process.env[KEY_VAR] = ENV_VALUE
    expect(loadDonorMnemonic()).toBe(ENV_VALUE)
  })

  it('trims a trailing newline from the env var', () => {
    process.env[KEY_VAR] = `${ENV_VALUE}\n`
    expect(loadDonorMnemonic()).toBe(ENV_VALUE)
  })

  it('refuses a file wider than 0600 with a chmod fix', () => {
    const file = writeDonorKeyFile(FILE_VALUE)
    fs.chmodSync(file, 0o644)
    expect(() => loadDonorMnemonic()).toThrow(`chmod 600 ${file}`)
  })

  it('skips the mode check on win32', () => {
    const file = writeDonorKeyFile(FILE_VALUE)
    fs.chmodSync(file, 0o644)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(loadDonorMnemonic()).toBe(FILE_VALUE)
    platform.mockRestore()
    expect(() => loadDonorMnemonic()).toThrow('chmod 600')
  })

  it('fails with a pointer to init when neither source exists', () => {
    expect(() => loadDonorMnemonic()).toThrow('aupm donor init')
  })

  it.each([
    ['a dotenv line', `${KEY_VAR}=${FILE_VALUE}\n`],
    ['an extra line', `${FILE_VALUE}\nsecond line\n`],
    [
      'two lines of words',
      `${FILE_VALUE.split(' ').slice(0, 12).join(' ')}\n${FILE_VALUE.split(' ').slice(12).join(' ')}\n`,
    ],
    ['24 words', `${FILE_VALUE.split(' ').slice(0, 24).join(' ')}\n`],
    ['an empty file', ''],
    ['25 words that are not a mnemonic', `${'abandon '.repeat(24)}abandon\n`],
  ])('refuses a file with %s and names the path only', (_label, content) => {
    const file = writeDonorKeyFile(FILE_VALUE)
    fs.writeFileSync(file, content)
    const message = messageOf(() => loadDonorMnemonic())
    expect(message).toContain(file)
    for (const word of FILE_VALUE.split(' ')) expect(message).not.toContain(` ${word} `)
    expect(message).not.toContain(FILE_VALUE)
  })
})
