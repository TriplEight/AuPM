// cli/src/lockfile-dir.test.ts
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { attestLockfileTool } from 'aupm-mcp/tools/attest'
import { afterEach, beforeEach, describe, expect, it, type MockInstance, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('aupm-mcp/tools/attest', () => ({
  attestLockfileTool: { handler: vi.fn() },
}))

const realChildProcess =
  await vi.importActual<typeof import('node:child_process')>('node:child_process')
const npmExists = realChildProcess.spawnSync('npm', ['--version'], { stdio: 'ignore' }).status === 0

describe.skipIf(!npmExists)('lockfile folder after an install', () => {
  let root: string
  let originalCwd: string
  let logSpy: MockInstance<typeof console.log>

  function touch(...parts: string[]): string {
    const file = path.join(root, ...parts)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, '{}')
    return file
  }

  async function runIn(subdir: string, tool: 'npm' | 'pnpm', argv: string[]): Promise<string[]> {
    fs.mkdirSync(path.join(root, subdir), { recursive: true })
    process.chdir(path.join(root, subdir))
    const child = new EventEmitter()
    vi.mocked(spawn).mockImplementation(((command: string, args: string[], options: object) =>
      args[0] === 'prefix' ? realChildProcess.spawn(command, args, options) : child) as never)
    const { runWrapper } = await import('./npm-wrapper.js')
    const promise = runWrapper(tool, argv)
    child.emit('exit', 0, null)
    await promise
    return logSpy.mock.calls.map((call) => String(call[0]))
  }

  function attestedPath(): string {
    const [request] = vi.mocked(attestLockfileTool.handler).mock.calls[0]
    return (request as { lockfilePath: string }).lockfilePath
  }

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-lockfile-dir-')))
    originalCwd = process.cwd()
    vi.mocked(spawn).mockReset()
    vi.mocked(attestLockfileTool.handler).mockReset()
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({ status: 'attested' } as never)
    vi.stubEnv('XDG_CONFIG_HOME', path.join(root, 'xdg'))
    vi.stubEnv('AUPM_DONATE', '')
    vi.stubEnv('AUPM_DONOR_MNEMONIC', '')
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
  })

  afterEach(() => {
    logSpy.mockRestore()
    vi.unstubAllEnvs()
    process.chdir(originalCwd)
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('npm: uses the parent lockfile when the folder has no package.json', async () => {
    touch('package.json')
    const lockfile = touch('package-lock.json')

    const lines = await runIn('child', 'npm', ['install', 'ms@2.1.3'])

    expect(attestedPath()).toBe(lockfile)
    expect(lines).toContain(`aupm: the review summary counts ${lockfile}.`)
  })

  it('npm: uses a parent with node_modules and no package.json', async () => {
    fs.mkdirSync(path.join(root, 'node_modules'))
    const lockfile = touch('package-lock.json')

    await runIn('child', 'npm', ['install'])

    expect(attestedPath()).toBe(lockfile)
  })

  it('npm: a workspace subpackage uses the root lockfile', async () => {
    fs.mkdirSync(path.join(root, 'pkgs', 'a'), { recursive: true })
    fs.writeFileSync(path.join(root, 'package.json'), '{"workspaces":["pkgs/*"]}')
    touch('pkgs/a/package.json')
    const lockfile = touch('package-lock.json')

    const lines = await runIn('pkgs/a', 'npm', ['install'])

    expect(attestedPath()).toBe(lockfile)
    expect(lines).toContain(`aupm: the review summary counts ${lockfile}.`)
  })

  it('npm: uses the child lockfile when the child has its own package.json', async () => {
    touch('package.json')
    touch('package-lock.json')
    touch('child/package.json')
    const lockfile = touch('child/package-lock.json')

    const lines = await runIn('child', 'npm', ['install'])

    expect(attestedPath()).toBe(lockfile)
    expect(lines.some((line) => line.includes('the review summary counts'))).toBe(false)
  })

  it('npm: a child package.json without a lockfile does not use the parent lockfile', async () => {
    touch('package.json')
    touch('package-lock.json')
    touch('child/package.json')

    const lines = await runIn('child', 'npm', ['install'])

    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
    expect(lines).toContain(
      `aupm: no package-lock.json in ${path.join(root, 'child')} (the folder that npm used). ` +
        'AuPM prints no review summary.',
    )
  })

  it.each([
    ['--prefix <dir>', (dir: string) => ['--prefix', dir]],
    ['--prefix=<dir>', (dir: string) => [`--prefix=${dir}`]],
    ['-C <dir>', (dir: string) => ['-C', dir]],
  ])('npm: %s wins over the walk', async (_name, flag) => {
    touch('package.json')
    touch('package-lock.json')
    touch('other/package-lock.json')
    const other = path.join(root, 'other')

    await runIn('child', 'npm', ['install', ...flag(other)])

    expect(attestedPath()).toBe(path.join(other, 'package-lock.json'))
  })

  it('npm: a relative --prefix is relative to the current folder', async () => {
    touch('child/sub/package-lock.json')

    await runIn('child', 'npm', ['install', '--prefix', 'sub'])

    expect(attestedPath()).toBe(path.join(root, 'child', 'sub', 'package-lock.json'))
  })

  it('npm: ignores --prefix after a literal --', async () => {
    touch('package.json')
    const lockfile = touch('package-lock.json')

    await runIn('child', 'npm', ['install', '--', '--prefix', '/nowhere'])

    expect(attestedPath()).toBe(lockfile)
  })

  it('pnpm: a workspace subpackage uses the root lockfile', async () => {
    touch('pnpm-workspace.yaml')
    touch('package.json')
    touch('pk/package.json')
    const lockfile = touch('pnpm-lock.yaml')

    const lines = await runIn('pk/src', 'pnpm', ['install'])

    expect(attestedPath()).toBe(lockfile)
    expect(lines).toContain(`aupm: the review summary counts ${lockfile}.`)
  })

  it('pnpm: without a workspace file, uses the nearest package.json folder', async () => {
    touch('package.json')
    const lockfile = touch('pnpm-lock.yaml')

    await runIn('x/y', 'pnpm', ['install'])

    expect(attestedPath()).toBe(lockfile)
  })

  it.each([
    ['--dir <dir>', (dir: string) => ['--dir', dir]],
    ['--dir=<dir>', (dir: string) => [`--dir=${dir}`]],
    ['-C <dir>', (dir: string) => ['-C', dir]],
  ])('pnpm: %s moves the start folder', async (_name, flag) => {
    touch('app/package.json')
    const lockfile = touch('app/pnpm-lock.yaml')

    await runIn('elsewhere', 'pnpm', ['install', ...flag(path.join(root, 'app'))])

    expect(attestedPath()).toBe(lockfile)
  })

  it('npm: prints one line and no summary when npm prefix fails', async () => {
    touch('package.json')
    touch('package-lock.json')
    vi.stubEnv('PATH', path.join(root, 'no-npm-here'))

    const lines = await runIn('child', 'npm', ['install'])

    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
    expect(lines).toEqual([
      'aupm: AuPM could not find the folder that npm used. AuPM prints no review summary.',
    ])
  })

  it('names the folder when no lockfile exists anywhere', async () => {
    touch('package.json')

    const lines = await runIn('child', 'npm', ['install'])

    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
    expect(lines).toContain(
      `aupm: no package-lock.json in ${root} (the folder that npm used). ` +
        'AuPM prints no review summary.',
    )
  })

  it('names the current folder when no package.json exists up to the root', async () => {
    const lines = await runIn('child', 'pnpm', ['install'])

    expect(lines).toContain(
      `aupm: no pnpm-lock.yaml in ${path.join(root, 'child')} (the folder that pnpm used). ` +
        'AuPM prints no review summary.',
    )
  })

  it('stops at the filesystem root', async () => {
    const { findLockfileDir } = await import('./npm-wrapper.js')

    const found = await findLockfileDir('pnpm', [], path.parse(root).root)

    expect(found).toBe(path.parse(root).root)
  })
})
