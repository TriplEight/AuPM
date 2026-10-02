import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import algosdk from 'algosdk'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { APP_SPEC } from '../artifacts/payment_router/PaymentRouterClient'
import {
  ADMIN_MSIG_THRESHOLD,
  assertAppCreatedFresh,
  assertCrediterDistinct,
  assertExistingAppMatchesConfig,
  assertExistingAppSafeToReuse,
  assertMainnetConfirmed,
  assertMethodSignatureMatchesSpec,
  assertNetworkMatchesGenesis,
  assertOptedIntoUsdc,
  assertSingleKeyDeployNotMainnet,
  buildAdminMultisigParams,
  buildUnsignedAnnounceReleaseTxn,
  buildUnsignedCreateApplicationTxn,
  buildUnsignedExecuteReleaseTxn,
  buildUnsignedSetCrediterTxn,
  buildUnsignedSetIdentityTxn,
  deploy,
  deriveAdminMultisigAddress,
  EXECUTE_RELEASE_MIN_FEE,
  identityBoxName,
  parseAdminMultisigAddrs,
  parseAppId,
  parseAuditorMap,
  parseNetwork,
  resolveClientConfig,
  resolveExecuteReleaseFee,
  writeUnsignedTxnFile,
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

// --- Multisig creator (ADR 0010, SPEC §10.2a) --------------------------

describe('parseAdminMultisigAddrs', () => {
  const [a1, a2, a3] = [
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
  ]

  test('refuses an unset value', () => {
    expect(() => parseAdminMultisigAddrs(undefined)).toThrow(/AUPM_ADMIN_MSIG_ADDRS is not set/)
  })

  test('refuses fewer than 3 addresses', () => {
    expect(() => parseAdminMultisigAddrs(`${a1},${a2}`)).toThrow(/exactly 3 addresses, got 2/)
  })

  test('refuses more than 3 addresses', () => {
    expect(() => parseAdminMultisigAddrs(`${a1},${a2},${a3},${a1}`)).toThrow(
      /exactly 3 addresses, got 4/,
    )
  })

  test('refuses an invalid address', () => {
    expect(() => parseAdminMultisigAddrs(`${a1},${a2},not-an-address`)).toThrow(
      /invalid Algorand address/,
    )
  })

  test('refuses duplicate addresses', () => {
    expect(() => parseAdminMultisigAddrs(`${a1},${a2},${a1}`)).toThrow(/must be distinct/)
  })

  test('parses exactly 3 distinct, valid addresses', () => {
    expect(parseAdminMultisigAddrs(`${a1}, ${a2} ,${a3}`)).toEqual([a1, a2, a3])
  })
})

describe('buildAdminMultisigParams / deriveAdminMultisigAddress', () => {
  const addrs = [
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
  ]

  test('fixes the threshold at ADMIN_MSIG_THRESHOLD (2), never from input', () => {
    expect(ADMIN_MSIG_THRESHOLD).toBe(2)
    expect(buildAdminMultisigParams(addrs)).toEqual({ version: 1, threshold: 2, addrs })
  })

  test('derives the same multisig address algosdk itself would compute', () => {
    const params = buildAdminMultisigParams(addrs)
    const expected = algosdk.multisigAddress(params).toString()
    expect(deriveAdminMultisigAddress(params)).toBe(expected)
  })

  test('a different address order derives a different multisig address', () => {
    const params = buildAdminMultisigParams(addrs)
    const reordered = buildAdminMultisigParams([addrs[1], addrs[0], addrs[2]])
    expect(deriveAdminMultisigAddress(reordered)).not.toBe(deriveAdminMultisigAddress(params))
  })
})

describe('buildUnsignedCreateApplicationTxn', () => {
  const addrs = [
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
  ]
  const multisigAddress = deriveAdminMultisigAddress(buildAdminMultisigParams(addrs))
  const payToAddress = algosdk.generateAccount().addr.toString()
  const FAKE_SUGGESTED_PARAMS: algosdk.SuggestedParams = {
    fee: 0n,
    minFee: 1000n,
    firstValid: 100n,
    lastValid: 1100n,
    genesisID: 'mainnet-v1.0',
    genesisHash: new Uint8Array(32),
    flatFee: false,
  }

  test('sets the sender to the multisig address and encodes payTo/usdcAsset as ABI args', () => {
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      payToAddress,
      31566704,
      FAKE_SUGGESTED_PARAMS,
    )

    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs).toHaveLength(3)
    expect(appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature('createApplication(address,uint64)void').getSelector(),
    )
    expect(new algosdk.ABIAddressType().decode(appArgs[1])).toBe(payToAddress)
    expect(new algosdk.ABIUintType(64).decode(appArgs[2])).toBe(31566704n)
  })

  test('a different payToAddress or usdcAssetId changes the encoded args, not the sender', () => {
    const otherPayTo = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      otherPayTo,
      10458941,
      FAKE_SUGGESTED_PARAMS,
    )
    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(new algosdk.ABIAddressType().decode(appArgs[1])).toBe(otherPayTo)
    expect(new algosdk.ABIUintType(64).decode(appArgs[2])).toBe(10458941n)
  })
})

describe('writeUnsignedTxnFile', () => {
  test('writes bytes that decode back to an equivalent unsigned transaction', () => {
    const addrs = [
      algosdk.generateAccount().addr.toString(),
      algosdk.generateAccount().addr.toString(),
      algosdk.generateAccount().addr.toString(),
    ]
    const multisigAddress = deriveAdminMultisigAddress(buildAdminMultisigParams(addrs))
    const payToAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedCreateApplicationTxn(multisigAddress, payToAddress, 31566704, {
      fee: 0n,
      minFee: 1000n,
      firstValid: 100n,
      lastValid: 1100n,
      genesisID: 'mainnet-v1.0',
      genesisHash: new Uint8Array(32),
      flatFee: false,
    })

    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-msig-')), 'create.txn')
    writeUnsignedTxnFile(txn, outPath)

    const decoded = algosdk.decodeUnsignedTransaction(new Uint8Array(fs.readFileSync(outPath)))
    expect(decoded.sender.toString()).toBe(multisigAddress)
    const decodedArgs = (decoded.applicationCall?.appArgs ?? []).map((a) => new Uint8Array(a))
    const originalArgs = (txn.applicationCall?.appArgs ?? []).map((a) => new Uint8Array(a))
    expect(decodedArgs).toEqual(originalArgs)
  })
})

// --- Admin-call multisig builders (ADR 0010, SPEC §10.2a) -------------------------------------

describe('parseAppId', () => {
  test('refuses an unset value', () => {
    expect(() => parseAppId(undefined)).toThrow(/PAYMENT_ROUTER_APP_ID is not set/)
  })

  test('refuses a non-integer value', () => {
    expect(() => parseAppId('not-a-number')).toThrow(/must be an integer/)
  })

  test('refuses zero or a negative value', () => {
    expect(() => parseAppId('0')).toThrow(/must be a positive integer/)
    expect(() => parseAppId('-5')).toThrow(/must be a positive integer/)
  })

  test('parses a positive integer', () => {
    expect(parseAppId('772553842')).toBe(772553842n)
  })
})

describe('identityBoxName', () => {
  test('encodes the "id:" prefix plus the identity, as literal utf8 bytes', () => {
    expect(identityBoxName('treasury')).toEqual(new TextEncoder().encode('id:treasury'))
    expect(identityBoxName('github:octocat')).toEqual(new TextEncoder().encode('id:github:octocat'))
  })
})

describe('resolveExecuteReleaseFee', () => {
  test('never returns below EXECUTE_RELEASE_MIN_FEE', () => {
    expect(EXECUTE_RELEASE_MIN_FEE).toBe(3_000)
    expect(resolveExecuteReleaseFee(0)).toBe(EXECUTE_RELEASE_MIN_FEE)
    expect(resolveExecuteReleaseFee(1_000)).toBe(EXECUTE_RELEASE_MIN_FEE)
  })

  test('keeps a higher suggested fee unchanged', () => {
    expect(resolveExecuteReleaseFee(5_000)).toBe(5_000)
  })
})

describe('assertMethodSignatureMatchesSpec', () => {
  const fakeSpec = {
    methods: [{ name: 'setCrediter', args: [{ type: 'address' }], returns: { type: 'void' } }],
  } as unknown as Parameters<typeof assertMethodSignatureMatchesSpec>[1]

  test('passes when the signature matches the spec method', () => {
    expect(() =>
      assertMethodSignatureMatchesSpec('setCrediter(address)void', fakeSpec),
    ).not.toThrow()
  })

  test('throws when the signature disagrees with the spec method', () => {
    expect(() => assertMethodSignatureMatchesSpec('setCrediter(uint64)void', fakeSpec)).toThrow(
      /disagrees with the rebuilt ARC-56 spec/,
    )
  })

  test('is a no-op when the spec does not declare the method yet (a stale spec)', () => {
    expect(() =>
      assertMethodSignatureMatchesSpec('announceRelease(address)void', fakeSpec),
    ).not.toThrow()
  })

  test('setCrediter and setIdentity already agree with the real, generated ARC-56 spec', () => {
    expect(() =>
      assertMethodSignatureMatchesSpec('setCrediter(address)void', APP_SPEC),
    ).not.toThrow()
    expect(() =>
      assertMethodSignatureMatchesSpec('setIdentity(string,address)void', APP_SPEC),
    ).not.toThrow()
  })

  test('announceRelease/executeRelease are checked automatically once the spec is rebuilt', () => {
    // The real, generated APP_SPEC is stale today: it still declares the superseded
    // releaseAuthority(address), not announceRelease/executeRelease (ADR 0010), until a human
    // reruns `algokit project run build`. This call is a no-op now. Once the spec is rebuilt
    // with both methods, this same assertion starts failing loudly if either hand-written
    // signature in deploy-config.ts disagrees with the rebuilt spec.
    expect(() =>
      assertMethodSignatureMatchesSpec('announceRelease(address)void', APP_SPEC),
    ).not.toThrow()
    expect(() => assertMethodSignatureMatchesSpec('executeRelease()void', APP_SPEC)).not.toThrow()
  })
})

describe('admin-call builders', () => {
  const addrs = [
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
  ]
  const multisigAddress = deriveAdminMultisigAddress(buildAdminMultisigParams(addrs))
  const APP_ID = 772553842n
  const FAKE_SUGGESTED_PARAMS: algosdk.SuggestedParams = {
    fee: 0n,
    minFee: 1_000n,
    firstValid: 100n,
    lastValid: 1_100n,
    genesisID: 'mainnet-v1.0',
    genesisHash: new Uint8Array(32),
    flatFee: false,
  }

  test('buildUnsignedSetCrediterTxn: sender, app id and ABI-encoded crediter address', () => {
    const crediterAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedSetCrediterTxn(
      APP_ID,
      multisigAddress,
      crediterAddress,
      FAKE_SUGGESTED_PARAMS,
    )
    expect(txn.sender.toString()).toBe(multisigAddress)
    expect(txn.applicationCall?.appIndex).toBe(APP_ID)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature('setCrediter(address)void').getSelector(),
    )
    expect(new algosdk.ABIAddressType().decode(appArgs[1])).toBe(crediterAddress)
    expect(txn.applicationCall?.boxes ?? []).toHaveLength(0)
  })

  test('buildUnsignedSetIdentityTxn: ABI-encoded identity/address and the identity box ref', () => {
    const identityAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedSetIdentityTxn(
      APP_ID,
      multisigAddress,
      'github:octocat',
      identityAddress,
      FAKE_SUGGESTED_PARAMS,
    )
    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature('setIdentity(string,address)void').getSelector(),
    )
    expect(new algosdk.ABIStringType().decode(appArgs[1])).toBe('github:octocat')
    expect(new algosdk.ABIAddressType().decode(appArgs[2])).toBe(identityAddress)
    const boxes = txn.applicationCall?.boxes ?? []
    expect(boxes).toHaveLength(1)
    expect(boxes[0].appIndex).toBe(0n)
    expect(new Uint8Array(boxes[0].name)).toEqual(identityBoxName('github:octocat'))
  })

  test('buildUnsignedAnnounceReleaseTxn: ABI-encoded target address, no box or foreign refs', () => {
    const toAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedAnnounceReleaseTxn(APP_ID, multisigAddress, toAddress, {
      ...FAKE_SUGGESTED_PARAMS,
    })
    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature('announceRelease(address)void').getSelector(),
    )
    expect(new algosdk.ABIAddressType().decode(appArgs[1])).toBe(toAddress)
    expect(txn.applicationCall?.boxes ?? []).toHaveLength(0)
    expect(txn.applicationCall?.foreignAssets ?? []).toHaveLength(0)
  })

  test('buildUnsignedExecuteReleaseTxn: no args, payTo/treasury accounts, USDC asset, treasury box', () => {
    const payToAddress = algosdk.generateAccount().addr.toString()
    const treasuryAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedExecuteReleaseTxn(
      APP_ID,
      multisigAddress,
      payToAddress,
      treasuryAddress,
      31566704,
      FAKE_SUGGESTED_PARAMS,
    )
    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs).toHaveLength(1)
    expect(appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature('executeRelease()void').getSelector(),
    )

    const accounts = (txn.applicationCall?.accounts ?? []).map((a) => a.toString())
    expect(accounts).toEqual([payToAddress, treasuryAddress])
    expect(txn.applicationCall?.foreignAssets ?? []).toEqual([31566704n])

    const boxes = txn.applicationCall?.boxes ?? []
    expect(boxes).toHaveLength(1)
    expect(boxes[0].appIndex).toBe(0n)
    expect(new Uint8Array(boxes[0].name)).toEqual(identityBoxName('treasury'))
  })

  test('buildUnsignedExecuteReleaseTxn: flat fee is at least EXECUTE_RELEASE_MIN_FEE', () => {
    const payToAddress = algosdk.generateAccount().addr.toString()
    const treasuryAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedExecuteReleaseTxn(
      APP_ID,
      multisigAddress,
      payToAddress,
      treasuryAddress,
      31566704,
      FAKE_SUGGESTED_PARAMS,
    )
    expect(txn.fee).toBeGreaterThanOrEqual(BigInt(EXECUTE_RELEASE_MIN_FEE))

    const higherFeeParams = { ...FAKE_SUGGESTED_PARAMS, minFee: 5_000n }
    const higherFeeTxn = buildUnsignedExecuteReleaseTxn(
      APP_ID,
      multisigAddress,
      payToAddress,
      treasuryAddress,
      31566704,
      higherFeeParams,
    )
    expect(higherFeeTxn.fee).toBe(5_000n)
  })
})

// --- Single-key deploy() refuses MainNet (ADR 0010) --------------------------------------------

describe('assertSingleKeyDeployNotMainnet', () => {
  test('refuses MainNet', () => {
    expect(() => assertSingleKeyDeployNotMainnet('mainnet')).toThrow(/ADR 0010/)
  })

  test('is a no-op on TestNet', () => {
    expect(() => assertSingleKeyDeployNotMainnet('testnet')).not.toThrow()
  })
})

describe('deploy() refuses MainNet before building any client or reading any mnemonic', () => {
  const ENV_KEYS = ['NETWORK', 'CONFIRM_MAINNET', 'PAY_TO_ADDRESS', 'OPS_ADDRESS', 'AUDITORS']
  let savedEnv: Record<string, string | undefined>

  beforeEach(() => {
    savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]))
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
    vi.restoreAllMocks()
  })

  test('NETWORK=mainnet: rejects and never calls AlgorandClient.fromConfig', async () => {
    process.env.NETWORK = 'mainnet'
    const fromConfigSpy = vi.spyOn(AlgorandClient, 'fromConfig')

    await expect(deploy()).rejects.toThrow(/ADR 0010/)
    expect(fromConfigSpy).not.toHaveBeenCalled()
  })

  test('NETWORK unset (defaults to mainnet): rejects and never calls AlgorandClient.fromConfig', async () => {
    delete process.env.NETWORK
    const fromConfigSpy = vi.spyOn(AlgorandClient, 'fromConfig')

    await expect(deploy()).rejects.toThrow(/ADR 0010/)
    expect(fromConfigSpy).not.toHaveBeenCalled()
  })

  test('NETWORK=testnet: proceeds past the guard and reads DEPLOYER/CREDITER mnemonics', async () => {
    process.env.NETWORK = 'testnet'
    process.env.PAY_TO_ADDRESS = algosdk.generateAccount().addr.toString()
    process.env.OPS_ADDRESS = algosdk.generateAccount().addr.toString()

    // One fixed fake signer for both DEPLOYER and CREDITER: deployPaymentRouter's own
    // assertCrediterDistinct then refuses (crediter === deployer) once it runs — proof this
    // TestNet call reaches deployPaymentRouter, well past the MainNet guard, without needing to
    // mock the rest of algod's chain calls.
    const fakeAddress = algosdk.generateAccount().addr.toString()
    const fromEnvironment = vi.fn().mockResolvedValue({ addr: { toString: () => fakeAddress } })
    const fakeAlgorandClient = {
      client: {
        algod: {
          getTransactionParams: () => ({ do: async () => ({ genesisID: 'testnet-v1.0' }) }),
        },
      },
      account: { fromEnvironment },
    }
    vi.spyOn(AlgorandClient, 'fromConfig').mockReturnValue(
      fakeAlgorandClient as unknown as AlgorandClient,
    )

    let caught: unknown
    try {
      await deploy()
    } catch (error) {
      caught = error
    }
    expect(caught).toBeInstanceOf(Error)
    expect((caught as Error).message).not.toMatch(/ADR 0010/)
    expect(fromEnvironment).toHaveBeenCalledWith('DEPLOYER')
    expect(fromEnvironment).toHaveBeenCalledWith('CREDITER')
  })
})
