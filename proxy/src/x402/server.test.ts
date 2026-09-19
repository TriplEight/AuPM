// proxy/src/x402/server.test.ts
//
// CAUTION: every facilitator client here is a stub. No test in this file
// performs a network call.

import type { FacilitatorClient } from '@x402-avm/core/server'
import type { Network, SupportedResponse } from '@x402-avm/core/types'
import { describe, expect, test } from 'vitest'
import { CAIP2_NETWORK, resolveFeePayer } from '../config.js'
import { boot, buildHttpServer } from './server.js'

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
