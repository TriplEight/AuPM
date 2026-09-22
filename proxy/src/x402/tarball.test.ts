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

  // Defect pin: normalizeTarballPath used to strip only the leading `/` and
  // decode %40/%2f, so it never collapsed a duplicate slash or stripped a
  // trailing slash. `@x402-avm/core`'s own route matcher does both, so the
  // two disagreed on these spellings: a `//` produced a bogus name with a
  // trailing slash (silently serving a reviewed tarball for free), and a
  // trailing `/` made isTarballPath return false (charging for an
  // unreviewed one). Fixed by mirroring the matcher's normalizePath exactly.
  test.each([
    ['duplicate slash before /-/', '/lodash//-/lodash-4.17.21.tgz'],
    ['duplicate slash after /-/', '/lodash/-//lodash-4.17.21.tgz'],
    ['trailing slash', '/lodash/-/lodash-4.17.21.tgz/'],
    ['leading double slash', '//lodash/-/lodash-4.17.21.tgz'],
    ['duplicate slash combined with %40 scope encoding', '/%40scope//pkg/-/pkg-1.0.0.tgz'],
    ['trailing slash combined with %2F separator encoding', '/@scope%2Fpkg/-/pkg-1.0.0.tgz/'],
  ])('%s still matches as a tarball path', (_label, path) => {
    expect(isTarballPath(path)).toBe(true)
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

  // Defect pin (same as the isTarballPath table above): a duplicate slash or
  // a trailing slash must resolve to the same name and version as the
  // canonical path, never to a name with a stray slash in it.
  test.each([
    ['canonical', '/lodash/-/lodash-4.17.21.tgz'],
    ['duplicate slash before /-/', '/lodash//-/lodash-4.17.21.tgz'],
    ['duplicate slash after /-/', '/lodash/-//lodash-4.17.21.tgz'],
    ['trailing slash', '/lodash/-/lodash-4.17.21.tgz/'],
    ['leading double slash', '//lodash/-/lodash-4.17.21.tgz'],
  ])('%s resolves to name "lodash", version "4.17.21"', (_label, path) => {
    expect(parseTarballPath(path)).toEqual({ name: 'lodash', version: '4.17.21' })
  })
})

describe('tarballFreeTierHook', () => {
  // `donateHeader` mirrors what a request's X-SPM-Donate header decoded to;
  // omit it for "no header sent" (mirrors HTTPAdapter#getHeader returning
  // undefined for a missing header).
  const ctx = (path: string, donateHeader?: string) => ({
    adapter: {
      getHeader: (name: string) =>
        name.toLowerCase() === 'x-spm-donate' ? donateHeader : undefined,
    } as never,
    path,
    method: 'GET',
  })

  test('grants access for an unreviewed tarball', async () => {
    const result = await tarballFreeTierHook(ctx('/lodash/-/lodash-4.17.21.tgz'), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  test('grants access for an unreviewed tarball even with X-SPM-Donate: 1', async () => {
    const result = await tarballFreeTierHook(ctx('/lodash/-/lodash-4.17.21.tgz', '1'), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  test('grants access for a reviewed tarball with no X-SPM-Donate header', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx('/lodash/-/lodash-4.17.21.tgz'), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  // Only the exact value "1" opts in — CLAUDE.md invariant 4: "X-SPM-Donate: 0
  // on an attestation route gets a free partial attestation", and the same
  // rule applies to the tarball route: any other value stays free.
  test('grants access for a reviewed tarball with X-SPM-Donate: 0', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx('/lodash/-/lodash-4.17.21.tgz', '0'), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  test('falls through to normal payment flow for a reviewed tarball with X-SPM-Donate: 1', async () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx('/lodash/-/lodash-4.17.21.tgz', '1'), {} as never)
    expect(result).toBeUndefined()
  })

  test('grants access for a reviewed scoped tarball at a different, unreviewed version', async () => {
    setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx('/@scope/pkg/-/pkg-1.0.1.tgz'), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  // Paywall-bypass regression: every accepted encoding of a reviewed,
  // scoped package's tarball path must fall through to payment when the
  // request opts in with X-SPM-Donate: 1 (never grant free access in that
  // case). WARNING: never relax this — a defect here hands a reviewed
  // tarball out for free even when the caller asked to pay for it.
  test.each([
    ['literal slash', '/@scope/pkg/-/pkg-1.0.0.tgz'],
    ['%40-encoded scope only', '/%40scope/pkg/-/pkg-1.0.0.tgz'],
    ['%2F-encoded separator only', '/@scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['%2f-encoded separator only (lowercase)', '/@scope%2fpkg/-/pkg-1.0.0.tgz'],
    ['both encoded', '/%40scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['the /-/ separator itself also encoded', '/%40scope%2Fpkg%2F-%2Fpkg-1.0.0.tgz'],
  ])(
    '%s: a reviewed scoped tarball with X-SPM-Donate: 1 never grants free access',
    async (_label, path) => {
      setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
      const result = await tarballFreeTierHook(ctx(path, '1'), {} as never)
      expect(result).toBeUndefined()
    },
  )

  // Companion case: the same encodings, reviewed, with no donate header —
  // must grant free access (SPEC §10.4: npm install can never pay a 402).
  test.each([
    ['literal slash', '/@scope/pkg/-/pkg-1.0.0.tgz'],
    ['%40-encoded scope only', '/%40scope/pkg/-/pkg-1.0.0.tgz'],
    ['%2F-encoded separator only', '/@scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['%2f-encoded separator only (lowercase)', '/@scope%2fpkg/-/pkg-1.0.0.tgz'],
    ['both encoded', '/%40scope%2Fpkg/-/pkg-1.0.0.tgz'],
    ['the /-/ separator itself also encoded', '/%40scope%2Fpkg%2F-%2Fpkg-1.0.0.tgz'],
  ])(
    '%s: a reviewed scoped tarball with no donate header grants free access',
    async (_label, path) => {
      setStatus('@scope/pkg', '1.0.0', 'COMMUNITY_REVIEWED', null, null)
      const result = await tarballFreeTierHook(ctx(path), {} as never)
      expect(result).toEqual({ grantAccess: true })
    },
  )

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

  // Defect pin, hook level: the same duplicate-slash and trailing-slash
  // spellings that made isTarballPath/parseTarballPath disagree with the
  // route matcher must resolve identically through the hook — a reviewed
  // package requested with X-SPM-Donate: 1 never grants free access, in
  // any spelling.
  test.each([
    ['canonical', '/lodash/-/lodash-4.17.21.tgz'],
    ['duplicate slash before /-/', '/lodash//-/lodash-4.17.21.tgz'],
    ['duplicate slash after /-/', '/lodash/-//lodash-4.17.21.tgz'],
    ['trailing slash', '/lodash/-/lodash-4.17.21.tgz/'],
    ['leading double slash', '//lodash/-/lodash-4.17.21.tgz'],
  ])(
    '%s: a reviewed tarball with X-SPM-Donate: 1 never grants free access',
    async (_label, path) => {
      setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
      const result = await tarballFreeTierHook(ctx(path, '1'), {} as never)
      expect(result).toBeUndefined()
    },
  )

  // Companion case: the same spellings, reviewed, with no donate header —
  // must grant free access.
  test.each([
    ['canonical', '/lodash/-/lodash-4.17.21.tgz'],
    ['duplicate slash before /-/', '/lodash//-/lodash-4.17.21.tgz'],
    ['duplicate slash after /-/', '/lodash/-//lodash-4.17.21.tgz'],
    ['trailing slash', '/lodash/-/lodash-4.17.21.tgz/'],
    ['leading double slash', '//lodash/-/lodash-4.17.21.tgz'],
  ])('%s: a reviewed tarball with no donate header grants free access', async (_label, path) => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const result = await tarballFreeTierHook(ctx(path), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })

  // Companion negative control: the same spellings for an unreviewed
  // package must still grant free access.
  test.each([
    ['canonical', '/lodash/-/lodash-4.17.21.tgz'],
    ['duplicate slash before /-/', '/lodash//-/lodash-4.17.21.tgz'],
    ['duplicate slash after /-/', '/lodash/-//lodash-4.17.21.tgz'],
    ['trailing slash', '/lodash/-/lodash-4.17.21.tgz/'],
    ['leading double slash', '//lodash/-/lodash-4.17.21.tgz'],
  ])('%s: an unreviewed tarball still grants free access', async (_label, path) => {
    const result = await tarballFreeTierHook(ctx(path), {} as never)
    expect(result).toEqual({ grantAccess: true })
  })
})
