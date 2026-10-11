// mcp/src/config.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError, configFilePath, readConfigDonate, resolveDonate } from './config.js'

describe('config', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-config-test-'))
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('AUPM_DONATE', '')
  })

  afterEach(() => {
    vi.unstubAllEnvs()
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

  it('a missing file is not set, so the default is off', () => {
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

  it.each([
    ['file true', 'true', undefined, undefined, { value: true, source: 'file' }],
    ['file false', 'false', undefined, undefined, { value: false, source: 'file' }],
    ['env true over file false', 'false', 'true', undefined, { value: true, source: 'env' }],
    ['env false over file true', 'true', 'false', undefined, { value: false, source: 'env' }],
    ['explicit true over env false', 'false', 'false', true, { value: true, source: 'explicit' }],
    ['explicit false over env true', 'true', 'true', false, { value: false, source: 'explicit' }],
  ])('precedence: %s', (_name, file, env, explicit, expected) => {
    writeConfig(`donate = ${file}\n`)
    if (env !== undefined) vi.stubEnv('AUPM_DONATE', env)
    expect(resolveDonate(explicit)).toEqual(expected)
  })

  it('an explicit choice ignores a malformed env var and a malformed file', () => {
    writeConfig('nonsense\n')
    vi.stubEnv('AUPM_DONATE', 'maybe')
    expect(resolveDonate(false)).toEqual({ value: false, source: 'explicit' })
  })

  it.each(['True', '1', 'yes', ' true'])('rejects AUPM_DONATE=%j', (value) => {
    vi.stubEnv('AUPM_DONATE', value)
    expect(() => resolveDonate(undefined)).toThrow('AUPM_DONATE')
    expect(() => resolveDonate(undefined)).toThrow('true or false')
  })

  it('rejects a malformed file when nothing above it is set', () => {
    writeConfig('nonsense\n')
    expect(() => resolveDonate(undefined)).toThrow(ConfigError)
  })
})
