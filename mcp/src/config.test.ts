// mcp/src/config.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  ConfigError,
  configFilePath,
  describeMultiplier,
  formatMultiplier,
  parseMultiplier,
  readConfigDonate,
  resolveDonate,
  resolveMultiplier,
  writeConfigDonate,
  writeConfigMultiplier,
} from './config.js'

describe('config', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-config-test-'))
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('AUPM_DONATE', '')
    vi.stubEnv('AUPM_MULTIPLIER', '')
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

  it.each([
    ['0.1', 1],
    ['1', 10],
    ['2.5', 25],
    ['100', 1000],
    [' 7 ', 70],
  ])('parses the multiplier %j as %i tenths', (text, tenths) => {
    expect(parseMultiplier(text)).toBe(tenths)
    expect(parseMultiplier(formatMultiplier(tenths).slice(1))).toBe(tenths)
  })

  it.each(['0', '0.0', '0.05', '1.25', '101', '100.1', '-1', 'abc', '', '1e1', '1.', '.5'])(
    'rejects the multiplier %j and names the range',
    (text) => {
      expect(() => parseMultiplier(text)).toThrow(ConfigError)
      expect(() => parseMultiplier(text)).toThrow('from 0.1 to 100')
    },
  )

  it('formats tenths and describes a default as not set', () => {
    expect(formatMultiplier(1)).toBe('x0.1')
    expect(formatMultiplier(25)).toBe('x2.5')
    expect(formatMultiplier(1000)).toBe('x100')
    expect(describeMultiplier({ tenths: 1, source: 'default' })).toBe(
      'x0.1 (not set; aupm config set multiplier <x>)',
    )
    expect(describeMultiplier({ tenths: 10, source: 'file' })).toBe('x1')
  })

  it('the multiplier defaults to x0.1, then the file, then the env var', () => {
    expect(resolveMultiplier()).toEqual({ tenths: 1, source: 'default' })
    writeConfig('multiplier = "2.5"\n')
    expect(resolveMultiplier()).toEqual({ tenths: 25, source: 'file' })
    vi.stubEnv('AUPM_MULTIPLIER', '3')
    expect(resolveMultiplier()).toEqual({ tenths: 30, source: 'env' })
  })

  it('a bad multiplier in the env var or the file names the range', () => {
    vi.stubEnv('AUPM_MULTIPLIER', '101')
    expect(() => resolveMultiplier()).toThrow('AUPM_MULTIPLIER')
    expect(() => resolveMultiplier()).toThrow('from 0.1 to 100')
    vi.stubEnv('AUPM_MULTIPLIER', '')
    writeConfig('donate = true\nmultiplier = "0"\n')
    expect(() => resolveMultiplier()).toThrow('config.toml:2:')
    expect(() => resolveMultiplier()).toThrow('from 0.1 to 100')
  })

  it('writing one setting keeps the other', () => {
    writeConfigDonate(true)
    writeConfigMultiplier(10)
    expect(fs.readFileSync(configFilePath(), 'utf8')).toContain('donate = true\nmultiplier = "1"\n')
    writeConfigDonate(false)
    expect(resolveMultiplier().tenths).toBe(10)
    expect(readConfigDonate()).toBe(false)
  })
})
