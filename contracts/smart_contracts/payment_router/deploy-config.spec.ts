import { describe, expect, test } from 'vitest'
import {
  assertCrediterDistinct,
  assertMainnetConfirmed,
  assertNetworkMatchesGenesis,
  assertOptedIntoUsdc,
  parseAuditorMap,
  parseNetwork,
} from './deploy-config'

describe('parseNetwork', () => {
  test('defaults to mainnet when unset', () => {
    expect(parseNetwork(undefined)).toBe('mainnet')
  })

  test('accepts testnet', () => {
    expect(parseNetwork('testnet')).toBe('testnet')
  })

  test('rejects an unknown value', () => {
    expect(() => parseNetwork('devnet')).toThrow(/NETWORK must be/)
  })
})

describe('assertMainnetConfirmed', () => {
  test('refuses MainNet without CONFIRM_MAINNET=1', () => {
    expect(() => assertMainnetConfirmed('mainnet', undefined)).toThrow(/CONFIRM_MAINNET/)
  })

  test('allows MainNet with CONFIRM_MAINNET=1', () => {
    expect(() => assertMainnetConfirmed('mainnet', '1')).not.toThrow()
  })

  test('is a no-op on TestNet, set or not', () => {
    expect(() => assertMainnetConfirmed('testnet', undefined)).not.toThrow()
    expect(() => assertMainnetConfirmed('testnet', '1')).not.toThrow()
  })
})

describe('assertNetworkMatchesGenesis', () => {
  test('refuses a MainNet run against a TestNet algod', () => {
    expect(() => assertNetworkMatchesGenesis('mainnet', 'testnet-v1.0')).toThrow(
      /does not match NETWORK=mainnet/,
    )
  })

  test('refuses a TestNet run against a MainNet algod', () => {
    expect(() => assertNetworkMatchesGenesis('testnet', 'mainnet-v1.0')).toThrow(
      /does not match NETWORK=testnet/,
    )
  })

  test('passes when the genesis id matches the network', () => {
    expect(() => assertNetworkMatchesGenesis('mainnet', 'mainnet-v1.0')).not.toThrow()
    expect(() => assertNetworkMatchesGenesis('testnet', 'testnet-v1.0')).not.toThrow()
  })
})

describe('assertOptedIntoUsdc', () => {
  test('refuses to map an address that is not opted into USDC', () => {
    expect(() => assertOptedIntoUsdc('github:alice', 'ADDR1', false)).toThrow(/not opted into USDC/)
  })

  test('refuses to map the ops address when it is not opted into USDC', () => {
    expect(() => assertOptedIntoUsdc('ops', 'OPS_ADDR', false)).toThrow(/not opted into USDC/)
  })

  test('passes when the address is opted into USDC', () => {
    expect(() => assertOptedIntoUsdc('github:alice', 'ADDR1', true)).not.toThrow()
  })
})

describe('assertCrediterDistinct', () => {
  const ADDR_CREDITER = 'CREDITER_ADDR'
  const ADDR_DEPLOYER = 'DEPLOYER_ADDR'
  const ADDR_PAYTO = 'PAYTO_ADDR'

  test('refuses when crediter equals the deployer', () => {
    expect(() =>
      assertCrediterDistinct(ADDR_CREDITER, { deployer: ADDR_CREDITER, payTo: ADDR_PAYTO }),
    ).toThrow(/must not equal deployer/)
  })

  test('refuses when crediter equals the admin', () => {
    expect(() =>
      assertCrediterDistinct(ADDR_CREDITER, { admin: ADDR_CREDITER, payTo: ADDR_PAYTO }),
    ).toThrow(/must not equal admin/)
  })

  test('refuses when crediter equals payTo', () => {
    expect(() =>
      assertCrediterDistinct(ADDR_CREDITER, { deployer: ADDR_DEPLOYER, payTo: ADDR_CREDITER }),
    ).toThrow(/must not equal payTo/)
  })

  test('passes when the crediter is distinct from every other address', () => {
    expect(() =>
      assertCrediterDistinct(ADDR_CREDITER, {
        deployer: ADDR_DEPLOYER,
        admin: ADDR_DEPLOYER,
        payTo: ADDR_PAYTO,
      }),
    ).not.toThrow()
  })

  test('ignores an unset address', () => {
    expect(() =>
      assertCrediterDistinct(ADDR_CREDITER, { deployer: undefined, payTo: ADDR_PAYTO }),
    ).not.toThrow()
  })
})

describe('parseAuditorMap', () => {
  test('returns an empty map for an unset value', () => {
    expect(parseAuditorMap(undefined)).toEqual(new Map())
  })

  test('parses one or more github:<login>=<address> pairs', () => {
    const map = parseAuditorMap('github:alice=ADDR1,github:bob=ADDR2')
    expect(map).toEqual(
      new Map([
        ['github:alice', 'ADDR1'],
        ['github:bob', 'ADDR2'],
      ]),
    )
  })

  test('rejects an entry with no "="', () => {
    expect(() => parseAuditorMap('github:alice-ADDR1')).toThrow(/malformed AUDITORS/)
  })

  test('rejects an entry whose login is not "github:<login>"', () => {
    expect(() => parseAuditorMap('alice=ADDR1')).toThrow(/malformed AUDITORS/)
  })

  test('rejects an entry with an empty address', () => {
    expect(() => parseAuditorMap('github:alice=')).toThrow(/malformed AUDITORS/)
  })
})
