// proxy/src/x402/routes.test.ts

import { validateDiscoveryExtension } from '@x402-avm/extensions'
import { describe, expect, test } from 'vitest'
import { buildRoutes, LOCKFILE_ROUTE_KEY, SINGLE_ATTEST_ROUTE_KEY } from './routes.js'
import { TARBALL_ROUTE_KEY } from './tarball.js'

const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe('buildRoutes', () => {
  const routes = buildRoutes(FEE_PAYER)

  test('every paid route sets extra.asset, extra.feePayer, and extra.tag explicitly', () => {
    for (const key of [LOCKFILE_ROUTE_KEY, SINGLE_ATTEST_ROUTE_KEY, TARBALL_ROUTE_KEY] as const) {
      const accepts = routes[key].accepts
      const option = Array.isArray(accepts) ? accepts[0] : accepts
      expect(option?.scheme).toBe('exact')
      expect(option?.extra?.asset).toBeTruthy()
      expect(option?.extra?.feePayer).toBe(FEE_PAYER)
      expect(option?.extra?.tag).toBe('x402-global-challenge')
    }
  })

  test('lockfile route prices at $0.02, single attest and tarball at $0.001', () => {
    const priceOf = (
      key: typeof LOCKFILE_ROUTE_KEY | typeof SINGLE_ATTEST_ROUTE_KEY | typeof TARBALL_ROUTE_KEY,
    ) => {
      const accepts = routes[key].accepts
      return Array.isArray(accepts) ? accepts[0]?.price : accepts.price
    }
    expect(priceOf(LOCKFILE_ROUTE_KEY)).toBe('$0.02')
    expect(priceOf(SINGLE_ATTEST_ROUTE_KEY)).toBe('$0.001')
    expect(priceOf(TARBALL_ROUTE_KEY)).toBe('$0.001')
  })

  test('validateDiscoveryExtension(decl.bazaar).valid === true for every paid route declaration', () => {
    for (const key of [LOCKFILE_ROUTE_KEY, SINGLE_ATTEST_ROUTE_KEY, TARBALL_ROUTE_KEY] as const) {
      const extensions = routes[key].extensions as
        | { bazaar: Parameters<typeof validateDiscoveryExtension>[0] }
        | undefined
      expect(extensions?.bazaar).toBeDefined()
      const result = validateDiscoveryExtension(extensions!.bazaar)
      expect(result.valid).toBe(true)
    }
  })
})
