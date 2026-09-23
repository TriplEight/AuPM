import { AlgorandClient, microAlgos } from '@algorandfoundation/algokit-utils'
import { PaymentRouterFactory } from '../artifacts/payment_router/PaymentRouterClient'

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

/**
 * Deploys PaymentRouter, funds the app account for box MBR, sets the
 * crediter key, and sets the auditor and ops identity map (docs/TASK.md
 * R2). Does not rekey payTo — that is scripts/rekey-payto.mjs, run
 * separately with the payTo key, after payTo already holds USDC (SPEC
 * §10.2 order).
 */
export async function deploy(): Promise<void> {
  const network = parseNetwork(process.env.NETWORK)
  assertMainnetConfirmed(network, process.env.CONFIRM_MAINNET)

  console.log(`=== Deploying PaymentRouter (${network}) ===`)

  const algorand = AlgorandClient.fromEnvironment()

  const sp = await algorand.client.algod.getTransactionParams().do()
  assertNetworkMatchesGenesis(network, sp.genesisID ?? '')

  const deployer = await algorand.account.fromEnvironment('DEPLOYER')
  const crediter = await algorand.account.fromEnvironment('CREDITER')

  const payToAddress = process.env.PAY_TO_ADDRESS
  if (!payToAddress) throw new Error('PAY_TO_ADDRESS is not set')

  const opsAddress = process.env.OPS_ADDRESS
  if (!opsAddress) throw new Error('OPS_ADDRESS is not set')

  const deployerAddress = deployer.addr.toString()
  const crediterAddress = crediter.addr.toString()
  // The deployer is Global.creatorAddress, i.e. the admin — contract.algo.ts
  // has no separate admin key. Checked once, under one label per role.
  assertCrediterDistinct(crediterAddress, {
    deployer: deployerAddress,
    admin: deployerAddress,
    payTo: payToAddress,
  })

  const identityMap = parseAuditorMap(process.env.AUDITORS)
  identityMap.set(OPS_IDENTITY, opsAddress)

  const usdcAssetId = USDC_ASSET_ID[network]
  for (const [identity, address] of identityMap) {
    const info = await algorand.client.algod.accountInformation(address).do()
    const holdsAsset = (info.assets ?? []).some((a) => Number(a.assetId) === usdcAssetId)
    assertOptedIntoUsdc(identity, address, holdsAsset)
  }

  const factory = algorand.client.getTypedAppFactory(PaymentRouterFactory, {
    defaultSender: deployer.addr,
  })

  const { appClient, result } = await factory.deploy({
    createParams: {
      method: 'createApplication',
      args: { payTo: payToAddress, usdcAsset: usdcAssetId },
    },
    onUpdate: 'append',
    onSchemaBreak: 'append',
  })

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
}
