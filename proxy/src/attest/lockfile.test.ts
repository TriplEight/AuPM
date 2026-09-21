// proxy/src/attest/lockfile.test.ts
//
// CAUTION: this file gets its own SQLite file via SQLITE_PATH, set before
// the dynamic import below (same trick as proxy/src/claims/ledger.test.ts).
// Without per-file isolation, vitest's parallel test files race on the same
// physical database and writes from one file can be wiped by another file's
// beforeEach mid-test.
import { createHash, randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'
import type { Attribution } from './attribution.js'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-lockfile-test-${randomUUID()}.db`)

const { default: db } = await import('../db.js')
const { setStatus } = await import('../status.js')
const { analyzeLockfile, LOCKFILE_MAX_BYTES, LOCKFILE_MAX_ENTRIES } = await import('./lockfile.js')
const { buildAccrualInputs } = await import('../claims/attribution-rules.js')

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
    // AUDITOR_ADDR is the on-chain attesting address — a different fact
    // from the reviewer's GitHub login (7th argument). reviewedPackageRefs'
    // `auditor` must carry the "github:<login>" identity the ledger keys
    // on, never this address.
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc', 'alice')
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
      { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
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

describe('analyzeLockfile — same package at more than one node_modules depth', () => {
  // "$0.02" (CLAUDE.md lockfile-attest price), in integer micro-USDC.
  const LOCKFILE_PRICE_MICRO = 20_000

  function toAttribution(
    refs: { pkg: string; version: string; auditor: string | null }[],
    priceMicro = LOCKFILE_PRICE_MICRO,
  ): Attribution {
    return {
      route: 'lockfile',
      priceMicro,
      packages: refs.map((ref) => ({
        pkg: ref.pkg,
        version: ref.version,
        auditor: ref.auditor,
        maintainer: null,
      })),
    }
  }

  test('a package listed at two node_modules depths collapses to one reviewed ref', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc', 'alice')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3'),
          'node_modules/send/node_modules/ms': npmEntry('2.1.3'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    // Two lockfile entries name one real package. `summary.total` counts
    // distinct packages, the same as `summary.reviewed` — never a raw
    // lockfile-entry count that the buckets below it cannot sum to.
    expect(result.analysis.summary.total).toBe(1)
    expect(result.analysis.reviewedPackageRefs).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
    ])
  })

  test('summary buckets sum to summary.total for a package listed at two depths', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc', 'alice')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3'),
          'node_modules/send/node_modules/ms': npmEntry('2.1.3'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    const { summary } = result.analysis
    expect(
      summary.reviewed + summary.unreviewed + summary.unresolvable + summary.integrityMismatch,
    ).toBe(summary.total)
    expect(summary.total).toBe(1)
    expect(summary.reviewed).toBe(1)
  })

  test('summary.reviewed counts the depth-duplicated package once', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc', 'alice')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3'),
          'node_modules/send/node_modules/ms': npmEntry('2.1.3'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.reviewed).toBe(1)
  })

  test('the signed statement (packages[]) lists the depth-duplicated package once', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc', 'alice')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3'),
          'node_modules/send/node_modules/ms': npmEntry('2.1.3'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.packages).toHaveLength(1)
    expect(result.analysis.packages[0]?.name).toBe('ms')
    expect(result.analysis.packages[0]?.version).toBe('2.1.3')
    expect(result.analysis.packages[0]?.tier).toBe('COMMUNITY_REVIEWED')
  })

  test('the auditor accrues the full per-package share, not half, once depth duplicates are collapsed', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc', 'alice')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3'),
          'node_modules/send/node_modules/ms': npmEntry('2.1.3'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')

    const rows = buildAccrualInputs(toAttribution(result.analysis.reviewedPackageRefs))
    expect(rows).toHaveLength(3) // one row per ledgered role: auditor, maintainer, reviewer

    const auditorRow = rows.find((r) => r.role === 'auditor' && r.pkg === 'ms')
    expect(auditorRow?.amountMicro).toBe(10_000) // (20,000 / 1,000) * 500, the whole auditor share

    const totalMicro = rows.reduce((sum, r) => sum + r.amountMicro, 0)
    expect(totalMicro).toBe(17_000) // (20,000 / 1,000) * (500 + 200 + 150)
  })

  test('the same package at two different versions still yields two reviewed refs', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc', 'alice')
    setStatus('ms', '3.0.0', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID2', 'sha512-def', 'bob')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3', 'sha512-abc'),
          'node_modules/old-dep/node_modules/ms': npmEntry('3.0.0', 'sha512-def'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.reviewed).toBe(2)
    expect(result.analysis.reviewedPackageRefs).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
      { pkg: 'ms', version: '3.0.0', auditor: 'github:bob' },
    ])

    const rows = buildAccrualInputs(toAttribution(result.analysis.reviewedPackageRefs))
    const auditorRows = rows.filter((r) => r.role === 'auditor')
    expect(auditorRows.map((r) => r.amountMicro).sort((a, b) => a - b)).toEqual([5_000, 5_000])
    const totalMicro = rows.reduce((sum, r) => sum + r.amountMicro, 0)
    expect(totalMicro).toBe(17_000)
  })

  test('an existing multi-package lockfile (1 reviewed + 200 unreviewed) still produces the same totals', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID123', 'sha512-abc', 'alice')
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
    expect(result.analysis.reviewedPackageRefs).toEqual([
      { pkg: 'ms', version: '2.1.3', auditor: 'github:alice' },
    ])

    const rows = buildAccrualInputs(toAttribution(result.analysis.reviewedPackageRefs))
    const auditorRow = rows.find((r) => r.role === 'auditor' && r.pkg === 'ms')
    expect(auditorRow?.amountMicro).toBe(10_000)
    const totalMicro = rows.reduce((sum, r) => sum + r.amountMicro, 0)
    expect(totalMicro).toBe(17_000)
  })

  test('several distinct reviewed packages each keep their own ref and split the auditor share evenly', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc', 'alice')
    setStatus(
      'lodash',
      '4.17.21',
      'COMMUNITY_REVIEWED',
      'AUDITOR_ADDR',
      'TXID2',
      'sha512-def',
      'bob',
    )
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3', 'sha512-abc'),
          'node_modules/lodash': npmEntry('4.17.21', 'sha512-def'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.reviewed).toBe(2)
    expect(result.analysis.reviewedPackageRefs).toHaveLength(2)

    const rows = buildAccrualInputs(toAttribution(result.analysis.reviewedPackageRefs))
    const auditorRows = rows.filter((r) => r.role === 'auditor')
    expect(auditorRows.map((r) => r.amountMicro).sort((a, b) => a - b)).toEqual([5_000, 5_000])
    const totalMicro = rows.reduce((sum, r) => sum + r.amountMicro, 0)
    expect(totalMicro).toBe(17_000)
  })

  // CAUTION: two node_modules entries for the same name@version can, in a
  // corrupted or crafted lockfile, disagree on their raw `integrity` field.
  // That is not a harmless duplicate — it is two different tarballs claimed
  // for one identity. The dedup must never merge that into a single
  // reviewed ref; it must fall back to INTEGRITY_MISMATCH for the entry
  // that disagrees, same as any other tampered entry.
  test('duplicate name@version entries with different raw integrity are never merged into one reviewed ref', () => {
    setStatus('ms', '2.1.3', 'COMMUNITY_REVIEWED', 'AUDITOR_ADDR', 'TXID1', 'sha512-abc', 'alice')
    const result = analyzeLockfile(
      lockfileBytes({
        lockfileVersion: 3,
        packages: {
          'node_modules/ms': npmEntry('2.1.3', 'sha512-abc'),
          'node_modules/send/node_modules/ms': npmEntry('2.1.3', 'sha512-different'),
        },
      }),
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.analysis.summary.reviewed).toBe(1)
    expect(result.analysis.summary.integrityMismatch).toBe(1)
    expect(result.analysis.reviewedPackageRefs).toHaveLength(1)
    expect(result.analysis.packages).toHaveLength(2)
    expect(result.analysis.packages.filter((p) => p.tier === 'INTEGRITY_MISMATCH')).toHaveLength(1)
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
