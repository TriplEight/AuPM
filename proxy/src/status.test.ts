// proxy/src/status.test.ts
import { beforeEach, describe, expect, test } from 'vitest'
import db from './db.js'
import { getStatusOrUnreviewed, isFree, setStatus } from './status.js'

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
})
