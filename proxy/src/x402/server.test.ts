// proxy/src/x402/server.test.ts
//
// CAUTION: every facilitator client here is a stub. No test in this file
// performs a network call.
//
// CAUTION: this file also gets its own SQLite file via SQLITE_PATH, set
// before the dynamic import of ./server.js below (same trick as
// proxy/src/claims/ledger.test.ts). Without per-file isolation, vitest's
// parallel test files race on the same physical database and writes from
// one file can be wiped by another file's beforeEach mid-test.

import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import type { FacilitatorClient } from '@x402-avm/core/server'
import type { Network, SupportedResponse } from '@x402-avm/core/types'
import { describe, expect, test } from 'vitest'
import { CAIP2_NETWORK, resolveFeePayer } from '../config.js'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-x402-server-test-${randomUUID()}.db`)

const { boot, buildHttpServer } = await import('./server.js')

const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function supportedWithExact(network: Network, feePayer: string): SupportedResponse {
  return {
    kinds: [{ x402Version: 2, scheme: 'exact', network, extra: { feePayer } }],
    extensions: [],
    signers: {},
  }
}

function supportedWithoutExact(): SupportedResponse {
  return {
    kinds: [
      { x402Version: 2, scheme: 'exact', network: 'eip155:8453', extra: { feePayer: '0xabc' } },
    ],
    extensions: [],
    signers: {},
  }
}

// Same network and scheme as a real match, but missing x402Version — the
// shape a non-conformant facilitator (or a stale fixture) could send.
function supportedWithExactMissingVersion(network: Network, feePayer: string): SupportedResponse {
  const kindWithoutVersion = { scheme: 'exact', network, extra: { feePayer } }
  return {
    kinds: [kindWithoutVersion as unknown as SupportedResponse['kinds'][number]],
    extensions: [],
    signers: {},
  }
}

// Same network and scheme as a real match, but x402Version 1 — the legacy
// protocol version, not the one this proxy's middleware requires.
function supportedWithExactWrongVersion(network: Network, feePayer: string): SupportedResponse {
  return {
    kinds: [{ x402Version: 1, scheme: 'exact', network, extra: { feePayer } }],
    extensions: [],
    signers: {},
  }
}

function stubFacilitatorClient(supported: SupportedResponse): FacilitatorClient {
  return {
    getSupported: async () => supported,
    verify: async () => ({ isValid: true }),
    settle: async () => ({ success: true, transaction: 'stub-txid', network: CAIP2_NETWORK }),
  }
}

describe('boot guard (resolveFeePayer)', () => {
  test('throws when the supported-kinds fixture lacks MainNet exact', () => {
    expect(() => resolveFeePayer(supportedWithoutExact(), CAIP2_NETWORK)).toThrow(
      /does not support scheme "exact"/,
    )
  })

  test('returns the fee payer when the fixture contains it', () => {
    const feePayer = resolveFeePayer(supportedWithExact(CAIP2_NETWORK, FEE_PAYER), CAIP2_NETWORK)
    expect(feePayer).toBe(FEE_PAYER)
  })

  test('throws naming x402Version when a matching kind omits it', () => {
    expect(() =>
      resolveFeePayer(supportedWithExactMissingVersion(CAIP2_NETWORK, FEE_PAYER), CAIP2_NETWORK),
    ).toThrow(/x402Version/)
  })

  test('throws naming x402Version when a matching kind declares version 1', () => {
    expect(() =>
      resolveFeePayer(supportedWithExactWrongVersion(CAIP2_NETWORK, FEE_PAYER), CAIP2_NETWORK),
    ).toThrow(/x402Version/)
  })
})

describe('boot()', () => {
  test('wires an httpServer using a stubbed facilitator client (no network)', async () => {
    const client = stubFacilitatorClient(supportedWithExact(CAIP2_NETWORK, FEE_PAYER))
    const { httpServer, feePayer } = await boot(client)
    expect(feePayer).toBe(FEE_PAYER)
    expect(httpServer).toBeDefined()
  })

  test('rejects when the facilitator does not support the configured network', async () => {
    const client = stubFacilitatorClient(supportedWithoutExact())
    await expect(boot(client)).rejects.toThrow(/does not support scheme "exact"/)
  })
})

describe('buildHttpServer', () => {
  test('attaches the tarball free-tier hook and builds all three paid routes', () => {
    const client = stubFacilitatorClient(supportedWithExact(CAIP2_NETWORK, FEE_PAYER))
    const { httpServer } = buildHttpServer(client, FEE_PAYER)
    expect(httpServer.routes).toBeDefined()
    const keys = Object.keys(httpServer.routes)
    expect(keys).toContain('POST /v1/attest/lockfile')
    expect(keys).toContain('GET /v1/attest')
    expect(keys).toContain('GET /*/-/*')
  })
})
