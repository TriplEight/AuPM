// cli/src/npm-prefix.test.ts
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { prefixLocationArgs, runNpmPrefix } from './npm-prefix.js'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

function fakeNpm(): EventEmitter & { stdout: EventEmitter } {
  return Object.assign(new EventEmitter(), { stdout: new EventEmitter() })
}

describe('prefixLocationArgs', () => {
  it.each([
    [
      ['install', '--prefix', '/a'],
      ['--prefix', '/a'],
    ],
    [['install', '--prefix=/a'], ['--prefix=/a']],
    [
      ['install', '-C', '/a'],
      ['-C', '/a'],
    ],
    [['install', '-w', 'pkg', '--workspace=x'], []],
    [['install', '--', '--prefix', '/a'], []],
    [['install', '--prefix'], []],
  ])('%j -> %j', (args, expected) => {
    expect(prefixLocationArgs(args)).toEqual(expected)
  })
})

describe('runNpmPrefix', () => {
  beforeEach(() => {
    vi.mocked(spawn).mockReset()
  })

  it('returns the trimmed stdout and passes only the location flags', async () => {
    const child = fakeNpm()
    vi.mocked(spawn).mockReturnValue(child as never)

    const result = runNpmPrefix(['install', 'ms', '--prefix', '/p'])
    child.stdout.emit('data', Buffer.from('/root\n'))
    child.emit('close', 0, null)

    expect(await result).toBe('/root')
    expect(spawn).toHaveBeenCalledWith(
      'npm',
      ['prefix', '--prefix', '/p'],
      expect.objectContaining({
        env: expect.objectContaining({ npm_config_registry: expect.any(String) }),
      }),
    )
  })

  it('returns null when npm exits non-zero', async () => {
    const child = fakeNpm()
    vi.mocked(spawn).mockReturnValue(child as never)

    const result = runNpmPrefix([])
    child.stdout.emit('data', Buffer.from('/root\n'))
    child.emit('close', 1, null)

    expect(await result).toBeNull()
  })

  it('returns null when npm prints nothing', async () => {
    const child = fakeNpm()
    vi.mocked(spawn).mockReturnValue(child as never)

    const result = runNpmPrefix([])
    child.emit('close', 0, null)

    expect(await result).toBeNull()
  })

  it('returns null when npm cannot start', async () => {
    const child = fakeNpm()
    vi.mocked(spawn).mockReturnValue(child as never)

    const result = runNpmPrefix([])
    child.emit('error', new Error('ENOENT'))

    expect(await result).toBeNull()
  })

  it('returns null when spawn throws', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('boom')
    })

    expect(await runNpmPrefix([])).toBeNull()
  })
})
