// proxy/src/claims/genesis.test.ts
//
// Pure comparison only — no network access, no algod/indexer client (R3c).
import { describe, expect, test } from 'vitest'
import { assertGenesisMatchesNetwork } from './genesis.js'

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
