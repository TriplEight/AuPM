import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { checkTool } from './check.js'

describe('check_audit_status', () => {
  beforeEach(() => {
    process.env['SPM_PROXY_URL'] = 'http://localhost:4873'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env['SPM_PROXY_URL']
  })

  it('returns status without making a payment request', async () => {
    const mockStatus = {
      pkg: 'lodash',
      version: '4.17.21',
      status: 'UNREVIEWED',
      auditor_addr: null,
      attest_txid: null,
      ts: null,
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStatus),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await checkTool.handler({ pkg: 'lodash', version: '4.17.21' })

    expect(result.status).toBe('UNREVIEWED')
    expect(result.pkg).toBe('lodash')
    // Exactly one fetch call — no retry, no payment
    expect(mockFetch).toHaveBeenCalledTimes(1)
    const [url, options] = mockFetch.mock.calls[0]! as [string, RequestInit | undefined]
    expect(url).toContain('/api/v1/status/lodash/4.17.21')
    // No request options means no payment header
    expect(options).toBeUndefined()
  })

  it('returns COMMUNITY_REVIEWED status with auditor info', async () => {
    const mockStatus = {
      pkg: 'lodash',
      version: '4.17.21',
      status: 'COMMUNITY_REVIEWED',
      auditor_addr: 'AUDITORADDR',
      attest_txid: 'TXID123',
      ts: 1700000000,
    }
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve(mockStatus),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await checkTool.handler({ pkg: 'lodash', version: '4.17.21' })

    expect(result.status).toBe('COMMUNITY_REVIEWED')
    expect(result.auditor_addr).toBe('AUDITORADDR')
    expect(result.attest_txid).toBe('TXID123')
    // Still only one fetch — no payment triggered even for paid packages
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('encodes scoped packages correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        pkg: '@scope/pkg',
        version: '1.0.0',
        status: 'UNREVIEWED',
        auditor_addr: null,
        attest_txid: null,
        ts: null,
      }),
    })
    vi.stubGlobal('fetch', mockFetch)

    await checkTool.handler({ pkg: '@scope/pkg', version: '1.0.0' })

    const [url] = mockFetch.mock.calls[0]! as [string]
    expect(url).toContain('%40scope')
    expect(url).not.toContain('@')
  })
})
