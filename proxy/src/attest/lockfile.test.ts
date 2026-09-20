// proxy/src/attest/lockfile.test.ts
import { createHash } from 'node:crypto'
import { beforeEach, describe, expect, test } from 'vitest'
import db from '../db.js'
import { setStatus } from '../status.js'
import { analyzeLockfile, LOCKFILE_MAX_BYTES, LOCKFILE_MAX_ENTRIES } from './lockfile.js'

const encoder = new TextEncoder()

function lockfileBytes(doc: unknown): Uint8Array {
  return encoder.encode(JSON.stringify(doc))
}

function npmEntry(version: string, integrity = 'sha512-abc') {
  return {
    version,
    resolved: `https://registry.npmjs.org/pkg/-/pkg-${version}.tgz`,
    integrity,
  }
}

beforeEach(() => {
  db.exec('DELETE FROM audit_status')
})

describe('analyzeLockfile — validation', () => {
  test('rejects a body over the byte limit', () => {
    const huge = new Uint8Array(LOCKFILE_MAX_BYTES + 1)
    const result = analyzeLockfile(huge)
    expect(result.ok).toBe(false)
  })

  test('rejects malformed JSON', () => {
    const result = analyzeLockfile(encoder.encode('{ not json'))
    expect(result.ok).toBe(false)
  })

  test('rejects lockfileVersion 1', () => {
    const result = analyzeLockfile(lockfileBytes({ lockfileVersion: 1, packages: {} }))
    expect(result.ok).toBe(false)
  })

  test('rejects a missing "packages" object', () => {
    const result = analyzeLockfile(lockfileBytes({ lockfileVersion: 3 }))
    expect(result.ok).toBe(false)
  })

  test('rejects more than 10,000 entries', () => {
    const packages: Record<string, unknown> = {}
    for (let i = 0; i < LOCKFILE_MAX_ENTRIES + 1; i++) {
      packages[`node_modules/pkg${i}`] = npmEntry('1.0.0')
    }
    const result = analyzeLockfile(lockfileBytes({ lockfileVersion: 3, packages }))
    expect(result.ok).toBe(false)
  })

  test('accepts lockfileVersion 2 and 3', () => {
    for (const v of [2, 3]) {
      const result = analyzeLockfile(lockfileBytes({ lockfileVersion: v, packages: {} }))
      expect(result.ok).toBe(true)
    }
  })
})

describe('analyzeLockfile — classification', () => {
  test('an unreviewed package is counted but absent from packages[]', () => {
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3') },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.total).toBe(1)
    expect(result.analysis.summary.unreviewed).toBe(1)
    expect(result.analysis.summary.reviewed).toBe(0)
    expect(result.analysis.packages).toHaveLength(0)
  })

  test('excludes the unreviewed majority: 1 reviewed + 200 unreviewed', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc')
    const packages: Record<string, unknown> = { 'node_modules/ms': npmEntry('2.1.3') }
    for (let i = 0; i < 200; i++) {
      packages[`node_modules/unreviewed-pkg-${i}`] = npmEntry('1.0.0')
    }
    const result = analyzeLockfile(lockfileBytes({ lockfileVersion: 3, packages }))
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.total).toBe(201)
    expect(result.analysis.summary.unreviewed).toBe(200)
    expect(result.analysis.summary.reviewed).toBe(1)
    expect(result.analysis.packages).toHaveLength(1)
    expect(result.analysis.packages[0]?.name).toBe('ms')
    expect(result.analysis.packages[0]?.tier).toBe('COMMUNITY_REVIEWED')
    expect(result.analysis.reviewedPackageRefs).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'AUDITOR_ADDR' },
    ])
  })

  test('a scoped package name is parsed from its node_modules key', () => {
    setStatus('@babel/core', '7.25.2', 'COMMUNITY_REVIEWED', null, null, 'sha512-abc')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: { 'node_modules/@babel/core': npmEntry('7.25.2') },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.packages[0]?.name).toBe('@babel/core')
  })

  test('a git resolved entry is UNRESOLVABLE, never reviewed', () => {
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/gitdep': {
            version: '1.0.0',
            resolved: 'git+https://github.com/example/gitdep.git#abc123',
          },
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.unresolvable).toBe(1)
    expect(result.analysis.packages[0]?.tier).toBe('UNRESOLVABLE')
  })

  test('a non-npm tarball URL is UNRESOLVABLE', () => {
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/tarballdep': {
            version: '1.0.0',
            resolved: 'https://github.com/example/tarballdep/archive/1.0.0.tar.gz',
          },
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.packages[0]?.tier).toBe('UNRESOLVABLE')
  })

  test('a reviewed row with no stored integrity resolves to UNREVIEWED (honesty rule)', () => {
    // No integrity passed to setStatus: this review is incomplete. The
    // default lookup reads the store directly (no injected lookup here).
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3') },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.reviewed).toBe(0)
    expect(result.analysis.summary.unreviewed).toBe(1)
    // The package must not appear as reviewed in the statement at all.
    expect(result.analysis.packages).toHaveLength(0)
    expect(result.analysis.packages.some((p) => p.name === 'ms')).toBe(false)
    expect(result.analysis.reviewedPackageRefs).toHaveLength(0)
  })

  test('a reviewed row with a stored integrity equal to the lockfile entry reports the reviewed tier and integrityMatch: true', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3', 'sha512-abc') },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.reviewed).toBe(1)
    expect(result.analysis.packages[0]?.tier).toBe('COMMUNITY_REVIEWED')
    expect(result.analysis.packages[0]?.integrityMatch).toBe(true)
  })

  test('a reviewed row whose stored integrity differs from the lockfile entry reports INTEGRITY_MISMATCH via the default (DB-backed) lookup', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-known-good')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': npmEntry('2.1.3', 'sha512-tampered-hash') },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.reviewed).toBe(0)
    expect(result.analysis.summary.integrityMismatch).toBe(1)
    expect(result.analysis.packages[0]?.tier).toBe('INTEGRITY_MISMATCH')
    expect(result.analysis.packages[0]?.tier).not.toBe('COMMUNITY_REVIEWED')
    expect(result.analysis.packages[0]?.integrityMatch).toBe(false)
    expect(result.analysis.reviewedPackageRefs).toHaveLength(0)
  })

  test('a reviewed package whose declared integrity does not match the known-good value is INTEGRITY_MISMATCH, never COMMUNITY_REVIEWED', () => {
    setStatus('tampered', '1.0.0', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/tampered': npmEntry('1.0.0', 'sha512-tampered-hash'),
        },
      }),
      (pkg, version) => (pkg === 'tampered' && version === '1.0.0' ? 'sha512-known-good' : null),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.integrityMismatch).toBe(1)
    expect(result.analysis.summary.reviewed).toBe(0)
    expect(result.analysis.packages[0]?.tier).toBe('INTEGRITY_MISMATCH')
    expect(result.analysis.packages[0]?.tier).not.toBe('COMMUNITY_REVIEWED')
    // A mismatched review never earns attribution.
    expect(result.analysis.reviewedPackageRefs).toHaveLength(0)
  })

  test('a workspace symlink entry (link: true) is skipped entirely', () => {
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/linked-workspace-pkg': { version: '1.0.0', link: true },
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.total).toBe(0)
    expect(result.analysis.packages).toHaveLength(0)
  })

  test('the root entry ("") is never counted', () => {
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: { '': { name: 'my-project', version: '1.0.0' } },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.total).toBe(0)
  })
})

describe('analyzeLockfile — digest', () => {
  test('sha256 is computed over the exact raw body bytes, not a re-serialisation', () => {
    const doc = { lockfileVersion: 3, packages: { 'node_modules/ms': npmEntry('2.1.3') } }
    const rawBody = lockfileBytes(doc)
    const result = analyzeLockfile(rawBody)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const expected = createHash('sha256').update(rawBody).digest('hex')
    expect(result.analysis.sha256).toBe(expected)
  })
})
