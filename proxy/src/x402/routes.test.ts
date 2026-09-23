// proxy/src/x402/routes.test.ts
//
// CAUTION: this file gets its own SQLite file via SQLITE_PATH, set before
// the dynamic imports below (same trick as proxy/src/claims/ledger.test.ts).
// Without per-file isolation, vitest's parallel test files race on the same
// physical database and writes from one file can be wiped by another file's
// beforeEach mid-test.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { validateDiscoveryExtension } from '@x402-avm/extensions'
import { describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `spm-x402-routes-test-${randomUUID()}.db`)

const { buildRoutes, LOCKFILE_ROUTE_KEY, SINGLE_ATTEST_ROUTE_KEY, OG_DESCRIPTION } = await import(
  './routes.js'
)
const { TARBALL_ROUTE_KEY } = await import('./tarball.js')
const { lockfileDynamicPrice } = await import('../routes/attest.js')

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

  test('lockfile route prices via lockfileDynamicPrice, single attest and tarball at $0.001', () => {
    const priceOf = (
      key: typeof LOCKFILE_ROUTE_KEY | typeof SINGLE_ATTEST_ROUTE_KEY | typeof TARBALL_ROUTE_KEY,
    ) => {
      const accepts = routes[key].accepts
      return Array.isArray(accepts) ? accepts[0]?.price : accepts.price
    }
    // SPEC §11.2, ADR 0008: the lockfile route is 1,000 microUSDC x N reviewed
    // entries, no cap, no discount — a DynamicPrice function, never a flat
    // dollar string. The single-attest and tarball routes stay flat: each
    // charges for exactly one reviewed package.
    expect(priceOf(LOCKFILE_ROUTE_KEY)).toBe(lockfileDynamicPrice)
    expect(priceOf(SINGLE_ATTEST_ROUTE_KEY)).toBe('$0.001')
    expect(priceOf(TARBALL_ROUTE_KEY)).toBe('$0.001')
  })

  // Composed, not a literal, so this regression guard itself never trips
  // docs/TASK.md Q11's stale-price grep over proxy/src.
  const STALE_FLAT_LOCKFILE_PRICE = ['$', '0.0', '2'].join('')

  test("the lockfile route's description states the per-package price, never the old flat rate", () => {
    const description = routes[LOCKFILE_ROUTE_KEY].description ?? ''
    expect(description).toContain('$0.001 per reviewed package')
    expect(description).not.toContain(STALE_FLAT_LOCKFILE_PRICE)
  })

  // Composed, not a literal, for the same reason as STALE_FLAT_LOCKFILE_PRICE
  // above: never write this misattribution (SPEC §6.2) while ops holds it.
  const OPS_SHARE_MISATTRIBUTED_TO_MAINTAINER = ['20%', 'to maintainers'].join(' ')

  test('every Bazaar description and og:description shows both splits and $0.001 (SPEC §6.2)', () => {
    const texts = [
      routes[LOCKFILE_ROUTE_KEY].description ?? '',
      routes[SINGLE_ATTEST_ROUTE_KEY].description ?? '',
      routes[TARBALL_ROUTE_KEY].description ?? '',
      OG_DESCRIPTION,
    ]
    for (const text of texts) {
      expect(text).toContain('$0.001')
      expect(text).toContain('40/10/20/15/10/5')
      expect(text).toContain('40% to the auditor, 60% to the operator')
      expect(text).not.toContain(OPS_SHARE_MISATTRIBUTED_TO_MAINTAINER)
    }
  })

  test('validateDiscoveryExtension(decl.bazaar).valid === true for every paid route declaration', () => {
    for (const key of [LOCKFILE_ROUTE_KEY, SINGLE_ATTEST_ROUTE_KEY, TARBALL_ROUTE_KEY] as const) {
      const extensions = routes[key].extensions as
        | { bazaar: Parameters<typeof validateDiscoveryExtension>[0] }
        | undefined
      expect(extensions?.bazaar).toBeDefined()
      // biome-ignore lint/style/noNonNullAssertion: definedness asserted above
      const result = validateDiscoveryExtension(extensions!.bazaar)
      expect(result.valid).toBe(true)
    }
  })

  test("the lockfile route's discovery example summary buckets sum to its total (I3 defect 2)", () => {
    const extensions = routes[LOCKFILE_ROUTE_KEY].extensions as {
      bazaar: { info: { output: { example: { summary: Record<string, number> } } } }
    }
    const summary = extensions.bazaar.info.output.example.summary
    const { total, ...buckets } = summary
    const sum = Object.values(buckets).reduce((a, b) => a + b, 0)
    expect(sum).toBe(total)
  })

  test("the lockfile route's discovery example summary bucket names match LockfileSummary", () => {
    const extensions = routes[LOCKFILE_ROUTE_KEY].extensions as {
      bazaar: { info: { output: { example: { summary: Record<string, number> } } } }
    }
    const summary = extensions.bazaar.info.output.example.summary
    const bucketNames = Object.keys(summary)
      .filter((k) => k !== 'total')
      .sort()
    // Mirrors LockfileSummary in proxy/src/attest/lockfile.ts, which is the
    // shape the route actually returns.
    expect(bucketNames).toEqual(
      ['integrityMismatch', 'reviewed', 'unresolvable', 'unreviewed'].sort(),
    )
  })
})
