// proxy/src/claims/credit.testnet.test.ts
//
// One end-to-end check that runCreditStep uses the TestNet auditor share
// (400, ADR 0003) rather than the MainNet default (300, ADR 0011) —
// credit.test.ts already proves the MainNet path. NETWORK must be set
// before proxy/src/config.ts (and everything that imports it) first loads,
// so this lives in its own file with its own SQLite file (same trick as
// credit.test.ts and proxy/src/claims/ledger.test.ts).
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'

process.env.SQLITE_PATH = path.join(
  os.tmpdir(),
  `aupm-claims-credit-testnet-test-${randomUUID()}.db`,
)
process.env.NETWORK = 'testnet'

const { writeAccruals } = await import('./ledger.js')
const { setStatus } = await import('../status.js')
const { runCreditStep } = await import('./credit.js')
type Attribution = import('./attribution-rules.js').Attribution
type CreditChainClient = import('./credit.js').CreditChainClient

const APP_ID = '123'
const PAY_TO = 'PAYTOADDRAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

function stubClient(submit: CreditChainClient['submitCredit']): CreditChainClient {
  return {
    isPayToRekeyed: vi.fn(async () => true),
    submitCredit: submit,
    getOnChainLastBatchSeq: vi.fn(async () => 0),
    findCreditTxidByNote: vi.fn(async () => null),
  }
}

describe('runCreditStep on TestNet (docs/TASK.md P8a, ADR 0003)', () => {
  test('auditor entries use the TestNet share (400 per package), not MainNet (300)', async () => {
    setStatus(
      'ms',
      '2.1.3',
      'COMMUNITY_REVIEWED',
      '0xA',
      'anchor-a',
      'sha-a',
      'alice',
      null,
      'acme/ms',
    )
    const attribution: Attribution = {
      route: 'tarball',
      priceMicro: 1000,
      packages: [{ pkg: 'ms', version: '2.1.3', auditor: 'github:alice' }],
    }
    writeAccruals(attribution, 'TXID-TESTNET-1')

    const submit = vi.fn<CreditChainClient['submitCredit']>(async () => 'CREDIT-TXID-TESTNET-1')
    const outcome = await runCreditStep(stubClient(submit), {
      PAYMENT_ROUTER_APP_ID: APP_ID,
      PAY_TO_ADDRESS: PAY_TO,
    })

    expect(outcome).toEqual({ ran: true, batchSeq: 1, creditTxid: 'CREDIT-TXID-TESTNET-1' })
    const call = submit.mock.calls[0]
    if (!call) throw new Error('submitCredit was never called')
    const [, , , , entries] = call
    expect(entries).toEqual([{ repo: 'acme/ms', identity: 'github:alice', amountMicro: 400 }])
  })
})
