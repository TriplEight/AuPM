// cli/src/config.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigError,
  configFilePath,
  readConfigDonate,
  resolveDonate,
  runConfig,
} from './config.js'

describe('config', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-config-test-'))
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('AUPM_DONATE', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(text: string): void {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true })
    fs.writeFileSync(configFilePath(), text)
  }

  it('puts the file under XDG_CONFIG_HOME, and under ~/.config without it', () => {
    expect(configFilePath()).toBe(path.join(dir, 'aupm', 'config.toml'))
    vi.stubEnv('XDG_CONFIG_HOME', '')
    expect(configFilePath()).toBe(path.join(os.homedir(), '.config', 'aupm', 'config.toml'))
  })

  it('a missing file is not set', () => {
    expect(readConfigDonate()).toBeUndefined()
    expect(resolveDonate(undefined)).toEqual({ value: false, source: 'default' })
  })

  it.each([
    ['donate = true\n', true],
    ['donate = false\n', false],
    ['# comment\n\n  donate=true  # trailing\r\n', true],
    ['# only a comment\n', undefined],
  ])('reads %j', (text, expected) => {
    writeConfig(text)
    expect(readConfigDonate()).toBe(expected)
  })

  it.each([
    ['donate = yes\n', 1],
    ['# ok\nDonate = true\n', 2],
    ['\n\ndonate = "true"\n', 3],
    ['[section]\n', 1],
    ['other = true\n', 1],
  ])('rejects %j with the path and line number', (text, line) => {
    writeConfig(text)
    expect(() => readConfigDonate()).toThrow(ConfigError)
    expect(() => readConfigDonate()).toThrow(`config.toml:${line}:`)
    expect(() => readConfigDonate()).toThrow('donate = true  or  donate = false')
  })

  it('resolves the file, then the env var over the file, then the flag over both', () => {
    writeConfig('donate = true\n')
    expect(resolveDonate(undefined)).toEqual({ value: true, source: 'file' })
    vi.stubEnv('AUPM_DONATE', 'false')
    expect(resolveDonate(undefined)).toEqual({ value: false, source: 'env' })
    expect(resolveDonate(true)).toEqual({ value: true, source: 'flag' })
  })

  it.each(['True', '1', 'yes', ' true'])('rejects AUPM_DONATE=%j', (value) => {
    vi.stubEnv('AUPM_DONATE', value)
    expect(() => resolveDonate(undefined)).toThrow('AUPM_DONATE')
    expect(() => resolveDonate(undefined)).toThrow('true or false')
  })

  it('runConfig set writes a file with a header, and get reads it back', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runConfig(['set', 'donate', 'true'])).toBe(0)
    expect(fs.readFileSync(configFilePath(), 'utf8')).toBe(
      '# AuPM CLI settings. Edit with: aupm config set donate <true|false>\ndonate = true\n',
    )
    expect(runConfig(['get', 'donate'])).toBe(0)
    expect(log).toHaveBeenLastCalledWith(`donate = true (source: file ${configFilePath()})`)
    expect(runConfig(['set', 'donate', 'false'])).toBe(0)
    expect(readConfigDonate()).toBe(false)
  })

  it('runConfig get names the source: default, env and flag-free', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    runConfig(['get', 'donate'])
    expect(log).toHaveBeenLastCalledWith('donate = false (source: default)')
    vi.stubEnv('AUPM_DONATE', 'true')
    runConfig(['get', 'donate'])
    expect(log).toHaveBeenLastCalledWith('donate = true (source: env AUPM_DONATE)')
  })

  it.each([
    [['set', 'donate', 'maybe']],
    [['set', 'donate']],
    [['set', 'color', 'true']],
    [['get']],
    [[]],
  ])('runConfig %j is a usage error, exit 1, and writes nothing', (argv) => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runConfig(argv)).toBe(1)
    expect(fs.existsSync(configFilePath())).toBe(false)
  })

  it('runConfig get reports a malformed file and exits 1', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeConfig('nonsense\n')
    expect(runConfig(['get', 'donate'])).toBe(1)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('config.toml:1:'))
  })
})
