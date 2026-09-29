import * as fs from 'node:fs'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
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
 * is the one place those defaults are written (scripts/e2e.mjs,
 * scripts/optin-usdc.mjs already import it); repeating them here would be a
 * second table to keep in sync.
 */
interface NetworkEndpoints {
  algodEndpoint(network: 'mainnet' | 'testnet', env?: NodeJS.ProcessEnv): AlgoClientConfig
  indexerEndpoint(network: 'mainnet' | 'testnet', env?: NodeJS.ProcessEnv): AlgoClientConfig
}

// scripts/ is a plain ESM directory with no package.json of its own (see the
// banner comment in scripts/network.mjs); contracts/ compiles under
// "module": "CommonJS" (tsconfig.json). A dynamic import() of a .mjs path
// works at runtime under tsx (deploy:ci), ts-node-dev (deploy) and vitest —
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

// USDC ASA id per network (CLAUDE.md canonical facts: MainNet 31566704,
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

// Fixed identity for the ops pool (contract.algo.ts's OPS_IDENTITY). The
// admin maps it the same way it maps an auditor identity.
const OPS_IDENTITY = 'ops'

// Funds the app account once, at creation, for box minimum balance. Every
// balances/identityAddress box (contract.algo.ts) needs MBR on the app's own
// account, not on payTo — see the comment on the identity BoxMap: "R2's
// deploy step must fund the app account before the first credit()". 1 ALGO
// covers the auditor-identity boxes set below plus headroom for the first
// several credit() batches at MVP scale.
const APP_ACCOUNT_FUNDING = microAlgos(1_000_000)

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
 * Refuses to map an identity to an address that is not opted into USDC
 * (SPEC §13.3: every mapped address must be opted into USDC 31566704).
 * Pure: covered directly by deploy-config.spec.ts; the opt-in check itself
 * is an algod account lookup done by the caller.
 *
 * @param identity - the identity about to be mapped ("github:<login>" or "ops").
 * @param address - the address about to be mapped.
 * @param holdsAsset - whether that address's account already holds the USDC asset.
 */
export function assertOptedIntoUsdc(identity: string, address: string, holdsAsset: boolean): void {
  if (!holdsAsset) {
    throw new Error(
      `refusing to map ${identity} to ${address}: that address is not opted into USDC (SPEC §13.3)`,
    )
  }
}

/**
 * Parses AUDITORS ("github:<login>=<address>,...") into an identity ->
 * address map, mirroring scripts/review-anchor.mjs's parseAuditors so the
 * admin sets the identical map in PaymentRouter at deploy time (SPEC §14
 * step 3). Returns an empty map for an unset or blank value.
 * Pure: covered directly by deploy-config.spec.ts.
 *
 * @param auditorsEnv - the raw AUDITORS environment value.
 */
export function parseAuditorMap(auditorsEnv: string | undefined): Map<string, string> {
  const map = new Map<string, string>()
  const raw = (auditorsEnv ?? '').trim()
  if (!raw) return map
  for (const pair of raw.split(',')) {
    const entry = pair.trim()
    if (!entry) continue
    const eq = entry.indexOf('=')
    if (eq === -1) throw new Error(`malformed AUDITORS entry (no "="): ${JSON.stringify(entry)}`)
    const identity = entry.slice(0, eq).trim()
    const address = entry.slice(eq + 1).trim()
    if (!identity.startsWith('github:')) {
      throw new Error(`malformed AUDITORS entry (login must be "github:<login>"): ${entry}`)
    }
    if (!address) throw new Error(`malformed AUDITORS entry (empty address): ${entry}`)
    map.set(identity, address)
  }
  return map
}

export interface DeployPaymentRouterParams {
  algorand: AlgorandClient
  network: 'mainnet' | 'testnet'
  deployer: TransactionSignerAccount
  crediterAddress: string
  payToAddress: string
  /** Every identity to map, ops included (contract.algo.ts's OPS_IDENTITY). */
  identityMap: Map<string, string>
  /**
   * Overrides the app name algokit's idempotent `factory.deploy()` looks up
   * by (creator address + name). `deploy()` below leaves this unset and
   * keeps the operator's idempotent "PaymentRouter" behavior; the hermetic
   * rehearsal (scripts/e2e.mjs) passes a unique name per run (R3d) so it
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
 * setCrediter/setIdentity call (R3d): algokit's idempotent
 * `factory.deploy()` reuses any existing app with the same creator +
 * appName, and this deployer may have already created an earlier
 * PaymentRouter for a different payTo (SPEC §10.2: payTo never changes
 * once set) — setting crediter/identities on that app would silently
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
 * setCrediter/setIdentity call, on both the operator and rehearsal paths.
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
 * Deploys PaymentRouter, funds the app account for box MBR, sets the
 * crediter key, and maps every identity in `identityMap` (docs/TASK.md
 * R2). Does not rekey payTo — that is scripts/rekey-payto.mjs, run
 * separately with the payTo key, after payTo already holds USDC (SPEC
 * §10.2 order).
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
    identityMap,
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
  for (const [identity, address] of identityMap) {
    const info = await algorand.client.algod.accountInformation(address).do()
    const holdsAsset = (info.assets ?? []).some((a) => Number(a.assetId) === usdcAssetId)
    assertOptedIntoUsdc(identity, address, holdsAsset)
  }

  const factory = algorand.client.getTypedAppFactory(PaymentRouterFactory, {
    defaultSender: deployer.addr,
    ...(appName ? { appName } : {}),
  })

  const { appClient, result } = await factory.deploy({
    createParams: {
      method: 'createApplication',
      args: { payTo: payToAddress, usdcAsset: usdcAssetId },
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

  if (['create', 'replace'].includes(result.operationPerformed)) {
    await algorand.send.payment({
      sender: deployer.addr,
      receiver: appClient.appAddress,
      amount: APP_ACCOUNT_FUNDING,
    })
    console.log(`Funded app account ${appClient.appAddress} for box MBR.`)
  }

  await appClient.send.setCrediter({ args: { addr: crediterAddress } })
  console.log(`Set crediter to ${crediterAddress}.`)

  for (const [identity, address] of identityMap) {
    await appClient.send.setIdentity({ args: { identity, addr: address } })
    console.log(`Mapped ${identity} -> ${address}.`)
  }

  console.log(
    `PaymentRouter app id: ${appClient.appId}. Next: fund payTo with USDC, then run ` +
      'scripts/rekey-payto.mjs with the payTo key (SPEC §10.2 order).',
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

// --- 2-of-3 admin multisig creator (ADR 0010, SPEC §10.2a) ------------------
//
// Global.creatorAddress must be a 2-of-3 Algorand multisig, never one key
// (docs/adr/0010): no single lost or leaked key can call setCrediter,
// setIdentity, announceRelease, or executeRelease alone. This workstation
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
//   4. Whoever holds the twice-signed file submits it:
//      `goal clerk rawsend -f payment-router-create.txn`, then records the
//      resulting app id as PAYMENT_ROUTER_APP_ID.
// setCrediter/setIdentity/announceRelease/executeRelease follow the same
// build-sign-submit shape afterwards (built with `goal app call` or a
// future helper here); this work item covers only the create step.

export const ADMIN_MSIG_THRESHOLD = 2

/**
 * Parses AUPM_ADMIN_MSIG_ADDRS ("addr1,addr2,addr3") into exactly three
 * distinct, valid Algorand addresses — the admin multisig's signer set
 * (ADR 0010). Pure: covered directly by deploy-config.spec.ts.
 *
 * @param addrsEnv - the raw AUPM_ADMIN_MSIG_ADDRS environment value.
 */
export function parseAdminMultisigAddrs(addrsEnv: string | undefined): string[] {
  const raw = (addrsEnv ?? '').trim()
  if (!raw) {
    throw new Error('AUPM_ADMIN_MSIG_ADDRS is not set (ADR 0010: a 2-of-3 multisig creator)')
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
 * (ADR 0010). The threshold is always ADMIN_MSIG_THRESHOLD — never read
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

const CREATE_APPLICATION_METHOD_SIGNATURE = 'createApplication(address,uint64)void'

/**
 * Builds the unsigned createApplication(payTo, usdcAsset) call, sender set
 * to the admin multisig address, ready for the offline goal signing flow
 * documented above. Reads the compiled approval/clear programs and the
 * global state schema straight off the generated ARC-56 spec — never
 * hand-copied — so it always matches whatever `algokit project run build`
 * last produced. Pure given `suggestedParams`: no network access, so
 * deploy-config.spec.ts covers it directly with a fabricated suggestedParams
 * object.
 *
 * @param multisigAddress - the 2-of-3 admin multisig address (deriveAdminMultisigAddress).
 * @param payToAddress - the payTo account this deploy fixes at creation (SPEC §10.2).
 * @param usdcAssetId - the USDC asset id for the target network.
 * @param suggestedParams - the algod transaction params (fee, validity window, genesis).
 */
export function buildUnsignedCreateApplicationTxn(
  multisigAddress: string,
  payToAddress: string,
  usdcAssetId: number,
  suggestedParams: algosdk.SuggestedParams,
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

  const algorand = await buildAlgorandClient(network)
  const suggestedParams = await algorand.client.algod.getTransactionParams().do()
  assertNetworkMatchesGenesis(network, suggestedParams.genesisID ?? '')

  const txn = buildUnsignedCreateApplicationTxn(
    multisigAddress,
    payToAddress,
    USDC_ASSET_ID[network],
    suggestedParams,
  )

  const outPath = process.env.PAYMENT_ROUTER_MSIG_CREATE_TXN_PATH ?? './payment-router-create.txn'
  writeUnsignedTxnFile(txn, outPath)

  console.log(`Admin multisig address (2-of-3, ADR 0010): ${multisigAddress}`)
  console.log(`Unsigned createApplication call written to ${outPath}.`)
  console.log(
    'Two of the three holders must sign it offline (goal clerk multisig sign) before ' +
      'submitting with goal clerk rawsend — see the comment above parseAdminMultisigAddrs.',
  )
}

// --- 2-of-3 admin multisig: post-creation admin calls (ADR 0010, docs/TASK.md P8b) ----------
//
// setCrediter, setIdentity, announceRelease and executeRelease are admin-only
// (contract.algo.ts: each asserts `Txn.sender.bytes === Global.creatorAddress.bytes`), so each
// needs the same offline multisig flow as deployMultisigCreate above: build the unsigned call
// here, write it to a file, two of the three holders sign it in turn with `goal clerk multisig
// sign`, then whoever holds the twice-signed file submits it with `goal clerk rawsend`.
//
// The four signatures below are hand-written from contract.algo.ts's own method declarations.
// assertMethodSignatureMatchesSpec fails loudly if the generated ARC-56 spec (APP_SPEC) ever
// disagrees with any of them.

const SET_CREDITER_METHOD_SIGNATURE = 'setCrediter(address)void'
const SET_IDENTITY_METHOD_SIGNATURE = 'setIdentity(string,address)void'
const ANNOUNCE_RELEASE_METHOD_SIGNATURE = 'announceRelease(address)void'
const EXECUTE_RELEASE_METHOD_SIGNATURE = 'executeRelease()void'

// Fixed identity for the migration sweep target (contract.algo.ts's TREASURY_IDENTITY).
const TREASURY_IDENTITY = 'treasury'

/**
 * The flat outer fee executeRelease() needs: it submits up to two inner transactions (the
 * treasury sweep axfer and the payTo rekey payment, contract.algo.ts's executeRelease), each
 * needing the network's own minimum fee pooled through the outer call, on top of the outer
 * call's own fee (docs/TASK.md P8b: "at least 3,000 microALGO"). Never read from the
 * environment — a smaller fee would leave a real inner transaction unfunded on-chain.
 */
export const EXECUTE_RELEASE_MIN_FEE = 3_000

/**
 * Box key encoding for `identityAddress = BoxMap<string, bytes>({ keyPrefix: 'id:' })`
 * (contract.algo.ts): the literal utf8 bytes of the identity string after the prefix, never
 * ARC-4 length-prefixed — the same encoding scripts/claim.mjs's identityBoxName and
 * proxy/src/claims/credit.ts's buildCreditCallRefs already use. Pure: covered directly by
 * deploy-config.spec.ts.
 *
 * @param identity - the identity string ("github:<login>", "ops" or "treasury").
 */
export function identityBoxName(identity: string): Uint8Array {
  return new TextEncoder().encode(`id:${identity}`)
}

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
 * Builds the unsigned setIdentity(identity, addr) call, sender set to the admin multisig
 * address, with the identity's own box (identityAddress = BoxMap<string, bytes>({ keyPrefix:
 * 'id:' })) attached as a box reference — contract.algo.ts writes it directly, with no prior
 * read.
 *
 * @param appId - the deployed PaymentRouter app id (parseAppId).
 * @param multisigAddress - the 2-of-3 admin multisig address (deriveAdminMultisigAddress).
 * @param identity - the identity to map ("github:<login>", "ops" or "treasury").
 * @param addr - the address to map the identity to.
 * @param suggestedParams - the algod transaction params.
 */
export function buildUnsignedSetIdentityTxn(
  appId: bigint,
  multisigAddress: string,
  identity: string,
  addr: string,
  suggestedParams: algosdk.SuggestedParams,
): algosdk.Transaction {
  assertMethodSignatureMatchesSpec(SET_IDENTITY_METHOD_SIGNATURE, APP_SPEC)
  const method = algosdk.ABIMethod.fromSignature(SET_IDENTITY_METHOD_SIGNATURE)
  return algosdk.makeApplicationCallTxnFromObject({
    sender: multisigAddress,
    appIndex: appId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [
      method.getSelector(),
      new algosdk.ABIStringType().encode(identity),
      new algosdk.ABIAddressType().encode(addr),
    ],
    boxes: [{ appIndex: 0, name: identityBoxName(identity) }],
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
 *   `payTo` itself (SPEC §10.2a: the rekey changes the authorizer, not the address).
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
 * flat outer fee of at least EXECUTE_RELEASE_MIN_FEE (resolveExecuteReleaseFee) to cover the two
 * inner transactions executeRelease() submits. Attaches the USDC asset, `payTo` and the
 * "treasury" identity's mapped address as foreign references (both accounts back an inner
 * transaction: `payTo` as sender, treasury as the sweep receiver), and the "treasury" identity
 * box (contract.algo.ts's executeRelease reads identityAddress(TREASURY_IDENTITY) before it can
 * build the sweep axfer).
 *
 * @param appId - the deployed PaymentRouter app id (parseAppId).
 * @param multisigAddress - the 2-of-3 admin multisig address (deriveAdminMultisigAddress).
 * @param payToAddress - `payTo` (the sweep and rekey sender, contract.algo.ts's payTo).
 * @param treasuryAddress - the address mapped to the "treasury" identity (the sweep receiver).
 * @param usdcAssetId - the USDC asset id for the target network.
 * @param suggestedParams - the algod transaction params; its fee is overridden with a flat fee
 *   of at least EXECUTE_RELEASE_MIN_FEE.
 */
export function buildUnsignedExecuteReleaseTxn(
  appId: bigint,
  multisigAddress: string,
  payToAddress: string,
  treasuryAddress: string,
  usdcAssetId: number,
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
    accounts: [payToAddress, treasuryAddress],
    foreignAssets: [usdcAssetId],
    boxes: [{ appIndex: 0, name: identityBoxName(TREASURY_IDENTITY) }],
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
    'Two of the three holders must sign it offline (goal clerk multisig sign) before ' +
      'submitting with goal clerk rawsend — see the operator runbook (not published).',
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
 * CLI entry point: builds setIdentity(identity, addr) for the admin multisig and writes it,
 * unsigned, to PAYMENT_ROUTER_MSIG_SET_IDENTITY_TXN_PATH (default one file per IDENTITY, e.g.
 * ./payment-router-set-identity-ops.txn) — run once per identity to map.
 */
export async function deployMultisigSetIdentity(): Promise<void> {
  const identity = process.env.IDENTITY
  if (!identity) throw new Error('IDENTITY is not set')
  const identityAddress = process.env.IDENTITY_ADDRESS
  if (!identityAddress) throw new Error('IDENTITY_ADDRESS is not set')

  const { multisigAddress, appId, suggestedParams } = await resolveMultisigCallContext()
  const txn = buildUnsignedSetIdentityTxn(
    appId,
    multisigAddress,
    identity,
    identityAddress,
    suggestedParams,
  )

  const safeIdentity = identity.replace(/[^a-zA-Z0-9_-]/g, '-')
  const outPath =
    process.env.PAYMENT_ROUTER_MSIG_SET_IDENTITY_TXN_PATH ??
    `./payment-router-set-identity-${safeIdentity}.txn`
  writeUnsignedTxnFile(txn, outPath)
  printMultisigSigningInstructions(`setIdentity(${identity})`, outPath)
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
 * since only a live executeRelease() call checks the timing; the operator runbook (not
 * published) gates the operator's own timing. Sign and submit the file inside the window.
 */
export async function deployMultisigExecuteRelease(): Promise<void> {
  const payToAddress = process.env.PAY_TO_ADDRESS
  if (!payToAddress) throw new Error('PAY_TO_ADDRESS is not set')
  const treasuryAddress = process.env.TREASURY_ADDRESS
  if (!treasuryAddress) throw new Error('TREASURY_ADDRESS is not set')

  const { network, multisigAddress, appId, suggestedParams } = await resolveMultisigCallContext()
  const txn = buildUnsignedExecuteReleaseTxn(
    appId,
    multisigAddress,
    payToAddress,
    treasuryAddress,
    USDC_ASSET_ID[network],
    suggestedParams,
  )

  const outPath =
    process.env.PAYMENT_ROUTER_MSIG_EXECUTE_RELEASE_TXN_PATH ??
    './payment-router-execute-release.txn'
  writeUnsignedTxnFile(txn, outPath)
  printMultisigSigningInstructions('executeRelease', outPath)
}

/**
 * Refuses the single-key `deploy()` path on MainNet, before any transaction is built, any algod
 * client exists, or any mnemonic is read. ADR 0010 requires the 2-of-3 admin multisig as
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
      'refusing a single-key deploy() on MainNet: ADR 0010 requires the 2-of-3 admin multisig ' +
        'as Global.creatorAddress there — run deployMultisigCreate() and the deployMultisig* ' +
        'admin-call entries instead (operator runbook section 2a, not published)',
    )
  }
}

/**
 * `algokit project deploy`'s entry point (docs/TASK.md R2): reads every
 * role's address from the environment and calls `deployPaymentRouter()`
 * with them. Behavior unchanged from before the R3a refactor. Single-key
 * (DEPLOYER_MNEMONIC): kept for TestNet/LocalNet rehearsal (R3d's hermetic
 * fresh-app runs). The MainNet operator path uses deployMultisigCreate()
 * and the deployMultisig* admin-call entries above instead, per ADR 0010 —
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

  const identityMap = parseAuditorMap(process.env.AUDITORS)
  identityMap.set(OPS_IDENTITY, opsAddress)

  await deployPaymentRouter({
    algorand,
    network,
    deployer,
    crediterAddress: crediter.addr.toString(),
    payToAddress,
    identityMap,
  })
}
