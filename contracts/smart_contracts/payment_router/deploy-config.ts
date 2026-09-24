import * as path from 'node:path'
import { pathToFileURL } from 'node:url'
import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import type { TransactionSignerAccount } from '@algorandfoundation/algokit-utils/types/account'
import type { AlgoClientConfig } from '@algorandfoundation/algokit-utils/types/network-client'
import algosdk from 'algosdk'
import type { BinaryState } from '../artifacts/payment_router/PaymentRouterClient'
import { PaymentRouterFactory } from '../artifacts/payment_router/PaymentRouterClient'

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
 * key (spm-payment-router skill: never the deployer, the admin, the donor
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

/**
 * `algokit project deploy`'s entry point (docs/TASK.md R2): reads every
 * role's address from the environment and calls `deployPaymentRouter()`
 * with them. Behavior unchanged from before the R3a refactor.
 */
export async function deploy(): Promise<void> {
  const network = parseNetwork(process.env.NETWORK)
  assertMainnetConfirmed(network, process.env.CONFIRM_MAINNET)

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
