// cli/src/npm-wrapper.test.ts

import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { attestLockfileTool } from 'aupm-mcp/tools/attest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('aupm-mcp/tools/attest', () => ({
  attestLockfileTool: { handler: vi.fn() },
}))

/** A fake child process: spawn() returns this, and the test drives its exit. */
function fakeChild(): EventEmitter {
  return new EventEmitter()
}

describe('parseNpmArgv', () => {
  it('passes flags, positional args, and args with spaces through unchanged', async () => {
    const { parseNpmArgv } = await import('./npm-wrapper.js')
    const result = parseNpmArgv(['install', 'left pad', '--save-dev', '-g'])
    expect(result).toEqual({
      npmArgs: ['install', 'left pad', '--save-dev', '-g'],
      allowDonation: false,
      attestOutPath: undefined,
    })
  })

  it('strips --donate wherever it appears', async () => {
    const { parseNpmArgv } = await import('./npm-wrapper.js')
    const result = parseNpmArgv(['install', '--donate', 'ms@2.1.3'])
    expect(result.npmArgs).toEqual(['install', 'ms@2.1.3'])
    expect(result.allowDonation).toBe(true)
  })

  it('strips --attest-out and its value', async () => {
    const { parseNpmArgv } = await import('./npm-wrapper.js')
    const result = parseNpmArgv(['install', 'ms@2.1.3', '--attest-out', 'out.json'])
    expect(result.npmArgs).toEqual(['install', 'ms@2.1.3'])
    expect(result.attestOutPath).toBe('out.json')
  })

  it('never inspects tokens after a literal --', async () => {
    const { parseNpmArgv } = await import('./npm-wrapper.js')
    const result = parseNpmArgv(['run', 'build', '--', '--donate', '--attest-out'])
    expect(result.npmArgs).toEqual(['run', 'build', '--', '--donate', '--attest-out'])
    expect(result.allowDonation).toBe(false)
    expect(result.attestOutPath).toBeUndefined()
  })
})

describe('isInstallLike', () => {
  it('is false for run', async () => {
    const { isInstallLike } = await import('./npm-wrapper.js')
    expect(isInstallLike(['run', 'build'])).toBe(false)
  })

  it.each(['install', 'i', 'ci', 'add'])('is true for %s', async (subcommand) => {
    const { isInstallLike } = await import('./npm-wrapper.js')
    expect(isInstallLike([subcommand, 'ms@2.1.3'])).toBe(true)
  })
})

describe('runWrapper', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-npm-wrapper-test-'))
    originalCwd = process.cwd()
    process.chdir(cwd)
    vi.mocked(spawn).mockReset()
    vi.mocked(attestLockfileTool.handler).mockReset()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('uses AUPM_PROXY_URL as the registry when set, without a trailing slash', async () => {
    vi.stubEnv('AUPM_PROXY_URL', 'http://localhost:4873/')
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['view', 'ms'])
    child.emit('exit', 0, null)
    await runPromise

    expect(spawn).toHaveBeenCalledWith('npm', ['view', 'ms'], {
      stdio: 'inherit',
      env: expect.objectContaining({ npm_config_registry: 'http://localhost:4873' }),
    })
    vi.unstubAllEnvs()
  })

  it('spawns npm with the user argv unchanged, the registry in env, no shell', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['view', 'ms'])
    child.emit('exit', 0, null)
    const exitCode = await runPromise

    expect(exitCode).toBe(0)
    expect(spawn).toHaveBeenCalledWith('npm', ['view', 'ms'], {
      stdio: 'inherit',
      env: expect.objectContaining({ npm_config_registry: 'https://aupm.fyi' }),
    })
    // No shell option and no `command` string — an args array only.
    const spawnArgs = vi.mocked(spawn).mock.calls[0]
    expect(Array.isArray(spawnArgs[1])).toBe(true)
  })

  it('passes argv with -- and trailing args through with no added element', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['run', 'build', '--', '--x'])
    child.emit('exit', 0, null)
    await runPromise

    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['run', 'build', '--', '--x'],
      expect.objectContaining({ stdio: 'inherit' }),
    )
  })

  it('passes a non-zero npm exit code through unchanged', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['view', 'does-not-exist'])
    child.emit('exit', 1, null)

    expect(await runPromise).toBe(1)
    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })

  it('maps a signal-terminated npm process to 128 + the signal number', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['install'])
    child.emit('exit', null, 'SIGTERM')

    expect(await runPromise).toBe(128 + 15)
  })

  it('never forwards --donate or --attest-out to npm', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['install', '--donate', '--attest-out', 'out.json'])
    child.emit('exit', 0, null)
    await runPromise

    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['install'],
      expect.objectContaining({ stdio: 'inherit' }),
    )
  })

  it('prints no donation summary for a non-install command', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['view', 'ms'])
    child.emit('exit', 0, null)
    await runPromise

    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })

  it('with no package-lock.json, prints one line and does not crash', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['install', 'ms@2.1.3'])
    child.emit('exit', 0, null)
    const exitCode = await runPromise

    expect(exitCode).toBe(0)
    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      'aupm: no package-lock.json found; skipping the donation summary.',
    )
    logSpy.mockRestore()
  })

  it('with 0 reviewed entries, prints the zero-reviewed line and no donation hint', async () => {
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}')
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'attested',
      summary: { total: 3, reviewed: 0, unreviewed: 3, unresolvable: 0, integrityMismatch: 0 },
      attestation: {},
      settlement: null,
    })
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['install', 'is-odd'])
    child.emit('exit', 0, null)
    await runPromise

    expect(logSpy).toHaveBeenCalledWith(
      'aupm: 0 packages in package-lock.json are audited (COMMUNITY_REVIEWED).',
    )
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('donate'))
    logSpy.mockRestore()
  })

  it('with N reviewed entries and no --donate, prints the amount and a donation hint', async () => {
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}')
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'donation_required',
      priceMicro: 2_000,
      resourceUrl: 'http://localhost:4873/v1/attest/lockfile',
      asset: '31566704',
      withheld: 2,
      summary: { total: 3, reviewed: 2, unreviewed: 1, unresolvable: 0, integrityMismatch: 0 },
      attestation: {},
    })
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['install', 'ms@2.1.3'])
    child.emit('exit', 0, null)
    await runPromise

    expect(attestLockfileTool.handler).toHaveBeenCalledWith({
      lockfilePath: path.join(cwd, 'package-lock.json'),
      allowDonation: false,
    })
    expect(logSpy).toHaveBeenCalledWith(
      'aupm: 2 packages are audited (COMMUNITY_REVIEWED). $0.002 available to donate.',
    )
    expect(logSpy).toHaveBeenCalledWith(
      'aupm: run the install again with --donate to send this to the auditors.',
    )
    logSpy.mockRestore()
  })

  it('with --donate, pays and reports the donated amount, and writes --attest-out', async () => {
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}')
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'attested',
      summary: { total: 1, reviewed: 1, unreviewed: 0, unresolvable: 0, integrityMismatch: 0 },
      attestation: { payloadType: 'application/vnd.in-toto+json', payload: 'e30=', signatures: [] },
      settlement: { txid: 'SETTLE1', amountMicro: 1_000 },
    })
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runWrapper } = await import('./npm-wrapper.js')
    const outPath = path.join(cwd, 'out.json')

    const runPromise = runWrapper('npm', [
      'install',
      'ms@2.1.3',
      '--donate',
      '--attest-out',
      outPath,
    ])
    child.emit('exit', 0, null)
    await runPromise

    expect(attestLockfileTool.handler).toHaveBeenCalledWith({
      lockfilePath: path.join(cwd, 'package-lock.json'),
      allowDonation: true,
    })
    expect(logSpy).toHaveBeenCalledWith(
      'aupm: 1 package is audited (COMMUNITY_REVIEWED). ' +
        'Donated $0.001 (1000 microUSDC), settlement txid SETTLE1.',
    )
    expect(fs.existsSync(outPath)).toBe(true)
    logSpy.mockRestore()
  })

  it('with --donate but no settlement, says no donation settled, never "Donated"', async () => {
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}')
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'attested',
      summary: { total: 1, reviewed: 1, unreviewed: 0, unresolvable: 0, integrityMismatch: 0 },
      attestation: {},
      settlement: null,
    })
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['install', 'ms@2.1.3', '--donate'])
    child.emit('exit', 0, null)
    await runPromise

    expect(logSpy).toHaveBeenCalledWith(
      'aupm: 1 package is audited (COMMUNITY_REVIEWED). No donation settled.',
    )
    logSpy.mockRestore()
  })

  it('a failed donation logs one line and keeps npm exit code 0', async () => {
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}')
    vi.mocked(attestLockfileTool.handler).mockRejectedValue(new Error('refusing to donate'))
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { runWrapper } = await import('./npm-wrapper.js')

    const runPromise = runWrapper('npm', ['install', 'ms@2.1.3', '--donate'])
    child.emit('exit', 0, null)
    const exitCode = await runPromise

    expect(exitCode).toBe(0)
    expect(logSpy).toHaveBeenCalledWith('aupm: donation summary failed: refusing to donate')
    logSpy.mockRestore()
  })

  it('a failed summary request keeps a non-zero npm exit code unaffected', async () => {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    // npm itself failed — the summary must never even run.
    const runPromise = runWrapper('npm', ['install', 'ms@2.1.3'])
    child.emit('exit', 1, null)

    expect(await runPromise).toBe(1)
    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })
})

describe('runWrapper with pnpm and npx', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-pnpm-wrapper-test-'))
    originalCwd = process.cwd()
    process.chdir(cwd)
    vi.mocked(spawn).mockReset()
    vi.mocked(attestLockfileTool.handler).mockReset()
  })

  afterEach(() => {
    process.chdir(originalCwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  async function run(tool: 'pnpm' | 'npx', argv: string[], exitCode = 0): Promise<number> {
    const child = fakeChild()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')
    const runPromise = runWrapper(tool, argv)
    child.emit('exit', exitCode, null)
    return runPromise
  }

  it('spawns pnpm with the user argv, the registry in env, and the exit code unchanged', async () => {
    const exitCode = await run('pnpm', ['view', 'ms'], 3)

    expect(exitCode).toBe(3)
    expect(spawn).toHaveBeenCalledWith('pnpm', ['view', 'ms'], {
      stdio: 'inherit',
      env: expect.objectContaining({ npm_config_registry: 'https://aupm.fyi' }),
    })
  })

  it('strips --donate and --attest-out before pnpm runs', async () => {
    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'attested',
      summary: { total: 0, reviewed: 0 },
      attestation: {},
      settlement: null,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run('pnpm', ['add', 'ms', '--donate', '--attest-out', 'out.json'])

    expect(spawn).toHaveBeenCalledWith('pnpm', ['add', 'ms'], expect.anything())
    logSpy.mockRestore()
  })

  it.each(['install', 'i', 'add'])('attests pnpm-lock.yaml after pnpm %s', async (subcommand) => {
    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'donation_required',
      priceMicro: 1_000,
      resourceUrl: 'http://localhost:4873/v1/attest/lockfile',
      asset: '31566704',
      withheld: 1,
      summary: { total: 2, reviewed: 1 },
      attestation: {},
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run('pnpm', [subcommand, 'ms@2.1.3'])

    expect(attestLockfileTool.handler).toHaveBeenCalledWith({
      lockfilePath: path.join(cwd, 'pnpm-lock.yaml'),
      allowDonation: false,
    })
    expect(logSpy).toHaveBeenCalledWith(
      'aupm: 1 package is audited (COMMUNITY_REVIEWED). $0.001 available to donate.',
    )
    logSpy.mockRestore()
  })

  it('passes allowDonation to the handler for pnpm --donate', async () => {
    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'attested',
      summary: { total: 1, reviewed: 1 },
      attestation: {},
      settlement: { txid: 'TX1', amountMicro: 1_000 },
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run('pnpm', ['install', '--donate'])

    expect(attestLockfileTool.handler).toHaveBeenCalledWith({
      lockfilePath: path.join(cwd, 'pnpm-lock.yaml'),
      allowDonation: true,
    })
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('settlement txid TX1'))
    logSpy.mockRestore()
  })

  it('does not look at package-lock.json after a pnpm install', async () => {
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}')
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await run('pnpm', ['install'])

    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
    expect(logSpy).toHaveBeenCalledWith(
      'aupm: no pnpm-lock.yaml found; skipping the donation summary.',
    )
    logSpy.mockRestore()
  })

  it.each([
    ['run', ['run', 'build']],
    ['ci', ['ci']],
    ['update', ['update']],
  ])('prints no summary after pnpm %s', async (_name, argv) => {
    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")

    await run('pnpm', argv)

    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })

  it('prints no summary when pnpm install fails', async () => {
    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")

    const exitCode = await run('pnpm', ['install'], 1)

    expect(exitCode).toBe(1)
    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })

  it('spawns npx with the user argv and never attests', async () => {
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{}')

    const exitCode = await run('npx', ['cowsay', 'hi', '--', '--donate'], 4)

    expect(exitCode).toBe(4)
    expect(spawn).toHaveBeenCalledWith(
      'npx',
      ['cowsay', 'hi', '--', '--donate'],
      expect.objectContaining({
        env: expect.objectContaining({ npm_config_registry: 'https://aupm.fyi' }),
      }),
    )
    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })

  it.each([
    ['--donate', ['cowsay', '--donate']],
    ['--attest-out', ['cowsay', '--attest-out', 'out.json']],
    ['a trailing --attest-out', ['cowsay', '--attest-out']],
  ])('exits 2 for npx with %s and runs nothing', async (_name, argv) => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { runWrapper } = await import('./npm-wrapper.js')

    const exitCode = await runWrapper('npx', argv)

    expect(exitCode).toBe(2)
    expect(spawn).not.toHaveBeenCalled()
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('npx has no lockfile'))
    errorSpy.mockRestore()
  })
})
