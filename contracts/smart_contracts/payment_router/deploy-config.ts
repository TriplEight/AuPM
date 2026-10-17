import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AlgorandClient } from '@algorandfoundation/algokit-utils'
import type { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import type { Arc56Contract } from '@algorandfoundation/algokit-utils/types/app-arc56'
import type { AlgoClientConfig } from '@algorandfoundation/algokit-utils/types/network-client'
import algosdk from 'algosdk'
import type { BinaryState } from '../artifacts/payment_router/PaymentRouterClient'
import { APP_SPEC, PaymentRouterFactory } from '../artifacts/payment_router/PaymentRouterClient'

/**
 * The subset of scripts/network.mjs this package reuses: the per-network
 * algod/indexer endpoint defaults, overridable by ALGOD_SERVER/ALGOD_PORT/
 * ALGOD_TOKEN and INDEXER_URL/INDEXER_PORT/INDEXER_TOKEN. scripts/network.mjs
 * is the one place those defaults are written (scripts/optin-usdc.mjs
 * already imports it); repeating them here would be a
 * second table to keep in sync.
 */
interface NetworkEndpoints {
  algodEndpoint(network: 'mainnet' | 'testnet', env?: NodeJS.ProcessEnv): AlgoClientConfig
  indexerEndpoint(network: 'mainnet' | 'testnet', env?: NodeJS.ProcessEnv): AlgoClientConfig
}

// scripts/ is a plain ESM directory with no package.json of its own (see the
// banner comment in scripts/network.mjs); contracts/ compiles under
// "module": "CommonJS" (tsconfig.json). A dynamic import() of a .mjs path
// works at runtime under tsx (deploy and deploy:ci) and vitest —
// the Node loader treats .mjs as ESM regardless of the importer's module
// system — but only when the specifier is not a string literal TypeScript
// can resolve at compile time: allowJs is false here, so a literal import()
// of a path outside this package's rootDir would fail type-checking
// (TS2307, "Cannot find module") because there is no .d.ts for it. Building
// the specifier at runtime keeps the import untyped (cast below) without
// that compile-time failure, so this package still has no build-time
// dependency on the scripts/ directory's own module resolution.
//
// The specifier is resolved from `__dirname` to an absolute `file://` URL,
// not left as a relative string: vitest runs this file through its own SSR
// module graph (vite-node), which — unlike Node's native dynamic import()
// — does not resolve a non-literal relative specifier against the
// importing module's own path, so a relative string here fails only under
// vitest ("Cannot find module '/scripts/network.mjs'", i.e. resolved
// against something other than this file). An absolute `file://` URL needs
// no importer-relative resolution, so it works identically under all three
// runners.
const NETWORK_MODULE_PATH = path.resolve(__dirname, '..', '..', '..', 'scripts', 'network.mjs')

async function loadNetworkEndpoints(): Promise<NetworkEndpoints> {
  return (await import(pathToFileURL(NETWORK_MODULE_PATH).href)) as NetworkEndpoints
}

/**
 * The algod/indexer config `buildAlgorandClient` passes to
 * `AlgorandClient.fromConfig()`, split out as a pure async step (no
 * AlgorandClient construction, no network call) so a test can assert on the
 * resolved `{ server, port, token }` values directly. Exported for
 * deploy-config.spec.ts.
 *
 * @param network - the resolved network; picks the per-network default.
 * @param env - defaults to process.env; a test passes a fake env instead.
 */
export async function resolveClientConfig(
  network: 'mainnet' | 'testnet',
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ algodConfig: AlgoClientConfig; indexerConfig: AlgoClientConfig }> {
  const { algodEndpoint, indexerEndpoint } = await loadNetworkEndpoints()
  return {
    algodConfig: algodEndpoint(network, env),
    indexerConfig: indexerEndpoint(network, env),
  }
}

// USDC ASA id per network (MainNet 31566704,
// TestNet 10458941, rehearsal only). scripts/network.mjs reads the same ids
// from @x402-avm/avm for the proxy and the operator scripts. This package
// has no dependency on that workspace, so the two fixed ids are repeated
// here instead of imported.
const USDC_ASSET_ID: Readonly<Record<'mainnet' | 'testnet', number>> = {
  mainnet: 31566704,
  testnet: 10458941,
}

// algod genesis id per network. AlgorandClient.fromEnvironment() picks its
// algod from ALGOD_SERVER, which is independent of NETWORK — an operator
// could point NETWORK=testnet at a MainNet algod (or the reverse) and
// silently deploy against the wrong chain. assertNetworkMatchesGenesis
// closes that hole.
const GENESIS_ID: Readonly<Record<'mainnet' | 'testnet', string>> = {
  mainnet: 'mainnet-v1.0',
  testnet: 'testnet-v1.0',
}

/**
 * Picks the network from NETWORK ("mainnet" | "testnet"), defaulting to
 * mainnet — the deploy target. scripts/network.mjs uses the same default,
 * so an unset NETWORK never silently targets TestNet on either side.
 * Pure: no network access, covered directly by deploy-config.spec.ts.
 *
 * @param networkEnv - the raw NETWORK environment value.
 */
export function parseNetwork(networkEnv: string | undefined): 'mainnet' | 'testnet' {
  const value = (networkEnv ?? 'mainnet').toLowerCase()
  if (value !== 'mainnet' && value !== 'testnet') {
    throw new Error(`NETWORK must be "mainnet" or "testnet", got ${JSON.stringify(networkEnv)}`)
  }
  return value
}

/**
 * Refuses a MainNet deploy unless CONFIRM_MAINNET=1 is set. deploy() takes
 * no CLI arguments (index.ts calls it with none), so this reads an env var
 * instead of scripts/network.mjs's --confirm-mainnet flag. A no-op on
 * TestNet. Pure: covered directly by deploy-config.spec.ts.
 *
 * @param network - the resolved network.
 * @param confirmMainnetEnv - the raw CONFIRM_MAINNET environment value.
 */
export function assertMainnetConfirmed(
  network: 'mainnet' | 'testnet',
  confirmMainnetEnv: string | undefined,
): void {
  if (network === 'mainnet' && confirmMainnetEnv !== '1') {
    throw new Error(
      'refusing a MainNet deploy without CONFIRM_MAINNET=1: re-run with CONFIRM_MAINNET=1 to proceed',
    )
  }
}

/**
 * Refuses when the connected algod's genesis id does not match the
 * selected network. Pure: only compares the two strings; the genesis id
 * itself is read over the network by the caller.
 * Covered directly by deploy-config.spec.ts.
 *
 * @param network - the resolved network.
 * @param genesisId - the connected algod's genesis id.
 */
export function assertNetworkMatchesGenesis(
  network: 'mainnet' | 'testnet',
  genesisId: string,
): void {
  const expected = GENESIS_ID[network]
  if (genesisId !== expected) {
    throw new Error(
      `algod genesis id "${genesisId}" does not match NETWORK=${network} ` +
        `(expected "${expected}"); ALGOD_SERVER may be pointed at the wrong network`,
    )
  }
}

/**
 * Refuses when the crediter address coincides with any other named address.
 * The crediter key can call only credit(); it must never double as a cold
 * key (aupm-payment-router skill: never the deployer, the admin, the donor
 * or payTo). Pure: covered directly by deploy-config.spec.ts.
 *
 * @param crediterAddress - the address about to be set as the crediter.
 * @param others - other role addresses, keyed by a label for the error message.
 */
export function assertCrediterDistinct(
  crediterAddress: string,
  others: Record<string, string | undefined>,
): void {
  for (const [label, address] of Object.entries(others)) {
    if (address && address === crediterAddress) {
      throw new Error(`crediter must not equal ${label} (${address})`)
    }
  }
}

/**
 * Refuses a receiver address that is not opted into USDC. credit() sends USDC
 * to the ops and treasury addresses, so a receiver without an opt-in fails
 * every batch.
 * Pure: covered directly by deploy-config.spec.ts; the opt-in check itself
 * is an algod account lookup done by the caller.
 *
 * @param role - the role of the address ("ops" or "treasury").
 * @param address - the receiver address.
 * @param holdsAsset - whether that address's account already holds the USDC asset.
 */
export function assertOptedIntoUsdc(role: string, address: string, holdsAsset: boolean): void {
  if (!holdsAsset) {
    throw new Error(`refusing to use ${address} as ${role}: that address is not opted into USDC`)
  }
}

export interface DeployPaymentRouterParams {
  algorand: AlgorandClient
  network: 'mainnet' | 'testnet'
  deployer: TransactionSignerAccount
  crediterAddress: string
  payToAddress: string
  /** USDC micro-units at payTo that an earlier app did not pay out. Defaults to 0. */
  carryIn?: bigint
  /** Receiver of the ops share of every batch. */
  opsAddress: string
  /** Receiver of the treasury cut, extra and unattributed money of every batch. */
  treasuryAddress: string
  /** Cap on the payouts of one cap period, in USDC micro-units. */
  payoutCap: bigint
  /**
   * Overrides the app name algokit's idempotent `factory.deploy()` looks up
   * by (creator address + name). `deploy()` below leaves this unset and
   * keeps the operator's idempotent "PaymentRouter" behavior; a hermetic
   * rehearsal passes a unique name per run so it
   * never finds — and never touches — another run's leftover app.
   */
  appName?: string
  /**
   * Refuses unless this deploy performed a fresh "create" — never
   * "nothing"/"update"/"replace" (R3d, assertAppCreatedFresh below). Only
   * the hermetic rehearsal sets this: a live TestNet run found an earlier
   * failed rehearsal's leftover "PaymentRouter" app for the same deployer
   * and silently reused it, setting crediter/identities on the wrong app
   * before its own rekey guard caught the mismatch. `deploy()` never sets
   * this — its whole point is idempotent reuse.
   */
  requireFreshCreate?: boolean
}

export interface DeployPaymentRouterResult {
  appId: bigint
  appAddress: string
  operationPerformed: string
}

/**
 * Refuses unless `operationPerformed` is a fresh "create". Pure: covered
 * directly by deploy-config.spec.ts. See DeployPaymentRouterParams.requireFreshCreate.
 *
 * @param operationPerformed - the deploy result's own operationPerformed.
 */
export function assertAppCreatedFresh(operationPerformed: string): void {
  if (operationPerformed !== 'create') {
    throw new Error(
      `expected a fresh app creation but algokit's idempotent deploy performed ` +
        `"${operationPerformed}" instead of "create" — the rehearsal must use a unique ` +
        'app name per run (R3d)',
    )
  }
}

/**
 * Refuses to touch an idempotently-reused app whose stored payTo or USDC
 * asset does not match this deploy's own configuration. Pure: decoded
 * values are passed in — readExistingAppRouting below does the actual
 * (mockable) chain read. Call this — and let it pass — before any
 * setCrediter call (R3d): algokit's idempotent
 * `factory.deploy()` reuses any existing app with the same creator +
 * appName, and this deployer may have already created an earlier
 * PaymentRouter for a different payTo — setting the crediter on that app would silently
 * repoint an unrelated deployment.
 *
 * @param appId - the reused app's id (message only).
 * @param storedPayTo - the reused app's own stored payTo, decoded to an address.
 * @param storedAssetId - the reused app's own stored USDC asset id.
 * @param expectedPayTo - this deploy's configured payTo.
 * @param expectedAssetId - this deploy's configured USDC asset id.
 */
export function assertExistingAppMatchesConfig(
  appId: bigint,
  storedPayTo: string | undefined,
  storedAssetId: bigint | undefined,
  expectedPayTo: string,
  expectedAssetId: number,
): void {
  const assetMatches = storedAssetId !== undefined && Number(storedAssetId) === expectedAssetId
  if (storedPayTo !== expectedPayTo || !assetMatches) {
    throw new Error(
      `app id ${appId} already exists with stored payTo ${storedPayTo ?? '(none)'} and asset ` +
        `${storedAssetId ?? '(none)'} — this deployer already owns a PaymentRouter for another ` +
        'payTo; use a different deployer account',
    )
  }
}

/**
 * Reads an existing (idempotently-reused) app's own stored payTo and asset
 * id off its global state. `appClient` is the minimal shape this needs —
 * a real typed PaymentRouterClient satisfies it, and so does a fabricated
 * one in deploy-config.spec.ts, so assertExistingAppSafeToReuse below is
 * unit-tested with the chain mocked, never a live algod call.
 */
async function readExistingAppRouting(appClient: {
  appId: bigint
  state: { global: { payTo(): Promise<BinaryState>; assetId(): Promise<bigint | undefined> } }
}): Promise<{ appId: bigint; storedPayTo: string | undefined; storedAssetId: bigint | undefined }> {
  const payToBytes = (await appClient.state.global.payTo()).asByteArray()
  const storedPayTo = payToBytes ? algosdk.encodeAddress(payToBytes) : undefined
  const storedAssetId = await appClient.state.global.assetId()
  return { appId: appClient.appId, storedPayTo, storedAssetId }
}

/**
 * Reads a reused app's routing and refuses if it does not match this
 * deploy's configuration (assertExistingAppMatchesConfig). The one call
 * site (deployPaymentRouter below) runs this before any
 * setCrediter call, on both the operator and rehearsal paths.
 */
export async function assertExistingAppSafeToReuse(
  appClient: {
    appId: bigint
    state: { global: { payTo(): Promise<BinaryState>; assetId(): Promise<bigint | undefined> } }
  },
  expectedPayTo: string,
  expectedAssetId: number,
): Promise<void> {
  const { appId, storedPayTo, storedAssetId } = await readExistingAppRouting(appClient)
  assertExistingAppMatchesConfig(appId, storedPayTo, storedAssetId, expectedPayTo, expectedAssetId)
}

/**
 * Deploys PaymentRouter and sets the crediter key. The app holds no box, so
 * the app account needs no funding.
 * Does not rekey payTo — that is scripts/rekey-payto.mjs, run
 * separately with the payTo key, after payTo already holds USDC.
 *
 * Explicit-argument core of `deploy()` below, so a TestNet rehearsal script
 * can deploy a fresh app for fresh, in-memory accounts without reading
 * `deploy()`'s own environment variables (R3a).
 */
export async function deployPaymentRouter(
  params: DeployPaymentRouterParams,
): Promise<DeployPaymentRouterResult> {
  const {
    algorand,
    network,
    deployer,
    crediterAddress,
    payToAddress,
    carryIn = 0n,
    opsAddress,
    treasuryAddress,
    payoutCap,
    appName,
    requireFreshCreate,
  } = params
  const deployerAddress = deployer.addr.toString()
  // The deployer is Global.creatorAddress, i.e. the admin — contract.algo.ts
  // has no separate admin key. Checked once, under one label per role.
  assertCrediterDistinct(crediterAddress, {
    deployer: deployerAddress,
    admin: deployerAddress,
    payTo: payToAddress,
  })

  const usdcAssetId = USDC_ASSET_ID[network]
  for (const [role, address] of [
    ['ops', opsAddress],
    ['treasury', treasuryAddress],
  ]) {
    const info = await algorand.client.algod.accountInformation(address).do()
    const holdsAsset = (info.assets ?? []).some((a) => Number(a.assetId) === usdcAssetId)
    assertOptedIntoUsdc(role, address, holdsAsset)
  }

  const factory = algorand.client.getTypedAppFactory(PaymentRouterFactory, {
    defaultSender: deployer.addr,
    ...(appName ? { appName } : {}),
  })

  const { appClient, result } = await factory.deploy({
    createParams: {
      method: 'createApplication',
      args: {
        payTo: payToAddress,
        usdcAsset: usdcAssetId,
        carryIn,
        opsAddress,
        treasuryAddress,
        payoutCap,
      },
    },
    onUpdate: 'append',
    onSchemaBreak: 'append',
  })

  if (result.operationPerformed !== 'create') {
    // Idempotent reuse (R3d): factory.deploy() found and reused an
    // existing app for this creator + appName. Refuse before touching it
    // any further — requireFreshCreate (the rehearsal) refuses outright;
    // the operator path only refuses if the reused app's own routing
    // disagrees with this deploy's configuration.
    if (requireFreshCreate) {
      assertAppCreatedFresh(result.operationPerformed)
    }
    await assertExistingAppSafeToReuse(appClient, payToAddress, usdcAssetId)
  }

  await appClient.send.setCrediter({ args: { addr: crediterAddress } })
  console.log(`Set crediter to ${crediterAddress}.`)

  console.log(
    `PaymentRouter app id: ${appClient.appId}. Next: fund payTo with USDC, then run ` +
      'scripts/rekey-payto.mjs with the payTo key.',
  )

  return {
    appId: appClient.appId,
    appAddress: appClient.appAddress.toString(),
    operationPerformed: result.operationPerformed,
  }
}

/**
 * Builds the AlgorandClient from explicit algod/indexer config instead of
 * `AlgorandClient.fromEnvironment()`, which reads `INDEXER_SERVER` — not
 * this repo's `INDEXER_URL` (.env.example, scripts/network.mjs). Without
 * this, an operator's INDEXER_URL is silently ignored and
 * fromEnvironment() falls back to a LocalNet indexer that does not exist
 * outside development, surfacing only as an opaque "Didn't receive an
 * indexer client" error deep inside algokit's deploy path.
 *
 * @param network - the resolved network; picks the per-network default.
 */
async function buildAlgorandClient(network: 'mainnet' | 'testnet'): Promise<AlgorandClient> {
  return AlgorandClient.fromConfig(await resolveClientConfig(network))
}

// --- 2-of-3 admin multisig creator ------------------
//
// Global.creatorAddress must be a 2-of-3 Algorand multisig, never one key:
// no single lost or leaked key can call setCrediter,
// announceRelease, or executeRelease alone. This workstation
// never holds two of the three admin private keys at once, so the create
// call — like every later admin call — cannot be signed here in one step.
// The offline signing ceremony (`goal`, not algokit, since the holders sign
// independently, not through one shared AlgorandClient):
//   1. deployMultisigCreate() below writes the unsigned createApplication
//      call to a file (PAYMENT_ROUTER_MSIG_CREATE_TXN_PATH).
//   2. Each signing holder imports the 3 addresses and threshold 2 into
//      `goal` once: `goal account multisig new <addr1> <addr2> <addr3> -T 2`.
//   3. Two of the three holders each sign the same file in turn:
//      `goal clerk multisig sign -t payment-router-create.txn`.
//   4. Whoever holds the twice-signed file POSTs it to the target network's
//      algod (`/v2/transactions`, Content-Type application/x-binary), then
//      records the resulting app id as PAYMENT_ROUTER_APP_ID. Not
//      `algokit goal clerk rawsend`: that goal runs in the LocalNet container
//      and sends to LocalNet.
// setCrediter/announceRelease/executeRelease follow the same
// build-sign-submit shape afterwards (the deployMultisig* entry points below).

export const ADMIN_MSIG_THRESHOLD = 2

/**
 * Parses AUPM_ADMIN_MSIG_ADDRS ("addr1,addr2,addr3") into exactly three
 * distinct, valid Algorand addresses — the admin multisig's signer set
 * Pure: covered directly by deploy-config.spec.ts.
 *
 * @param addrsEnv - the raw AUPM_ADMIN_MSIG_ADDRS environment value.
 */
export function parseAdminMultisigAddrs(addrsEnv: string | undefined): string[] {
  const raw = (addrsEnv ?? '').trim()
  if (!raw) {
    throw new Error('AUPM_ADMIN_MSIG_ADDRS is not set (the creator is a 2-of-3 multisig)')
  }
  const addrs = raw
    .split(',')
    .map((a) => a.trim())
    .filter(Boolean)
  if (addrs.length !== 3) {
    throw new Error(`AUPM_ADMIN_MSIG_ADDRS must list exactly 3 addresses, got ${addrs.length}`)
  }
  for (const addr of addrs) {
    if (!algosdk.isValidAddress(addr)) {
      throw new Error(`AUPM_ADMIN_MSIG_ADDRS contains an invalid Algorand address: ${addr}`)
    }
  }
  if (new Set(addrs).size !== addrs.length) {
    throw new Error('AUPM_ADMIN_MSIG_ADDRS addresses must be distinct')
  }
  return addrs
}

/**
 * The algosdk multisig metadata for the fixed 2-of-3 admin multisig
 * The threshold is always ADMIN_MSIG_THRESHOLD — never read
 * from the environment. Pure: covered directly by deploy-config.spec.ts.
 *
 * @param addrs - the three signer addresses (parseAdminMultisigAddrs).
 */
export function buildAdminMultisigParams(addrs: string[]): algosdk.MultisigMetadata {
  return { version: 1, threshold: ADMIN_MSIG_THRESHOLD, addrs }
}

/**
 * Derives the multisig account's own address from its metadata — this
 * becomes Global.creatorAddress once the create call lands. Pure: covered
 * directly by deploy-config.spec.ts.
 *
 * @param params - the multisig metadata (buildAdminMultisigParams).
 */
export function deriveAdminMultisigAddress(params: algosdk.MultisigMetadata): string {
  return algosdk.multisigAddress(params).toString()
}

/**
 * Parses CARRY_IN (USDC micro-units, a non-negative integer) for createApplication. Unset
 * means 0. Pure: covered directly by deploy-config.spec.ts.
 *
 * @param carryInEnv - the raw CARRY_IN environment value.
 */
export function parseCarryIn(carryInEnv: string | undefined): bigint {
  if (carryInEnv === undefined || carryInEnv === '') return 0n
  if (!/^\d+$/.test(carryInEnv)) {
    throw new Error(`CARRY_IN must be a non-negative integer, got ${JSON.stringify(carryInEnv)}`)
  }
  return BigInt(carryInEnv)
}

const CREATE_APPLICATION_METHOD_SIGNATURE =
  'createApplication(address,uint64,uint64,address,address,uint64)void'

/**
 * Builds the unsigned createApplication call, sender set
 * to the admin multisig address, ready for the offline goal signing flow
 * documented above. Reads the compiled approval/clear programs and the
 * global state schema straight off the generated ARC-56 spec — never
 * hand-copied — so it always matches whatever `algokit project run build`
 * last produced. Pure given `suggestedParams`: no network access, so
 * deploy-config.spec.ts covers it directly with a fabricated suggestedParams
 * object.
 *
 * @param multisigAddress - the 2-of-3 admin multisig address (deriveAdminMultisigAddress).
 * @param payToAddress - the payTo account this deploy fixes at creation.
 * @param usdcAssetId - the USDC asset id for the target network.
 * @param suggestedParams - the algod transaction params (fee, validity window, genesis).
 * @param receivers - the ops and treasury receiver addresses.
 * @param payoutCap - the cap on the payouts of one cap period, in USDC micro-units.
 * @param carryIn - USDC micro-units at payTo that an earlier app did not pay out. Defaults to 0.
 */
export function buildUnsignedCreateApplicationTxn(
  multisigAddress: string,
  payToAddress: string,
  usdcAssetId: number,
  suggestedParams: algosdk.SuggestedParams,
  receivers: { opsAddress: string; treasuryAddress: string },
  payoutCap: bigint,
  carryIn: bigint = 0n,
): algosdk.Transaction {
  if (!APP_SPEC.byteCode) {
    throw new Error(
      'PaymentRouter.arc56.json has no byteCode — run `algokit project run build` first',
    )
  }
  const method = algosdk.ABIMethod.fromSignature(CREATE_APPLICATION_METHOD_SIGNATURE)
  const appArgs = [
    method.getSelector(),
    new algosdk.ABIAddressType().encode(payToAddress),
    new algosdk.ABIUintType(64).encode(usdcAssetId),
    new algosdk.ABIUintType(64).encode(carryIn),
    new algosdk.ABIAddressType().encode(receivers.opsAddress),
    new algosdk.ABIAddressType().encode(receivers.treasuryAddress),
    new algosdk.ABIUintType(64).encode(payoutCap),
  ]
  const schema = APP_SPEC.state.schema
  return algosdk.makeApplicationCreateTxnFromObject({
    sender: multisigAddress,
    suggestedParams,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    approvalProgram: new Uint8Array(Buffer.from(APP_SPEC.byteCode.approval, 'base64')),
    clearProgram: new Uint8Array(Buffer.from(APP_SPEC.byteCode.clear, 'base64')),
    numGlobalInts: schema.global.ints,
    numGlobalByteSlices: schema.global.bytes,
    numLocalInts: schema.local.ints,
    numLocalByteSlices: schema.local.bytes,
    appArgs,
  })
}

/**
 * Writes an unsigned transaction to `outPath` in algosdk's own msgpack
 * encoding — the format `goal clerk sign`/`multisig sign` read. Pure I/O:
 * covered directly by deploy-config.spec.ts with a temp file.
 *
 * @param txn - the unsigned transaction (buildUnsignedCreateApplicationTxn).
 * @param outPath - the file path to write.
 */
export function writeUnsignedTxnFile(txn: algosdk.Transaction, outPath: string): void {
  fs.writeFileSync(outPath, algosdk.encodeUnsignedTransaction(txn))
}

/**
 * Parses PAYOUT_CAP (USDC micro-units per cap period, a non-negative integer). Pure: covered
 * directly by deploy-config.spec.ts.
 *
 * @param payoutCapEnv - the raw PAYOUT_CAP environment value.
 */
export function parsePayoutCap(payoutCapEnv: string | undefined): bigint {
  if (payoutCapEnv === undefined || !/^\d+$/.test(payoutCapEnv)) {
    throw new Error(
      `PAYOUT_CAP must be a non-negative integer, got ${JSON.stringify(payoutCapEnv)}`,
    )
  }
  return BigInt(payoutCapEnv)
}

/**
 * CLI entry point: builds PaymentRouter's createApplication call for the
 * 2-of-3 admin multisig (AUPM_ADMIN_MSIG_ADDRS, threshold fixed at
 * ADMIN_MSIG_THRESHOLD) and writes it, unsigned, to
 * PAYMENT_ROUTER_MSIG_CREATE_TXN_PATH (default ./payment-router-create.txn).
 * Never signs or sends it — see the module comment above for the offline
 * goal flow that does. Refuses on MainNet without CONFIRM_MAINNET=1, and
 * refuses when the connected algod's genesis id does not match NETWORK.
 */
export async function deployMultisigCreate(): Promise<void> {
  const network = parseNetwork(process.env.NETWORK)
  assertMainnetConfirmed(network, process.env.CONFIRM_MAINNET)

  const addrs = parseAdminMultisigAddrs(process.env.AUPM_ADMIN_MSIG_ADDRS)
  const multisigAddress = deriveAdminMultisigAddress(buildAdminMultisigParams(addrs))

  const payToAddress = process.env.PAY_TO_ADDRESS
  if (!payToAddress) throw new Error('PAY_TO_ADDRESS is not set')

  const opsAddress = process.env.OPS_ADDRESS
  if (!opsAddress) throw new Error('OPS_ADDRESS is not set')
  const treasuryAddress = process.env.TREASURY_ADDRESS
  if (!treasuryAddress) throw new Error('TREASURY_ADDRESS is not set')
  const payoutCap = parsePayoutCap(process.env.PAYOUT_CAP)

  const algorand = await buildAlgorandClient(network)
  const suggestedParams = await algorand.client.algod.getTransactionParams().do()
  assertNetworkMatchesGenesis(network, suggestedParams.genesisID ?? '')

  const txn = buildUnsignedCreateApplicationTxn(
    multisigAddress,
    payToAddress,
    USDC_ASSET_ID[network],
    suggestedParams,
    { opsAddress, treasuryAddress },
    payoutCap,
    parseCarryIn(process.env.CARRY_IN),
  )

  const outPath = process.env.PAYMENT_ROUTER_MSIG_CREATE_TXN_PATH ?? './payment-router-create.txn'
  writeUnsignedTxnFile(txn, outPath)

  console.log(`Admin multisig address (2-of-3): ${multisigAddress}`)
  printMultisigSigningInstructions('createApplication', outPath)
}

// --- 2-of-3 admin multisig: post-creation admin calls ------------------------------
//
// setCrediter, announceRelease and executeRelease are admin-only
// (contract.algo.ts: each asserts `Txn.sender.bytes === Global.creatorAddress.bytes`), so each
// needs the same offline multisig flow as deployMultisigCreate above: build the unsigned call
// here, write it to a file, two of the three holders sign it in turn with `goal clerk multisig
// sign`, then whoever holds the twice-signed file POSTs it to the network's algod.
//
// The three signatures below are hand-written from contract.algo.ts's own method declarations.
// assertMethodSignatureMatchesSpec fails loudly if the generated ARC-56 spec (APP_SPEC) ever
// disagrees with any of them.

const SET_CREDITER_METHOD_SIGNATURE = 'setCrediter(address)void'
const ANNOUNCE_RELEASE_METHOD_SIGNATURE = 'announceRelease(address)void'
const EXECUTE_RELEASE_METHOD_SIGNATURE = 'executeRelease()void'

/**
 * The flat outer fee executeRelease() uses. It submits one inner transaction (the payTo rekey
 * payment), which needs the network's own minimum fee pooled through the outer call, on top of
 * the outer call's own fee. The flat value keeps headroom. Never read from the environment.
 */
export const EXECUTE_RELEASE_MIN_FEE = 3_000

/**
 * Refuses when a hand-written method signature disagrees with the same-named method in the
 * ARC-56 spec. A no-op when the spec does not declare the method at all. Pure: covered
 * directly by deploy-config.spec.ts.
 *
 * @param signature - the hand-written ABI method signature, e.g. "announceRelease(address)void".
 * @param appSpec - the generated ARC-56 spec (APP_SPEC).
 */
export function assertMethodSignatureMatchesSpec(signature: string, appSpec: Arc56Contract): void {
  const methodName = signature.slice(0, signature.indexOf('('))
  const specMethod = appSpec.methods.find((m) => m.name === methodName)
  if (!specMethod) return
  const specSignature = `${specMethod.name}(${specMethod.args.map((a) => a.type).join(',')})${specMethod.returns.type}`
  if (specSignature !== signature) {
    throw new Error(
      `${methodName}: hand-written signature "${signature}" disagrees with the rebuilt ARC-56 ` +
        `spec's "${specSignature}" — update the hand-written signature in deploy-config.ts`,
    )
  }
}

/**
 * Parses PAYMENT_ROUTER_APP_ID into a positive app id. Every call built below targets an
 * already-deployed app, unlike deployMultisigCreate's own createApplication call. Pure: covered
 * directly by deploy-config.spec.ts.
 *
 * @param appIdEnv - the raw PAYMENT_ROUTER_APP_ID environment value.
 */
export function parseAppId(appIdEnv: string | undefined): bigint {
  if (!appIdEnv) {
    throw new Error('PAYMENT_ROUTER_APP_ID is not set')
  }
  let appId: bigint
  try {
    appId = BigInt(appIdEnv)
  } catch {
    throw new Error(`PAYMENT_ROUTER_APP_ID must be an integer, got ${JSON.stringify(appIdEnv)}`)
  }
  if (appId <= BigInt(0)) {
    throw new Error(`PAYMENT_ROUTER_APP_ID must be a positive integer, got ${appIdEnv}`)
  }
  return appId
}

/**
 * The flat outer fee executeRelease() needs, given the network's own suggested minimum fee:
 * never below EXECUTE_RELEASE_MIN_FEE, even when the network's suggested fee is lower. Mirrors
 * scripts/claim.mjs's resolveOuterFee. Pure: covered directly by deploy-config.spec.ts.
 *
 * @param baseFee - the network's own suggested minimum fee.
 */
export function resolveExecuteReleaseFee(baseFee: number): number {
  return baseFee >= EXECUTE_RELEASE_MIN_FEE ? baseFee : EXECUTE_RELEASE_MIN_FEE
}

/**
 * Builds the unsigned setCrediter(addr) call, sender set to the admin multisig address.
 *
 * @param appId - the deployed PaymentRouter app id (parseAppId).
 * @param multisigAddress - the 2-of-3 admin multisig address (deriveAdminMultisigAddress).
 * @param crediterAddress - the address to authorize as crediter.
 * @param suggestedParams - the algod transaction params.
 */
export function buildUnsignedSetCrediterTxn(
  appId: bigint,
  multisigAddress: string,
  crediterAddress: string,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.Transaction {
  assertMethodSignatureMatchesSpec(SET_CREDITER_METHOD_SIGNATURE, APP_SPEC)
  const method = algosdk.ABIMethod.fromSignature(SET_CREDITER_METHOD_SIGNATURE)
  return algosdk.makeApplicationCallTxnFromObject({
    sender: multisigAddress,
    appIndex: appId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [method.getSelector(), new algosdk.ABIAddressType().encode(crediterAddress)],
    suggestedParams,
  })
}

/**
 * Builds the unsigned announceRelease(to) call, sender set to the admin multisig address. Reads
 * and writes only global state (contract.algo.ts's announcedTo/announcedRound), so it needs no
 * box or foreign reference beyond the app call itself.
 *
 * @param appId - the deployed PaymentRouter app id (parseAppId).
 * @param multisigAddress - the 2-of-3 admin multisig address (deriveAdminMultisigAddress).
 * @param toAddress - the migration target; `payTo`'s own address when the rekey target is
 *   `payTo` itself.
 * @param suggestedParams - the algod transaction params.
 */
export function buildUnsignedAnnounceReleaseTxn(
  appId: bigint,
  multisigAddress: string,
  toAddress: string,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.Transaction {
  assertMethodSignatureMatchesSpec(ANNOUNCE_RELEASE_METHOD_SIGNATURE, APP_SPEC)
  const method = algosdk.ABIMethod.fromSignature(ANNOUNCE_RELEASE_METHOD_SIGNATURE)
  return algosdk.makeApplicationCallTxnFromObject({
    sender: multisigAddress,
    appIndex: appId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [method.getSelector(), new algosdk.ABIAddressType().encode(toAddress)],
    suggestedParams,
  })
}

/**
 * Builds the unsigned executeRelease() call, sender set to the admin multisig address. Sets a
 * flat outer fee of at least EXECUTE_RELEASE_MIN_FEE (resolveExecuteReleaseFee) to cover the
 * inner rekey transaction. Attaches `payTo` as a foreign account, because it is the sender of
 * that inner transaction.
 *
 * @param appId - the deployed PaymentRouter app id (parseAppId).
 * @param multisigAddress - the 2-of-3 admin multisig address (deriveAdminMultisigAddress).
 * @param payToAddress - `payTo` (the rekey sender, contract.algo.ts's payTo).
 * @param suggestedParams - the algod transaction params; its fee is overridden with a flat fee
 *   of at least EXECUTE_RELEASE_MIN_FEE.
 */
export function buildUnsignedExecuteReleaseTxn(
  appId: bigint,
  multisigAddress: string,
  payToAddress: string,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.Transaction {
  assertMethodSignatureMatchesSpec(EXECUTE_RELEASE_METHOD_SIGNATURE, APP_SPEC)
  const method = algosdk.ABIMethod.fromSignature(EXECUTE_RELEASE_METHOD_SIGNATURE)
  const fee = BigInt(resolveExecuteReleaseFee(Number(suggestedParams.minFee ?? 0)))
  return algosdk.makeApplicationCallTxnFromObject({
    sender: multisigAddress,
    appIndex: appId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [method.getSelector()],
    accounts: [payToAddress],
    suggestedParams: { ...suggestedParams, flatFee: true, fee },
  })
}

/**
 * Shared setup every deployMultisig* CLI entry below needs: the resolved network, the MainNet
 * confirmation guard, the admin multisig address, the target app id, and a genesis-checked
 * algod connection with fresh suggestedParams. Not exported — each CLI entry below is the
 * public surface, kept separately testable through the pure builders above instead.
 */
async function resolveMultisigCallContext(): Promise<{
  network: 'mainnet' | 'testnet'
  multisigAddress: string
  appId: bigint
  suggestedParams: algosdk.SuggestedParams
}> {
  const network = parseNetwork(process.env.NETWORK)
  assertMainnetConfirmed(network, process.env.CONFIRM_MAINNET)

  const addrs = parseAdminMultisigAddrs(process.env.AUPM_ADMIN_MSIG_ADDRS)
  const multisigAddress = deriveAdminMultisigAddress(buildAdminMultisigParams(addrs))
  const appId = parseAppId(process.env.PAYMENT_ROUTER_APP_ID)

  const algorand = await buildAlgorandClient(network)
  const suggestedParams = await algorand.client.algod.getTransactionParams().do()
  assertNetworkMatchesGenesis(network, suggestedParams.genesisID ?? '')

  return { network, multisigAddress, appId, suggestedParams }
}

function printMultisigSigningInstructions(callLabel: string, outPath: string): void {
  console.log(`Unsigned ${callLabel} call written to ${outPath}.`)
  console.log(
    'Two of the three holders must sign it offline (goal clerk multisig sign), then POST the ' +
      'signed file to the target network algod /v2/transactions ' +
      '(Content-Type: application/x-binary). Do not use `algokit goal clerk rawsend`: it sends ' +
      'to LocalNet.',
  )
}

/**
 * CLI entry point: builds setCrediter(addr) for the admin multisig and writes it, unsigned, to
 * PAYMENT_ROUTER_MSIG_SET_CREDITER_TXN_PATH (default ./payment-router-set-crediter.txn).
 */
export async function deployMultisigSetCrediter(): Promise<void> {
  const crediterAddress = process.env.CREDITER_ADDRESS
  if (!crediterAddress) throw new Error('CREDITER_ADDRESS is not set')

  const { multisigAddress, appId, suggestedParams } = await resolveMultisigCallContext()
  const txn = buildUnsignedSetCrediterTxn(appId, multisigAddress, crediterAddress, suggestedParams)

  const outPath =
    process.env.PAYMENT_ROUTER_MSIG_SET_CREDITER_TXN_PATH ?? './payment-router-set-crediter.txn'
  writeUnsignedTxnFile(txn, outPath)
  printMultisigSigningInstructions('setCrediter', outPath)
}

/**
 * CLI entry point: builds announceRelease(to) for the admin multisig and writes it, unsigned, to
 * PAYMENT_ROUTER_MSIG_ANNOUNCE_RELEASE_TXN_PATH (default ./payment-router-announce-release.txn).
 */
export async function deployMultisigAnnounceRelease(): Promise<void> {
  const toAddress = process.env.RELEASE_TO_ADDRESS
  if (!toAddress) throw new Error('RELEASE_TO_ADDRESS is not set')

  const { multisigAddress, appId, suggestedParams } = await resolveMultisigCallContext()
  const txn = buildUnsignedAnnounceReleaseTxn(appId, multisigAddress, toAddress, suggestedParams)

  const outPath =
    process.env.PAYMENT_ROUTER_MSIG_ANNOUNCE_RELEASE_TXN_PATH ??
    './payment-router-announce-release.txn'
  writeUnsignedTxnFile(txn, outPath)
  printMultisigSigningInstructions('announceRelease', outPath)
}

/**
 * CLI entry point: builds executeRelease() for the admin multisig and writes it, unsigned, to
 * PAYMENT_ROUTER_MSIG_EXECUTE_RELEASE_TXN_PATH (default ./payment-router-execute-release.txn).
 * Refuses on MainNet without CONFIRM_MAINNET=1, same as every other entry here — running this
 * before the delay has passed or after the execute window has closed still writes a file,
 * since only a live executeRelease() call checks the timing; the operator gates the
 * timing.  Sign and submit the file inside the window.
 */
export async function deployMultisigExecuteRelease(): Promise<void> {
  const payToAddress = process.env.PAY_TO_ADDRESS
  if (!payToAddress) throw new Error('PAY_TO_ADDRESS is not set')

  const { multisigAddress, appId, suggestedParams } = await resolveMultisigCallContext()
  const txn = buildUnsignedExecuteReleaseTxn(appId, multisigAddress, payToAddress, suggestedParams)

  const outPath =
    process.env.PAYMENT_ROUTER_MSIG_EXECUTE_RELEASE_TXN_PATH ??
    './payment-router-execute-release.txn'
  writeUnsignedTxnFile(txn, outPath)
  printMultisigSigningInstructions('executeRelease', outPath)
}

/**
 * Refuses the single-key `deploy()` path on MainNet, before any transaction is built, any algod
 * client exists, or any mnemonic is read. MainNet requires the 2-of-3 admin multisig as
 * `Global.creatorAddress` there; `deploy()`/`deployPaymentRouter()` create the app from one
 * `DEPLOYER_MNEMONIC` key alone, so they can never run against MainNet. A no-op on TestNet and
 * LocalNet: `deploy()` stays the rehearsal path there (R3d). Pure: covered directly by
 * deploy-config.spec.ts.
 *
 * @param network - the resolved network.
 */
export function assertSingleKeyDeployNotMainnet(network: 'mainnet' | 'testnet'): void {
  if (network === 'mainnet') {
    throw new Error(
      'refusing a single-key deploy() on MainNet: the admin must be a 2-of-3 multisig ' +
        'as Global.creatorAddress there — run deployMultisigCreate() and the deployMultisig* ' +
        'admin-call entries instead',
    )
  }
}

/**
 * `algokit project deploy`'s entry point: reads every
 * role's address from the environment and calls `deployPaymentRouter()`
 * with them. Behavior unchanged from before the R3a refactor. Single-key
 * (DEPLOYER_MNEMONIC): kept for TestNet/LocalNet rehearsal (R3d's hermetic
 * fresh-app runs). The MainNet operator path uses deployMultisigCreate()
 * and the deployMultisig* admin-call entries above instead —
 * assertSingleKeyDeployNotMainnet refuses this path outright on MainNet, so
 * CONFIRM_MAINNET has nothing to gate here (it still gates every
 * deployMultisig* entry above).
 */
export async function deploy(): Promise<void> {
  const network = parseNetwork(process.env.NETWORK)
  assertSingleKeyDeployNotMainnet(network)

  console.log(`=== Deploying PaymentRouter (${network}) ===`)

  const algorand = await buildAlgorandClient(network)

  const sp = await algorand.client.algod.getTransactionParams().do()
  assertNetworkMatchesGenesis(network, sp.genesisID ?? '')

  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const crediter = await algorand.account.fromEnvironment('CREDITER')

  const payToAddress = process.env.PAY_TO_ADDRESS
  if (!payToAddress) throw new Error('PAY_TO_ADDRESS is not set')

  const opsAddress = process.env.OPS_ADDRESS
  if (!opsAddress) throw new Error('OPS_ADDRESS is not set')
  const treasuryAddress = process.env.TREASURY_ADDRESS
  if (!treasuryAddress) throw new Error('TREASURY_ADDRESS is not set')
  const payoutCap = parsePayoutCap(process.env.PAYOUT_CAP)

  await deployPaymentRouter({
    algorand,
    network,
    deployer,
    crediterAddress: crediter.addr.toString(),
    payToAddress,
    opsAddress,
    treasuryAddress,
    payoutCap,
  })
}
