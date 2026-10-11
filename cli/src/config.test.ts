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
