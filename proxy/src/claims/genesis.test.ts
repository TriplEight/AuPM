// proxy/src/claims/genesis.test.ts
//
// assertGenesisMatchesNetwork is pure — no network access. fetchGenesisId's
// own tests inject a stub `fetch`, never a real algod or indexer (R3c fix
// attempt 1: the real /v2/blocks/1?header-only=true and /health response
// shapes, checked against the live TestNet and MainNet indexers).
import { describe, expect, test, vi } from 'vitest'
import { assertGenesisMatchesNetwork, fetchGenesisId } from './genesis.js'

function stubFetch(status: number, jsonBody: unknown): typeof fetch {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => jsonBody,
  }) as unknown as typeof fetch
}

describe('assertGenesisMatchesNetwork', () => {
  test('passes when algod genesis id matches the network', () => {
    expect(() =>
      assertGenesisMatchesNetwork('algod', 'mainnet', 'mainnet-v1.0', 'https://x', 'ALGOD_SERVER'),
    ).not.toThrow()
  })

  test('passes when indexer genesis id matches the network', () => {
    expect(() =>
      assertGenesisMatchesNetwork('indexer', 'testnet', 'testnet-v1.0', 'https://y', 'INDEXER_URL'),
    ).not.toThrow()
  })

  test('FAILs an algod genesis mismatch, naming NETWORK, the URL, and the env var', () => {
    expect(() =>
      assertGenesisMatchesNetwork(
        'algod',
        'testnet',
        'mainnet-v1.0',
        'https://mainnet-api.algonode.cloud',
        'ALGOD_SERVER',
      ),
    ).toThrow(
      /algod genesis id "mainnet-v1\.0" from https:\/\/mainnet-api\.algonode\.cloud does not match NETWORK=testnet.*ALGOD_SERVER/s,
    )
  })

  test('FAILs an indexer genesis mismatch, naming NETWORK, the URL, and the env var', () => {
    expect(() =>
      assertGenesisMatchesNetwork(
        'indexer',
        'mainnet',
        'testnet-v1.0',
        'https://testnet-idx.algonode.cloud',
        'INDEXER_URL',
      ),
    ).toThrow(
      /indexer genesis id "testnet-v1\.0" from https:\/\/testnet-idx\.algonode\.cloud does not match NETWORK=mainnet.*INDEXER_URL/s,
    )
  })

  test('an unknown NETWORK value never matches and never throws a raw undefined', () => {
    expect(() =>
      assertGenesisMatchesNetwork('algod', 'devnet', 'devnet-v1.0', 'https://z', 'ALGOD_SERVER'),
    ).toThrow(/NETWORK=devnet/)
  })
})

describe('fetchGenesisId', () => {
  test('reads genesis-id from the real /v2/blocks/1 header shape', async () => {
    const blockHeader = {
      'genesis-id': 'testnet-v1.0',
      'genesis-hash': 'wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=',
      round: 1,
    }
    const genesisId = await fetchGenesisId(
      'https://testnet-idx.algonode.cloud',
      '/v2/blocks/1?header-only=true',
      '',
      'X-Indexer-API-Token',
      stubFetch(200, blockHeader),
    )
    expect(genesisId).toBe('testnet-v1.0')
  })

  test('FAILs with a dedicated error on the real /health shape (no genesis-id)', async () => {
    const health = {
      data: {},
      'db-available': true,
      'is-migrating': false,
      message: '67619575',
      round: 67619575,
      version: '3.10.0-ndly',
    }
    await expect(
      fetchGenesisId(
        'https://testnet-idx.algonode.cloud',
        '/health',
        '',
        'X-Indexer-API-Token',
        stubFetch(200, health),
      ),
    ).rejects.toThrow(/GET https:\/\/testnet-idx\.algonode\.cloud\/health returned no "genesis-id"/)
  })

  test('FAILs with a dedicated error on an empty genesis-id, never comparing "" against a network', async () => {
    await expect(
      fetchGenesisId(
        'https://x',
        '/v2/blocks/1?header-only=true',
        '',
        'X-Indexer-API-Token',
        stubFetch(200, { 'genesis-id': '' }),
      ),
    ).rejects.toThrow(/returned no "genesis-id"/)
  })

  test('FAILs on a non-ok HTTP response, naming the URL, the path, and the status', async () => {
    await expect(
      fetchGenesisId(
        'https://x',
        '/v2/transactions/params',
        '',
        'X-Algo-API-Token',
        stubFetch(500, {}),
      ),
    ).rejects.toThrow(/genesis check: GET https:\/\/x\/v2\/transactions\/params returned HTTP 500/)
  })

  test('reads genesis-id from a raw algod /v2/transactions/params response', async () => {
    const genesisId = await fetchGenesisId(
      'https://mainnet-api.algonode.cloud',
      '/v2/transactions/params',
      '',
      'X-Algo-API-Token',
      stubFetch(200, {
        'genesis-id': 'mainnet-v1.0',
        'genesis-hash': 'abc',
        fee: 0,
        'min-fee': 1000,
      }),
    )
    expect(genesisId).toBe('mainnet-v1.0')
  })
})
