// proxy/src/x402/tarball.test.ts
//
// CAUTION: this file gets its own SQLite file via SQLITE_PATH, set before
// the dynamic import below (same trick as proxy/src/claims/ledger.test.ts).
// Without per-file isolation, vitest's parallel test files race on the same
// physical database and writes from one file can be wiped by another file's
// beforeEach mid-test.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-tarball-test-${randomUUID()}.db`)

const { default: db } = await import('../db.js')
const { setStatus } = await import('../status.js')
const { isTarballPath, parseTarballPath, tarballFreeTierHook } = await import('./tarball.js')

beforeEach(() => {
  db.exec('DELETE FROM audit_status')
})

describe('isTarballPath', () => {
  test('matches an unscoped tarball path', () => {
    expect(isTarballPath('/lodash/-/lodash-4.17.21.tgz')).toBe(true)
  })

  test('matches a scoped tarball path', () => {
    expect(isTarballPath('/@scope/pkg/-/pkg-1.0.0.tgz')).toBe(true)
  })

  test('rejects a metadata path', () => {
    expect(isTarballPath('/lodash')).toBe(false)
  })

  // Defect pin: isTarballPath tested the raw path for a literal `/-/`, while
  // parseTarballPath decoded %40/%2f first. The two disagreed, so a caller
  // who also percent-encodes the `/-/` separator itself skipped the
  // free-tier hook (invariant 4: unreviewed never returns 402). Both
  // functions must agree — they now share normalizeTarballPath.
  test('matches a scoped tarball path with the /-/ separator itself percent-encoded', () => {
    expect(isTarballPath('/%40scope%2Fpkg%2F-%2Fpkg-1.0.0.tgz')).toBe(true)
  })
})

describe('parseTarballPath', () => {
  test('parses an unscoped tarball path', () => {
    expect(parseTarballPath('/lodash/-/lodash-4.17.21.tgz')).toEqual({
      name: 'lodash',
      version: '4.17.21',
    })
  })

  test('parses a scoped tarball path into name "@scope/name" plus the correct version', () => {
    expect(parseTarballPath('/@scope/pkg/-/pkg-1.0.0.tgz')).toEqual({
      name: '@scope/pkg',
      version: '1.0.0',
    })
  })

  test('parses a %40-encoded scope', () => {
    expect(parseTarballPath('/%40scope/pkg/-/pkg-2.3.4.tgz')).toEqual({
      name: '@scope/pkg',
      version: '2.3.4',
    })
  })

  // Defect pin: mcp/src/tools/install.ts builds the request path with the
  // scope separator encoded as %2F (`@scope%2Fname`), a combination the old
  // parser (which only ever decoded %40) never matched to the stored
  // `@scope/name` row. That silently served a reviewed, paid tarball for
  // free. Every accepted encoding below must resolve to the identical name.
  test.each([
    ['literal slash', '/@scope/pkg/-/pkg-1.0.0.tgz'],
    ['%40-encoded scope only', '/%40scope/pkg/-/pkg-1.0.0.tgz'],
    ['%2F-encoded separator only (uppercase)', '/@scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['%2f-encoded separator only (lowercase)', '/@scope%2fpkg/-/pkg-1.0.0.tgz'],
    ['both encoded, uppercase %2F', '/%40scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['both encoded, lowercase %2f', '/%40scope%2fpkg/-/pkg-1.0.0.tgz'],
    ['the /-/ separator itself also encoded', '/%40scope%2Fpkg%2F-%2Fpkg-1.0.0.tgz'],
  ])('%s resolves to the same name and version', (_label, path) => {
    expect(parseTarballPath(path)).toEqual({ name: '@scope/pkg', version: '1.0.0' })
  })
})

describe('tarballFreeTierHook', () => {
  const ctx = (path: string) => ({
    adapter: {} as never,
    path,
    method: 'GET',
  })

  test('grants access for an unreviewed tarball', async () => {
    const result = await tarballFreeTierHook(ctx('/lodash/-/lodash-4.17.21.tgz'), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  test('falls through to normal payment flow for a reviewed tarball', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx('/lodash/-/lodash-4.17.21.tgz'), {} as never)
    expect(result).toBeUndefined()
  })

  test('grants access for a reviewed scoped tarball at a different, unreviewed version', async () => {
    setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx('/@scope/pkg/-/pkg-1.0.1.tgz'), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  // Paywall-bypass regression: every accepted encoding of a reviewed,
  // scoped package's tarball path must fall through to payment (never grant
  // free access). WARNING: never relax this — a defect here hands a
  // reviewed tarball out for free.
  test.each([
    ['literal slash', '/@scope/pkg/-/pkg-1.0.0.tgz'],
    ['%40-encoded scope only', '/%40scope/pkg/-/pkg-1.0.0.tgz'],
    ['%2F-encoded separator only', '/@scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['%2f-encoded separator only (lowercase)', '/@scope%2fpkg/-/pkg-1.0.0.tgz'],
    ['both encoded', '/%40scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['the /-/ separator itself also encoded', '/%40scope%2Fpkg%2F-%2Fpkg-1.0.0.tgz'],
  ])('%s: a reviewed scoped tarball never grants free access', async (_label, path) => {
    setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx(path), {} as never)
    expect(result).toBeUndefined()
  })

  // Companion case: the same encodings for an *unreviewed* scoped package
  // must still grant free access — the fix must not turn the free tier
  // paid by accident. This is the invariant-4 negative control: the
  // encoded-separator row is the one that regressed (isTarballPath and
  // parseTarballPath disagreed on the canonical form, so the hook never
  // saw this as a tarball path and fell through to the payment gate).
  test.each([
    ['literal slash', '/@scope/pkg/-/pkg-1.0.0.tgz'],
    ['%40-encoded scope only', '/%40scope/pkg/-/pkg-1.0.0.tgz'],
    ['%2F-encoded separator only', '/@scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['%2f-encoded separator only (lowercase)', '/@scope%2fpkg/-/pkg-1.0.0.tgz'],
    ['both encoded', '/%40scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['the /-/ separator itself also encoded', '/%40scope%2Fpkg%2F-%2Fpkg-1.0.0.tgz'],
  ])('%s: an unreviewed scoped tarball still grants free access', async (_label, path) => {
    const result = await tarballFreeTierHook(ctx(path), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  test('is a no-op for non-tarball paths', async () => {
    const result = await tarballFreeTierHook(ctx('/lodash'), {} as never)
    expect(result).toBeUndefined()
  })
})
