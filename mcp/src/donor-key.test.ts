import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { donorEnvFilePath, loadDonorMnemonic, writeDonorEnvFile } from './donor-key.js'

const KEY_VAR = 'AUPM_DONOR_MNEMONIC'
// Placeholder words, not a real mnemonic: these functions only move the string.
const FILE_VALUE = 'file words'
const ENV_VALUE = 'env words'

let configHome: string

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-donor-key-'))
  process.env.XDG_CONFIG_HOME = configHome
})

afterEach(() => {
  delete process.env[KEY_VAR]
  delete process.env.XDG_CONFIG_HOME
  fs.rmSync(configHome, { recursive: true, force: true })
})

describe('donor key file', () => {
  it('defaults to ~/.config/aupm/donor.env without XDG_CONFIG_HOME', () => {
    delete process.env.XDG_CONFIG_HOME
    expect(donorEnvFilePath()).toBe(path.join(os.homedir(), '.config', 'aupm', 'donor.env'))
  })

  it('creates the file 0600 in a 0700 directory and refuses a second write', () => {
    const file = writeDonorEnvFile(FILE_VALUE)
    expect(fs.statSync(file).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(file)).mode & 0o777).toBe(0o700)
    expect(() => writeDonorEnvFile('other')).toThrow(file)
    expect(loadDonorMnemonic()).toBe(FILE_VALUE)
  })

  it('lets the env var win over the file', () => {
    writeDonorEnvFile(FILE_VALUE)
    process.env[KEY_VAR] = ENV_VALUE
    expect(loadDonorMnemonic()).toBe(ENV_VALUE)
  })

  it('refuses a file wider than 0600 with a chmod fix', () => {
    const file = writeDonorEnvFile(FILE_VALUE)
    fs.chmodSync(file, 0o644)
    expect(() => loadDonorMnemonic()).toThrow(`chmod 600 ${file}`)
  })

  it('skips the mode check on win32', () => {
    const file = writeDonorEnvFile(FILE_VALUE)
    fs.chmodSync(file, 0o644)
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    expect(loadDonorMnemonic()).toBe(FILE_VALUE)
    platform.mockRestore()
    expect(() => loadDonorMnemonic()).toThrow('chmod 600')
  })

  it('never tells the user to remove an existing file', () => {
    writeDonorEnvFile(FILE_VALUE)
    let message = ''
    try {
      writeDonorEnvFile('other')
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toContain('aupm donor status')
    expect(message).not.toMatch(/remove/i)
  })

  it('fails with a pointer to init when neither source exists', () => {
    expect(() => loadDonorMnemonic()).toThrow('aupm donor init')
  })

  it('rejects a file without the key line', () => {
    const file = writeDonorEnvFile(FILE_VALUE)
    fs.writeFileSync(file, 'OTHER=1\n')
    expect(() => loadDonorMnemonic()).toThrow('no AUPM_DONOR')
  })
})
