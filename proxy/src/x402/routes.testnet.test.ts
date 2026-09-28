// proxy/src/x402/routes.testnet.test.ts
//
// One check that the public 402/Bazaar/og:description text states the
// TestNet split (ADR 0003), not the MainNet default (ADR 0011) —
// routes.test.ts already proves the MainNet text. NETWORK must be set
// before proxy/src/config.ts (and everything that imports it) first loads,
// so this lives in its own file with its own SQLite file (same trick as
// routes.test.ts).
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-x402-routes-testnet-test-${randomUUID()}.db`)
process.env.NETWORK = 'testnet'

const { buildRoutes, LOCKFILE_ROUTE_KEY, OG_DESCRIPTION } = await import('./routes.js')

const FEE_PAYER = 'FEEPAYERAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

describe('buildRoutes on TestNet (docs/TASK.md P8a, ADR 0003; app 772553842 is not redeployed)', () => {
  test('the split disclosure states 40/10/20/15/10/5 and the 40/60 MVP split', () => {
    const routes = buildRoutes(FEE_PAYER)
    const texts = [routes[LOCKFILE_ROUTE_KEY].description ?? '', OG_DESCRIPTION]
    for (const text of texts) {
      expect(text).toContain('40/10/20/15/10/5')
      expect(text).toContain('40% to the auditor, 60% to the operator')
      expect(text).not.toContain('30/10/20/25/10/5')
    }
  })
})
