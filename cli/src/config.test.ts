// cli/src/config.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configFilePath, readConfigDonate } from 'aupm-mcp/config'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runConfig } from './config.js'

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
    vi.restoreAllMocks()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(text: string): void {
    fs.mkdirSync(path.dirname(configFilePath()), { recursive: true })
    fs.writeFileSync(configFilePath(), text)
  }

  it('runConfig set writes a file with a header, and get reads it back', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runConfig(['set', 'donate', 'true'])).toBe(0)
    expect(fs.readFileSync(configFilePath(), 'utf8')).toBe(
      '# AuPM CLI settings. Edit with: aupm config set donate <true|false>, aupm config set multiplier <x>\ndonate = true\n',
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

  it('runConfig refuses an npm key and names npm config, with no npm call', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runConfig(['get', 'registry'])).toBe(1)
    expect(log).toHaveBeenCalledWith(
      'aupm config manages AuPM settings only. For npm settings, run npm config.',
    )
  })

  it('runConfig get reports a malformed file and exits 1', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    writeConfig('nonsense\n')
    expect(runConfig(['get', 'donate'])).toBe(1)
    expect(err).toHaveBeenCalledWith(expect.stringContaining('config.toml:1:'))
  })

  it('runConfig set multiplier writes the file, get reads it, and a raise or a lower is the same command', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    expect(runConfig(['get', 'multiplier'])).toBe(0)
    expect(log).toHaveBeenLastCalledWith('multiplier = x1 (default)')
    expect(runConfig(['set', 'multiplier', '2.5'])).toBe(0)
    expect(fs.readFileSync(configFilePath(), 'utf8')).toContain('multiplier = "2.5"\n')
    expect(runConfig(['get', 'multiplier'])).toBe(0)
    expect(log).toHaveBeenLastCalledWith(`multiplier = x2.5 (source: file ${configFilePath()})`)
    expect(runConfig(['set', 'multiplier', '0.1'])).toBe(0)
    expect(runConfig(['get', 'multiplier'])).toBe(0)
    expect(log).toHaveBeenLastCalledWith(`multiplier = x0.1 (source: file ${configFilePath()})`)
    vi.stubEnv('AUPM_MULTIPLIER', '100')
    runConfig(['get', 'multiplier'])
    expect(log).toHaveBeenLastCalledWith('multiplier = x100 (source: env AUPM_MULTIPLIER)')
  })

  it.each(['0', '0.05', '1.25', '101', '-1', 'abc', ''])(
    'runConfig set multiplier %j names the range, exits 1 and writes nothing',
    (value) => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => {})
      expect(runConfig(['set', 'multiplier', value])).toBe(1)
      expect(err).toHaveBeenCalledWith(expect.stringContaining('from 0.1 to 100'))
      expect(fs.existsSync(configFilePath())).toBe(false)
    },
  )

  it('runConfig set multiplier with no value exits 1', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(runConfig(['set', 'multiplier'])).toBe(1)
  })
})
