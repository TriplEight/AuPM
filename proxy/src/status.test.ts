// proxy/src/status.test.ts
import { beforeEach, describe, expect, test } from 'vitest'
import db from './db.js'
import { getStatusOrUnreviewed, isFree, isReviewedWithIntegrity, setStatus } from './status.js'

beforeEach(() => {
  db.exec('DELETE FROM audit_status')
})

describe('status store', () => {
  test('returns UNREVIEWED for unknown pkg+version', () => {
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(row.status).toBe('UNREVIEWED')
  })

  test('isFree returns true for UNREVIEWED', () => {
    expect(isFree('UNREVIEWED')).toBe(true)
  })

  test('isFree returns false for COMMUNITY_REVIEWED', () => {
    expect(isFree('COMMUNITY_REVIEWED')).toBe(false)
  })

  test('setStatus persists and reads back', () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', '0xAUD', 'txid123')
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(row.status).toBe('COMMUNITY_REVIEWED')
    expect(row.auditor_addr).toBe('0xAUD')
    expect(row.attest_txid).toBe('txid123')
  })

  test('auto-reset: different version defaults to UNREVIEWED', () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', null, null)
    const row = getStatusOrUnreviewed('lodash', '4.17.22')
    expect(row.status).toBe('UNREVIEWED')
  })

  test('upsert: updating status works', () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', 'aud1', 'tx1')
    setStatus('lodash', '4.17.21', 'PEER_REVIEWED', 'aud2', 'tx2')
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(row.status).toBe('PEER_REVIEWED')
    expect(row.auditor_addr).toBe('aud2')
  })

  test('a fresh unknown row has no stored integrity', () => {
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(row.integrity).toBeNull()
  })

  test('setStatus persists and reads back a stored integrity', () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', '0xAUD', 'txid123', 'sha512-known-good')
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(row.integrity).toBe('sha512-known-good')
  })

  test('setStatus without an integrity argument stores null, not a placeholder', () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', '0xAUD', 'txid123')
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(row.integrity).toBeNull()
  })

  test('isReviewedWithIntegrity: false for UNREVIEWED even with a stored integrity', () => {
    setStatus('lodash', '4.17.21', 'UNREVIEWED', null, null, 'sha512-known-good')
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(isReviewedWithIntegrity(row)).toBe(false)
  })

  test('isReviewedWithIntegrity: false for a paid-tier row with no stored integrity', () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', 'aud', 'tx')
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(row.integrity).toBeNull()
    expect(isReviewedWithIntegrity(row)).toBe(false)
  })

  test('isReviewedWithIntegrity: true for a paid-tier row with a stored integrity', () => {
    setStatus('lodash', '4.17.21', 'COMMUNITY_REVIEWED', 'aud', 'tx', 'sha512-known-good')
    const row = getStatusOrUnreviewed('lodash', '4.17.21')
    expect(isReviewedWithIntegrity(row)).toBe(true)
  })
})
