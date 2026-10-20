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
  buildUnsignedAnnounceChangeTxn,
  buildUnsignedAnnounceReleaseTxn,
  buildUnsignedApplyChangeTxn,
  buildUnsignedCreateApplicationTxn,
  buildUnsignedExecuteReleaseTxn,
  buildUnsignedLowerPayoutCapTxn,
  buildUnsignedSetCrediterTxn,
  deploy,
  deployMultisigAnnounceChange,
  deployMultisigApplyChange,
  deployMultisigLowerPayoutCap,
  deployPaymentRouter,
  deriveAdminMultisigAddress,
  EXECUTE_RELEASE_MIN_FEE,
  encodeChangeValue,
  parseAdminMultisigAddrs,
  parseAppId,
  parseCarryIn,
  parseNetwork,
  parsePayoutCap,
  resolveClientConfig,
  resolveExecuteReleaseFee,
  resolveReleaseRounds,
  writeUnsignedTxnFile,
} from './deploy-config'

const FAKE_PROGRAMS = { approval: new Uint8Array([1, 2, 3]), clear: new Uint8Array([4, 5]) }

describe('resolveReleaseRounds', () => {
  test('MainNet is 216,000 and 216,000', async () => {
    expect(await resolveReleaseRounds('mainnet', {})).toEqual({ delay: 216_000, window: 216_000 })
  })

  test('MainNet accepts the same values stated in env', async () => {
    const env = { RELEASE_DELAY_ROUNDS: '216000', RELEASE_WINDOW_ROUNDS: '216000' }
    expect(await resolveReleaseRounds('mainnet', env)).toEqual({ delay: 216_000, window: 216_000 })
  })

  test('MainNet refuses a delay other than 216,000', async () => {
    await expect(resolveReleaseRounds('mainnet', { RELEASE_DELAY_ROUNDS: '20' })).rejects.toThrow(
      /RELEASE_DELAY_ROUNDS=20 is not allowed on MainNet/,
    )
  })

  test('MainNet refuses a window other than 216,000', async () => {
    await expect(resolveReleaseRounds('mainnet', { RELEASE_WINDOW_ROUNDS: '200' })).rejects.toThrow(
      /RELEASE_WINDOW_ROUNDS=200 is not allowed on MainNet/,
    )
  })

  test('TestNet defaults to delay 20 and window 200', async () => {
    expect(await resolveReleaseRounds('testnet', {})).toEqual({ delay: 20, window: 200 })
  })

  test('TestNet takes an env override', async () => {
    const env = { RELEASE_DELAY_ROUNDS: '5', RELEASE_WINDOW_ROUNDS: '60' }
    expect(await resolveReleaseRounds('testnet', env)).toEqual({ delay: 5, window: 60 })
  })
})

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
  test('refuses the ops address when it is not opted into USDC', () => {
    expect(() => assertOptedIntoUsdc('ops', 'OPS_ADDR', false)).toThrow(/not opted into USDC/)
  })

  test('refuses the treasury address when it is not opted into USDC', () => {
    expect(() => assertOptedIntoUsdc('treasury', 'TRS_ADDR', false)).toThrow(
      /treasury: that address is not opted into USDC/,
    )
  })

  test('passes when the address is opted into USDC', () => {
    expect(() => assertOptedIntoUsdc('ops', 'OPS_ADDR', true)).not.toThrow()
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

// --- Multisig creator --------------------------

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

  const opsAddress = algosdk.generateAccount().addr.toString()
  const treasuryAddress = algosdk.generateAccount().addr.toString()
  const receivers = { opsAddress, treasuryAddress }

  test('sets the sender to the multisig address and encodes all six ABI args', () => {
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      payToAddress,
      31566704,
      FAKE_SUGGESTED_PARAMS,
      receivers,
      5_000_000n,
      FAKE_PROGRAMS,
    )

    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs).toHaveLength(7)
    expect(appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature(
        'createApplication(address,uint64,uint64,address,address,uint64)void',
      ).getSelector(),
    )
    expect(new algosdk.ABIAddressType().decode(appArgs[1])).toBe(payToAddress)
    expect(new algosdk.ABIUintType(64).decode(appArgs[2])).toBe(31566704n)
    expect(new algosdk.ABIUintType(64).decode(appArgs[3])).toBe(0n)
    expect(new algosdk.ABIAddressType().decode(appArgs[4])).toBe(opsAddress)
    expect(new algosdk.ABIAddressType().decode(appArgs[5])).toBe(treasuryAddress)
    expect(new algosdk.ABIUintType(64).decode(appArgs[6])).toBe(5_000_000n)
  })

  test('sends the given compiled programs unchanged', () => {
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      payToAddress,
      31566704,
      FAKE_SUGGESTED_PARAMS,
      receivers,
      0n,
      FAKE_PROGRAMS,
    )
    expect(txn.applicationCall?.approvalProgram).toEqual(FAKE_PROGRAMS.approval)
    expect(txn.applicationCall?.clearProgram).toEqual(FAKE_PROGRAMS.clear)
  })

  test('the global schema comes from the spec and holds the release timing keys', () => {
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      payToAddress,
      31566704,
      FAKE_SUGGESTED_PARAMS,
      receivers,
      0n,
      FAKE_PROGRAMS,
    )
    expect(txn.applicationCall?.numGlobalInts).toBe(APP_SPEC.state.schema.global.ints)
    const keys = Object.values(APP_SPEC.state.keys.global).map((k) => k.key)
    expect(keys).toContain(Buffer.from('rdl').toString('base64'))
    expect(keys).toContain(Buffer.from('rwn').toString('base64'))
  })

  test('the signature matches the generated ARC-56 spec', () => {
    expect(() =>
      assertMethodSignatureMatchesSpec(
        'createApplication(address,uint64,uint64,address,address,uint64)void',
        APP_SPEC,
      ),
    ).not.toThrow()
  })

  test('encodes carryIn as the third ABI arg', () => {
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      payToAddress,
      31566704,
      FAKE_SUGGESTED_PARAMS,
      receivers,
      0n,
      FAKE_PROGRAMS,
      123_456n,
    )
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(new algosdk.ABIUintType(64).decode(appArgs[3])).toBe(123_456n)
  })

  test('a different payToAddress or usdcAssetId changes the encoded args, not the sender', () => {
    const otherPayTo = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      otherPayTo,
      10458941,
      FAKE_SUGGESTED_PARAMS,
      receivers,
      0n,
      FAKE_PROGRAMS,
    )
    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(new algosdk.ABIAddressType().decode(appArgs[1])).toBe(otherPayTo)
    expect(new algosdk.ABIUintType(64).decode(appArgs[2])).toBe(10458941n)
  })
})

describe('parsePayoutCap', () => {
  test('parses a non-negative integer', () => {
    expect(parsePayoutCap('0')).toBe(0n)
    expect(parsePayoutCap('5000000')).toBe(5_000_000n)
  })

  test('refuses unset, empty, negative and decimal values', () => {
    for (const bad of [undefined, '', '-1', '1.5', 'abc']) {
      expect(() => parsePayoutCap(bad)).toThrow(/PAYOUT_CAP must be a non-negative integer/)
    }
  })
})

describe('parseCarryIn', () => {
  test('unset or empty means 0', () => {
    expect(parseCarryIn(undefined)).toBe(0n)
    expect(parseCarryIn('')).toBe(0n)
  })

  test('parses a non-negative integer', () => {
    expect(parseCarryIn('250000')).toBe(250_000n)
  })

  test('refuses a negative, fractional or non-numeric value', () => {
    for (const bad of ['-1', '1.5', '1e3', 'abc']) {
      expect(() => parseCarryIn(bad)).toThrow('CARRY_IN must be a non-negative integer')
    }
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
    const txn = buildUnsignedCreateApplicationTxn(
      multisigAddress,
      payToAddress,
      31566704,
      {
        fee: 0n,
        minFee: 1000n,
        firstValid: 100n,
        lastValid: 1100n,
        genesisID: 'mainnet-v1.0',
        genesisHash: new Uint8Array(32),
        flatFee: false,
      },
      {
        opsAddress: algosdk.generateAccount().addr.toString(),
        treasuryAddress: algosdk.generateAccount().addr.toString(),
      },
      0n,
      FAKE_PROGRAMS,
    )

    const outPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-msig-')), 'create.txn')
    writeUnsignedTxnFile(txn, outPath)

    const decoded = algosdk.decodeUnsignedTransaction(new Uint8Array(fs.readFileSync(outPath)))
    expect(decoded.sender.toString()).toBe(multisigAddress)
    const decodedArgs = (decoded.applicationCall?.appArgs ?? []).map((a) => new Uint8Array(a))
    const originalArgs = (txn.applicationCall?.appArgs ?? []).map((a) => new Uint8Array(a))
    expect(decodedArgs).toEqual(originalArgs)
  })
})

// --- Admin-call multisig builders -------------------------------------

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
    // releaseAuthority(address), not announceRelease/executeRelease, until a human
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

  test('buildUnsignedExecuteReleaseTxn: no args, payTo as the only foreign account, no box', () => {
    const payToAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedExecuteReleaseTxn(
      APP_ID,
      multisigAddress,
      payToAddress,
      FAKE_SUGGESTED_PARAMS,
    )
    expect(txn.sender.toString()).toBe(multisigAddress)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs).toHaveLength(1)
    expect(appArgs[0]).toEqual(
      algosdk.ABIMethod.fromSignature('executeRelease()void').getSelector(),
    )

    const accounts = (txn.applicationCall?.accounts ?? []).map((a) => a.toString())
    expect(accounts).toEqual([payToAddress])
    expect(txn.applicationCall?.foreignAssets ?? []).toHaveLength(0)
    expect(txn.applicationCall?.boxes ?? []).toHaveLength(0)
  })

  test('buildUnsignedExecuteReleaseTxn: flat fee is at least EXECUTE_RELEASE_MIN_FEE', () => {
    const payToAddress = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedExecuteReleaseTxn(
      APP_ID,
      multisigAddress,
      payToAddress,
      FAKE_SUGGESTED_PARAMS,
    )
    expect(txn.fee).toBeGreaterThanOrEqual(BigInt(EXECUTE_RELEASE_MIN_FEE))

    const higherFeeParams = { ...FAKE_SUGGESTED_PARAMS, minFee: 5_000n }
    const higherFeeTxn = buildUnsignedExecuteReleaseTxn(
      APP_ID,
      multisigAddress,
      payToAddress,
      higherFeeParams,
    )
    expect(higherFeeTxn.fee).toBe(5_000n)
  })
})

describe('payout cap and pending-change builders', () => {
  const addrs = [
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
    algosdk.generateAccount().addr.toString(),
  ]
  const multisigAddress = deriveAdminMultisigAddress(buildAdminMultisigParams(addrs))
  const APP_ID = 772553842n
  const PARAMS: algosdk.SuggestedParams = {
    fee: 0n,
    minFee: 1_000n,
    firstValid: 100n,
    lastValid: 1_100n,
    genesisID: 'mainnet-v1.0',
    genesisHash: new Uint8Array(32),
    flatFee: false,
  }
  const MAX_U64 = 2n ** 64n - 1n

  function selector(signature: string): Uint8Array {
    return algosdk.ABIMethod.fromSignature(signature).getSelector()
  }

  test.each([0n, 1n, 1_000_000n, MAX_U64])('lowerPayoutCap encodes cap %s', (cap) => {
    const txn = buildUnsignedLowerPayoutCapTxn(APP_ID, multisigAddress, cap, PARAMS)
    expect(txn.sender.toString()).toBe(multisigAddress)
    expect(txn.applicationCall?.appIndex).toBe(APP_ID)
    expect(txn.applicationCall?.onComplete).toBe(algosdk.OnApplicationComplete.NoOpOC)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs).toHaveLength(2)
    expect(appArgs[0]).toEqual(selector('lowerPayoutCap(uint64)void'))
    expect(new algosdk.ABIUintType(64).decode(appArgs[1])).toBe(cap)
  })

  test('lowerPayoutCap rejects a negative cap and a cap above 2^64-1', () => {
    expect(() => buildUnsignedLowerPayoutCapTxn(APP_ID, multisigAddress, -1n, PARAMS)).toThrow(
      /cap must be between 0 and 2\^64-1/,
    )
    expect(() =>
      buildUnsignedLowerPayoutCapTxn(APP_ID, multisigAddress, MAX_U64 + 1n, PARAMS),
    ).toThrow(/cap must be between 0 and 2\^64-1/)
  })

  test.each([
    [0n, '0000000000000000'],
    [1n, '0000000000000001'],
    [MAX_U64, 'ffffffffffffffff'],
  ])('announceChange cap %s is 8 bytes big-endian', (cap, hex) => {
    const txn = buildUnsignedAnnounceChangeTxn(APP_ID, multisigAddress, 'cap', cap, PARAMS)
    expect(txn.sender.toString()).toBe(multisigAddress)
    expect(txn.applicationCall?.appIndex).toBe(APP_ID)
    expect(txn.applicationCall?.onComplete).toBe(algosdk.OnApplicationComplete.NoOpOC)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(appArgs).toHaveLength(3)
    expect(appArgs[0]).toEqual(selector('announceChange(string,byte[])void'))
    expect(new algosdk.ABIStringType().decode(appArgs[1])).toBe('cap')
    const value = algosdk.ABIType.from('byte[]').decode(appArgs[2]) as Uint8Array
    expect(Buffer.from(value).toString('hex')).toBe(hex)
  })

  test.each(['ops', 'trs'] as const)('announceChange %s carries the 32 public-key bytes', (key) => {
    const address = algosdk.generateAccount().addr.toString()
    const txn = buildUnsignedAnnounceChangeTxn(APP_ID, multisigAddress, key, address, PARAMS)
    const appArgs = txn.applicationCall?.appArgs ?? []
    expect(new algosdk.ABIStringType().decode(appArgs[1])).toBe(key)
    const value = algosdk.ABIType.from('byte[]').decode(appArgs[2]) as Uint8Array
    expect(value).toHaveLength(32)
    expect(Buffer.from(value).toString('hex')).toBe(
      Buffer.from(algosdk.decodeAddress(address).publicKey).toString('hex'),
    )
  })

  test('announceChange rejects an unknown key, a bad address and an out-of-range cap', () => {
    const address = algosdk.generateAccount().addr.toString()
    const build = (key: string, value: bigint | string) =>
      buildUnsignedAnnounceChangeTxn(APP_ID, multisigAddress, key as 'cap', value, PARAMS)
    expect(() => build('fee', address)).toThrow(/unknown change key "fee"/)
    expect(() => build('ops', 'not-an-address')).toThrow(/valid Algorand address/)
    expect(() => build('trs', 5n)).toThrow(/valid Algorand address/)
    expect(() => build('cap', address)).toThrow(/cap change value must be a bigint/)
    expect(() => build('cap', -1n)).toThrow(/cap must be between 0 and 2\^64-1/)
    expect(() => build('cap', MAX_U64 + 1n)).toThrow(/cap must be between 0 and 2\^64-1/)
  })

  test('encodeChangeValue rejects an unknown key', () => {
    expect(() => encodeChangeValue('', 1n)).toThrow(/unknown change key/)
  })

  test('applyChange has the selector only', () => {
    const txn = buildUnsignedApplyChangeTxn(APP_ID, multisigAddress, PARAMS)
    expect(txn.sender.toString()).toBe(multisigAddress)
    expect(txn.applicationCall?.appIndex).toBe(APP_ID)
    expect(txn.applicationCall?.onComplete).toBe(algosdk.OnApplicationComplete.NoOpOC)
    expect(txn.applicationCall?.appArgs).toEqual([selector('applyChange()void')])
  })
})

describe('payout cap and pending-change entry points', () => {
  const saved = { ...process.env }
  afterEach(() => {
    process.env = { ...saved }
  })

  test('deployMultisigLowerPayoutCap fails without PAYOUT_CAP', async () => {
    delete process.env.PAYOUT_CAP
    await expect(deployMultisigLowerPayoutCap()).rejects.toThrow(/PAYOUT_CAP must be/)
  })

  test('deployMultisigAnnounceChange fails without CHANGE_KEY or CHANGE_VALUE', async () => {
    delete process.env.CHANGE_KEY
    delete process.env.CHANGE_VALUE
    await expect(deployMultisigAnnounceChange()).rejects.toThrow(/CHANGE_KEY is not set/)
    process.env.CHANGE_KEY = 'cap'
    await expect(deployMultisigAnnounceChange()).rejects.toThrow(/CHANGE_VALUE is not set/)
    process.env.CHANGE_KEY = 'fee'
    process.env.CHANGE_VALUE = '1'
    await expect(deployMultisigAnnounceChange()).rejects.toThrow(/CHANGE_KEY must be/)
    process.env.CHANGE_KEY = 'cap'
    process.env.CHANGE_VALUE = '-1'
    await expect(deployMultisigAnnounceChange()).rejects.toThrow(/PAYOUT_CAP must be/)
  })

  test('deployMultisigApplyChange fails without the multisig addresses', async () => {
    delete process.env.AUPM_ADMIN_MSIG_ADDRS
    process.env.NETWORK = 'testnet'
    await expect(deployMultisigApplyChange()).rejects.toThrow(/AUPM_ADMIN_MSIG_ADDRS is not set/)
  })
})

// --- Single-key deploy() refuses MainNet --------------------------------------------

describe('assertSingleKeyDeployNotMainnet', () => {
  test('refuses MainNet', () => {
    expect(() => assertSingleKeyDeployNotMainnet('mainnet')).toThrow(
      /single-key deploy\(\) on MainNet/,
    )
  })

  test('is a no-op on TestNet', () => {
    expect(() => assertSingleKeyDeployNotMainnet('testnet')).not.toThrow()
  })
})

describe('deploy() refuses MainNet before building any client or reading any mnemonic', () => {
  const ENV_KEYS = [
    'NETWORK',
    'CONFIRM_MAINNET',
    'PAY_TO_ADDRESS',
    'OPS_ADDRESS',
    'TREASURY_ADDRESS',
    'PAYOUT_CAP',
  ]
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

    await expect(deploy()).rejects.toThrow(/single-key deploy\(\) on MainNet/)
    expect(fromConfigSpy).not.toHaveBeenCalled()
  })

  test('NETWORK unset (defaults to mainnet): rejects and never calls AlgorandClient.fromConfig', async () => {
    delete process.env.NETWORK
    const fromConfigSpy = vi.spyOn(AlgorandClient, 'fromConfig')

    await expect(deploy()).rejects.toThrow(/single-key deploy\(\) on MainNet/)
    expect(fromConfigSpy).not.toHaveBeenCalled()
  })

  test('NETWORK=testnet: proceeds past the guard and reads DEPLOYER/CREDITER mnemonics', async () => {
    process.env.NETWORK = 'testnet'
    process.env.PAY_TO_ADDRESS = algosdk.generateAccount().addr.toString()
    process.env.OPS_ADDRESS = algosdk.generateAccount().addr.toString()
    process.env.TREASURY_ADDRESS = algosdk.generateAccount().addr.toString()
    process.env.PAYOUT_CAP = '5000000'

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
    expect((caught as Error).message).not.toMatch(/single-key deploy\(\) on MainNet/)
    expect(fromEnvironment).toHaveBeenCalledWith('DEPLOYER')
    expect(fromEnvironment).toHaveBeenCalledWith('CREDITER')
  })
})

describe('deployPaymentRouter substitutes the release timing of the network', () => {
  const deployWith = async (network: 'mainnet' | 'testnet') => {
    const usdc = network === 'mainnet' ? 31566704 : 10458941
    const deployCall = vi.fn().mockResolvedValue({
      appClient: {
        appId: 1n,
        appAddress: { toString: () => 'APP' },
        send: { setCrediter: vi.fn().mockResolvedValue({}) },
      },
      result: { operationPerformed: 'create' },
    })
    const algorand = {
      client: {
        algod: {
          accountInformation: () => ({ do: async () => ({ assets: [{ assetId: BigInt(usdc) }] }) }),
        },
        getTypedAppFactory: () => ({ deploy: deployCall }),
      },
    } as unknown as AlgorandClient
    await deployPaymentRouter({
      algorand,
      network,
      deployer: { addr: { toString: () => 'DEPLOYER' } } as never,
      crediterAddress: 'CREDITER',
      payToAddress: 'PAYTO',
      opsAddress: 'OPS',
      treasuryAddress: 'TREASURY',
      payoutCap: 5_000_000n,
    })
    return deployCall.mock.calls[0][0].deployTimeParams
  }

  afterEach(() => {
    delete process.env.RELEASE_DELAY_ROUNDS
    delete process.env.RELEASE_WINDOW_ROUNDS
  })

  test('TestNet deploys with delay 20 and window 200', async () => {
    expect(await deployWith('testnet')).toEqual({
      RELEASE_DELAY_ROUNDS: 20,
      RELEASE_WINDOW_ROUNDS: 200,
    })
  })

  test('MainNet deploys with delay 216,000 and window 216,000', async () => {
    expect(await deployWith('mainnet')).toEqual({
      RELEASE_DELAY_ROUNDS: 216_000,
      RELEASE_WINDOW_ROUNDS: 216_000,
    })
  })

  test('MainNet refuses another value from the environment before it deploys', async () => {
    process.env.RELEASE_DELAY_ROUNDS = '20'
    await expect(deployWith('mainnet')).rejects.toThrow(/not allowed on MainNet/)
  })
})
