import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigError } from '../config.js'
import { installTool } from './install.js'

function requestHeader(input: RequestInfo | URL, init?: RequestInit): string | null {
  const request = input instanceof Request ? input : new Request(input, init)
  return request.headers.get('X-AuPM-Donate')
}

describe('donation setting in the install tool', () => {
  let dir: string
  let seen: (string | null)[]

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-setting-test-'))
    seen = []
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('AUPM_DONATE', '')
    vi.stubEnv('AUPM_PROXY_URL', 'http://localhost:4873')
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        seen.push(requestHeader(input, init))
        return new Response(new Uint8Array([1, 2, 3]), { status: 200 })
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeConfig(text: string): void {
    fs.mkdirSync(path.join(dir, 'aupm'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'aupm', 'config.toml'), text)
  }

  async function install(allowDonation?: boolean): Promise<void> {
    await installTool.handler({ pkg: 'lodash', version: '4.17.21', allowDonation })
  }

  it('is off by default', async () => {
    await install()
    expect(seen).toEqual(['0'])
  })

  it('the file turns it on', async () => {
    writeConfig('donate = true\n')
    await install()
    expect(seen).toEqual(['1'])
  })

  it('the file turns it off', async () => {
    writeConfig('donate = false\n')
    await install()
    expect(seen).toEqual(['0'])
  })

  it('the env var true turns it on over a file false', async () => {
    writeConfig('donate = false\n')
    vi.stubEnv('AUPM_DONATE', 'true')
    await install()
    expect(seen).toEqual(['1'])
  })

  it('the env var false turns it off over a file true', async () => {
    writeConfig('donate = true\n')
    vi.stubEnv('AUPM_DONATE', 'false')
    await install()
    expect(seen).toEqual(['0'])
  })

  it('allowDonation true wins over an env var false', async () => {
    vi.stubEnv('AUPM_DONATE', 'false')
    await install(true)
    expect(seen).toEqual(['1'])
  })

  it('allowDonation false wins over an env var true and a file true', async () => {
    writeConfig('donate = true\n')
    vi.stubEnv('AUPM_DONATE', 'true')
    await install(false)
    expect(seen).toEqual(['0'])
  })

  it('a malformed env var fails the call before any request', async () => {
    vi.stubEnv('AUPM_DONATE', 'yes')
    await expect(install()).rejects.toThrow(ConfigError)
    expect(seen).toEqual([])
  })

  it('a malformed file fails the call before any request', async () => {
    writeConfig('donate = maybe\n')
    await expect(install()).rejects.toThrow('config.toml:1:')
    expect(seen).toEqual([])
  })

  it('states the setting in the tool description', () => {
    expect(installTool.description).toContain('AUPM_DONATE')
    expect(installTool.description).toContain('config.toml')
  })
})
