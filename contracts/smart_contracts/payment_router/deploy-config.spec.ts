import algosdk from 'algosdk'
import { describe, expect, test, vi } from 'vitest'
import {
  assertAppCreatedFresh,
  assertCrediterDistinct,
  assertExistingAppMatchesConfig,
  assertExistingAppSafeToReuse,
  assertMainnetConfirmed,
  assertNetworkMatchesGenesis,
  assertOptedIntoUsdc,
  parseAuditorMap,
  parseNetwork,
  resolveClientConfig,
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

// --- R3d: a hermetic rehearsal must never reuse another run's app -----------

describe('assertAppCreatedFresh', () => {
  test('passes for a fresh create', () => {
    expect(() => assertAppCreatedFresh('create')).not.toThrow()
  })

  test('refuses an idempotently-reused app ("nothing")', () => {
    expect(() => assertAppCreatedFresh('nothing')).toThrow(
      /expected a fresh app creation.*"nothing"/s,
    )
  })

  test('refuses an updated app ("update")', () => {
    expect(() => assertAppCreatedFresh('update')).toThrow(/"update"/)
  })

  test('refuses a replaced app ("replace")', () => {
    expect(() => assertAppCreatedFresh('replace')).toThrow(/"replace"/)
  })
})

describe('assertExistingAppMatchesConfig', () => {
  const PAY_TO = 'PAYTO_ADDR'

  test("passes when the reused app's stored payTo and asset match", () => {
    expect(() =>
      assertExistingAppMatchesConfig(123n, PAY_TO, 31566704n, PAY_TO, 31566704),
    ).not.toThrow()
  })

  test('refuses when the stored payTo differs, naming the app id, the stored payTo, and the fix', () => {
    expect(() =>
      assertExistingAppMatchesConfig(123n, 'OTHER_PAYTO', 31566704n, PAY_TO, 31566704),
    ).toThrow(
      /app id 123.*OTHER_PAYTO.*already owns a PaymentRouter for another payTo.*different deployer account/s,
    )
  })

  test('refuses when the stored asset differs', () => {
    expect(() => assertExistingAppMatchesConfig(123n, PAY_TO, 10458941n, PAY_TO, 31566704)).toThrow(
      /app id 123/,
    )
  })

  test('refuses when the reused app has no stored payTo or asset at all', () => {
    expect(() =>
      assertExistingAppMatchesConfig(123n, undefined, undefined, PAY_TO, 31566704),
    ).toThrow(/\(none\)/)
  })
})

// --- R3e: AlgorandClient config reads INDEXER_URL, not INDEXER_SERVER -------
// Pure data resolution, no AlgorandClient construction and no network call:
// scripts/network.mjs's algodEndpoint/indexerEndpoint are themselves pure
// functions, so importing and calling them is not a chain call.

describe('resolveClientConfig', () => {
  test('defaults to the MainNet algod/indexer endpoints when env is empty', async () => {
    const config = await resolveClientConfig('mainnet', {})
    expect(config.algodConfig).toEqual({
      server: 'https://mainnet-api.algonode.cloud',
      port: 443,
      token: '',
    })
    expect(config.indexerConfig).toEqual({
      server: 'https://mainnet-idx.algonode.cloud',
      port: 443,
      token: '',
    })
  })

  test('defaults to the TestNet algod/indexer endpoints when env is empty', async () => {
    const config = await resolveClientConfig('testnet', {})
    expect(config.algodConfig.server).toBe('https://testnet-api.algonode.cloud')
    expect(config.indexerConfig.server).toBe('https://testnet-idx.algonode.cloud')
  })

  test('reads the indexer server from INDEXER_URL', async () => {
    const config = await resolveClientConfig('mainnet', { INDEXER_URL: 'http://localhost:8980' })
    expect(config.indexerConfig.server).toBe('http://localhost:8980')
  })

  test('ignores INDEXER_SERVER, the env name AlgorandClient.fromEnvironment() reads', async () => {
    const config = await resolveClientConfig('mainnet', { INDEXER_SERVER: 'http://wrong-host' })
    expect(config.indexerConfig.server).toBe('https://mainnet-idx.algonode.cloud')
  })

  test('reads algod overrides from ALGOD_SERVER/ALGOD_PORT/ALGOD_TOKEN', async () => {
    const config = await resolveClientConfig('mainnet', {
      ALGOD_SERVER: 'http://localhost:4001',
      ALGOD_PORT: '4001',
      ALGOD_TOKEN: 'a'.repeat(64),
    })
    expect(config.algodConfig).toEqual({
      server: 'http://localhost:4001',
      port: 4001,
      token: 'a'.repeat(64),
    })
  })
})

describe('assertExistingAppSafeToReuse (chain mocked — no real algod call)', () => {
  const payToAccount = algosdk.generateAccount()
  const PAY_TO = payToAccount.addr.toString()
  const PAY_TO_BYTES = algosdk.decodeAddress(PAY_TO).publicKey

  function fakeAppClient(
    appId: bigint,
    storedPayToBytes: Uint8Array | undefined,
    storedAssetId: bigint | undefined,
  ) {
    return {
      appId,
      state: {
        global: {
          payTo: vi.fn().mockResolvedValue({ asByteArray: () => storedPayToBytes }),
          assetId: vi.fn().mockResolvedValue(storedAssetId),
        },
      },
    }
  }

  test("passes when the reused app's own on-chain routing matches this deploy", async () => {
    await expect(
      assertExistingAppSafeToReuse(fakeAppClient(123n, PAY_TO_BYTES, 31566704n), PAY_TO, 31566704),
    ).resolves.toBeUndefined()
  })

  test('refuses when the reused app belongs to another payTo', async () => {
    const otherAccount = algosdk.generateAccount()
    const otherBytes = algosdk.decodeAddress(otherAccount.addr.toString()).publicKey
    await expect(
      assertExistingAppSafeToReuse(fakeAppClient(123n, otherBytes, 31566704n), PAY_TO, 31566704),
    ).rejects.toThrow(/already owns a PaymentRouter for another payTo/)
  })

  test('refuses when the reused app has no stored payTo at all', async () => {
    await expect(
      assertExistingAppSafeToReuse(fakeAppClient(123n, undefined, 31566704n), PAY_TO, 31566704),
    ).rejects.toThrow(/already owns a PaymentRouter for another payTo/)
  })
})
