// proxy/src/x402/tarball.test.ts
import { beforeEach, describe, expect, test } from 'vitest'
import db from '../db.js'
import { setStatus } from '../status.js'
import { isTarballPath, parseTarballPath, tarballFreeTierHook } from './tarball.js'

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

  test('is a no-op for non-tarball paths', async () => {
    const result = await tarballFreeTierHook(ctx('/lodash'), {} as never)
    expect(result).toBeUndefined()
  })
})
