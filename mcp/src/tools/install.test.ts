import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import algosdk from 'algosdk'
import { installTool } from './install.js'

vi.mock('algosdk', async (importOriginal) => {
  const mod = await importOriginal<typeof import('algosdk')>()
  return {
    ...mod,
    default: {
      ...mod.default,
      // Must be a class (constructable) — arrow functions can't be used with `new`
      Algodv2: class MockAlgod {
        getTransactionParams() {
          return {
            do: () =>
              Promise.resolve({
                fee: 0,
                minFee: 1000,
                firstValid: 1000n,
                lastValid: 2000n,
                genesisID: 'testnet-v1.0',
                genesisHash: new Uint8Array(32).fill(0x12),
              }),
          }
        }
        getApplicationByID(_appId: number) {
          return {
            do: () =>
              Promise.resolve({
                params: { globalState: [] },
              }),
          }
        }
      },
    },
  }
})

// Test mnemonic — fresh throwaway account, never funded
const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'

// Valid app address generated once for all tests
const APP_ADDRESS = 'LRSS3RCDPKYBVXMPLF5TMSY37PMPBYMLQBTUIHFIAQERME63MGIUOK5QDQ'
const APP_ID = '99999'
const UNIT = 1000n
const USDC_ASSET_ID = 10458941n

function makePaymentRequirements(payTo: string) {
  return {
    x402Version: 1,
    accepts: [
      {
        scheme: 'exact',
        network: 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI=',
        payTo,
        asset: String(USDC_ASSET_ID),
        maxAmountRequired: String(UNIT),
        maxTimeoutSeconds: 60,
        extra: { appMethod: 'pay', args: ['lodash', '4.17.21'] },
      },
    ],
  }
}

describe('install_audited_package', () => {
  beforeEach(() => {
    process.env['PAYER_MNEMONIC'] = TEST_MNEMONIC
    process.env['SPLIT_APP_ID'] = APP_ID
    process.env['ALGOD_SERVER'] = 'https://testnet-api.algonode.cloud'
    process.env['ALGOD_TOKEN'] = ''
    process.env['ALGOD_PORT'] = '443'
    process.env['SPM_PROXY_URL'] = 'http://localhost:4873'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env['PAYER_MNEMONIC']
    delete process.env['SPLIT_APP_ID']
  })

  it('builds atomic group [USDC axfer->app]+[appcall pay] on 402 response', async () => {
    let capturedHeader: string | null = null

    const mockFetch = vi.fn().mockImplementation(async (_url: string, options?: RequestInit) => {
      const headers = (options?.headers ?? {}) as Record<string, string>
      if (headers['PAYMENT-SIGNATURE']) {
        capturedHeader = headers['PAYMENT-SIGNATURE']
        return {
          status: 200,
          ok: true,
          headers: { get: (h: string) => (h === 'X-AUDIT-ATTESTATION' ? 'txid-abc123' : null) },
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
        }
      }
      // First call: no payment header → 402
      return {
        status: 402,
        ok: false,
        json: () => Promise.resolve(makePaymentRequirements(APP_ADDRESS)),
      }
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await installTool.handler({ pkg: 'lodash', version: '4.17.21' })

    expect(result.status).toBe('paid')
    expect(result.txid).toBe('txid-abc123')
    expect(mockFetch).toHaveBeenCalledTimes(2)
    expect(capturedHeader).not.toBeNull()

    // Decode the PAYMENT-SIGNATURE and verify group structure
    const payloadStr = Buffer.from(capturedHeader!, 'base64').toString('utf8')
    const payloadJson = JSON.parse(payloadStr) as {
      payload: { signedTransactions: string[] }
    }
    const { signedTransactions } = payloadJson.payload
    expect(signedTransactions).toHaveLength(2)

    // Txn 0: USDC asset transfer to the SplitRouter app address
    const stxn0 = algosdk.decodeSignedTransaction(Buffer.from(signedTransactions[0]!, 'base64'))
    expect(stxn0.txn.type).toBe('axfer')
    expect(stxn0.txn.assetTransfer?.assetIndex).toBe(USDC_ASSET_ID)
    expect(stxn0.txn.assetTransfer?.amount).toBe(UNIT)
    expect(stxn0.txn.assetTransfer?.receiver.toString()).toBe(APP_ADDRESS)

    // Txn 1: ARC-4 appcall pay(axfer, pkg, ver)
    const stxn1 = algosdk.decodeSignedTransaction(Buffer.from(signedTransactions[1]!, 'base64'))
    expect(stxn1.txn.type).toBe('appl')
    expect(stxn1.txn.applicationCall?.appIndex).toBe(BigInt(APP_ID))
  })

  it('returns free result without payment when server returns 200 directly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: { get: () => null },
      arrayBuffer: () => Promise.resolve(new ArrayBuffer(8)),
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await installTool.handler({ pkg: 'lodash', version: '4.17.21' })

    expect(result.status).toBe('free')
    expect(result.txid).toBeNull()
    // Only one fetch — no 402 retry
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})
