// mcp/src/lockfile-entries.test.ts
import { describe, expect, it } from 'vitest'
import { countLockfileEntries, LockfileParseError } from './lockfile-entries.js'

describe('countLockfileEntries', () => {
  it('counts the packages map keys, excluding the root ""', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': { name: 'root-pkg', version: '1.0.0' },
        'node_modules/ms': { version: '2.1.3' },
        'node_modules/lodash': { version: '4.17.21' },
      },
    })

    expect(countLockfileEntries(lockfile)).toBe(2)
  })

  it('counts entries from raw bytes the same way as from a string', () => {
    const lockfile = JSON.stringify({
      lockfileVersion: 2,
      packages: { '': {}, 'node_modules/ms': { version: '2.1.3' } },
    })

    expect(countLockfileEntries(Buffer.from(lockfile, 'utf8'))).toBe(1)
  })

  it('returns 0 for a lockfile with only the root entry', () => {
    const lockfile = JSON.stringify({ lockfileVersion: 3, packages: { '': {} } })
    expect(countLockfileEntries(lockfile)).toBe(0)
  })

  it('throws LockfileParseError for invalid JSON', () => {
    expect(() => countLockfileEntries('not json')).toThrow(LockfileParseError)
  })

  it('throws LockfileParseError when there is no packages map', () => {
    expect(() => countLockfileEntries(JSON.stringify({ lockfileVersion: 3 }))).toThrow(
      LockfileParseError,
    )
  })

  it('throws LockfileParseError when packages is not an object', () => {
    expect(() =>
      countLockfileEntries(JSON.stringify({ lockfileVersion: 3, packages: [] })),
    ).toThrow(LockfileParseError)
  })
})
