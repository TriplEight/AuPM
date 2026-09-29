#!/usr/bin/env node

// AuPM end-to-end check — drives the real flow against a running proxy.
// Usage: node scripts/e2e.mjs (tsx required — several checks import .ts
// source files directly; see the imports below).
//
// Reads NETWORK, AUPM_PROXY_URL, SQLITE_PATH, and ATTEST_SIGNING_KEY from the
// environment — the same variables the proxy process reads (proxy/src/config.ts).
// Set them once, in the same shell, before starting both the proxy and this
// script (scripts/verify.sh and scripts/demo.sh both do this).
//
// Exit 0 = every check that ran passed. Exit 1 = at least one check failed.
// A SKIPPED check never causes a non-zero exit — only a FAILED one does.

import { spawn, spawnSync } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  assertBalanceAtLeastMinClaim,
  assertSignerIsMappedAddress,
  MIN_CLAIM,
  MIN_CLAIM_FEE,
  readIdentityBalance,
  readMappedAddress,
  submitClaim,
} from './claim.mjs'
import { assertSqliteWriteAllowed } from './e2e-guard.mjs'
import { algodEndpoint, indexerEndpoint, usdcAssetId } from './network.mjs'
import { optinAccountToUsdc } from './optin-usdc.mjs'
import { assertNetworkMatchesGenesis, rekeyPayToToApp } from './rekey-payto.mjs'

// Anchors a CJS `require()` at each workspace package's own node_modules —
// scripts/ has no node_modules of its own. Mirrors the pattern already
// established for algosdk imports in this file.
const requireFromProxy = createRequire(new URL('../proxy/package.json', import.meta.url))
const requireFromContracts = createRequire(new URL('../contracts/package.json', import.meta.url))
const algosdk = requireFromProxy('algosdk')

const scriptDir = path.dirname(fileURLToPath(import.meta.url))

const PROXY_URL = process.env.AUPM_PROXY_URL ?? 'http://localhost:4873'

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-e2e-'))

let passed = 0
let failed = 0
let skipped = 0

async function check(name, fn) {
  process.stdout.write(`  ${name}: `)
  try {
    const result = await fn()
    console.log(`PASS${result ? ` (${result})` : ''}`)
    passed++
    return true
  } catch (e) {
    console.log(`FAIL - ${e.message}`)
    failed++
    return false
  }
}

// WARNING: a SKIP must always carry a reason. A silent skip is as dishonest
// as a false PASS — the reader must know exactly what did not run and why.
function skip(name, reason) {
  console.log(`  ${name}: SKIP - ${reason}`)
  skipped++
}

// ── Genesis guard (R3c) ────────────────────────────────────────────────────
//
// A live .env with NETWORK=testnet but ALGOD_SERVER/INDEXER_URL pointed at
// MainNet reads MainNet balances and looks up MainNet txids under a
// TestNet-labelled run, printing misleading errors ("deployer holds 0
// microALGO", "indexer never confirmed txid") instead of naming the real
// cause. assertChainGenesisMatches is pure — it reuses rekey-payto.mjs's
// own assertNetworkMatchesGenesis for the actual comparison (never a second
// copy of the network -> genesis-id mapping) and only adds the endpoint URL
// and the env var to fix to the message.

/**
 * Refuses when `component`'s already-fetched genesis id does not match
 * `network`. Pure: no network access itself — see
 * assertNetworkGenesisMatchesEverywhere below for the real fetch.
 *
 * @param {'algod'|'indexer'} component
 * @param {'testnet'|'mainnet'} network
 * @param {string} genesisId - the component's own reported genesis id.
 * @param {string} endpointUrl - the URL this run queried.
 * @param {string} envVar - the env var that points `component` at endpointUrl.
 */
export function assertChainGenesisMatches(component, network, genesisId, endpointUrl, envVar) {
  try {
    assertNetworkMatchesGenesis(network, genesisId)
  } catch {
    throw new Error(
      `${component} genesis id "${genesisId}" from ${endpointUrl} does not match ` +
        `NETWORK=${network}; fix ${envVar} (or NETWORK) — refusing every further on-chain ` +
        'check against a possibly wrong chain',
    )
  }
}

// The indexer has no dedicated genesis endpoint. /health carries no
// genesis-id (checked against the live indexers, R3c fix attempt 1):
//   {"data":{...},"db-available":true,"is-migrating":false,
//    "message":"<round>","round":<round>,"version":"..."}
// Round 1's header does, alongside genesis-hash.
const INDEXER_GENESIS_PATH = '/v2/blocks/1?header-only=true'

/**
 * Fetches the indexer's own genesis id from round 1's block header. A
 * missing or empty genesis-id is its own error, never compared as "" (R3c
 * fix attempt 1) — `fetchImpl` is injectable so this is unit-testable
 * without a real indexer (scripts/e2e.test.mjs).
 *
 * @param {string} indexerServer
 * @param {string} indexerToken
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<string>}
 */
export async function fetchIndexerGenesisId(indexerServer, indexerToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${indexerServer}${INDEXER_GENESIS_PATH}`, {
    headers: indexerToken ? { 'X-Indexer-API-Token': indexerToken } : {},
  })
  if (!res.ok) {
    throw new Error(
      `indexer genesis check: GET ${indexerServer}${INDEXER_GENESIS_PATH} ` +
        `returned HTTP ${res.status}`,
    )
  }
  const block = await res.json()
  const genesisId = block['genesis-id']
  if (!genesisId) {
    throw new Error(
      `indexer at ${indexerServer} returned no genesis-id from ${INDEXER_GENESIS_PATH}`,
    )
  }
  return genesisId
}

/**
 * Fetches algod's and the indexer's own genesis ids for `network` and
 * checks both against it. WARNING: call this first in every path that
 * reaches algod or the indexer — nothing on-chain may run before it.
 *
 * @param {'testnet'|'mainnet'} network
 */
async function assertNetworkGenesisMatchesEverywhere(network) {
  const { server: algodServer, port: algodPort, token: algodToken } = algodEndpoint(network)
  const algod = new algosdk.Algodv2(algodToken, algodServer, algodPort)
  const sp = await algod.getTransactionParams().do()
  assertChainGenesisMatches('algod', network, sp.genesisID ?? '', algodServer, 'ALGOD_SERVER')

  const { server: indexerServer, token: indexerToken } = indexerEndpoint(network)
  const indexerGenesisId = await fetchIndexerGenesisId(indexerServer, indexerToken)
  assertChainGenesisMatches('indexer', network, indexerGenesisId, indexerServer, 'INDEXER_URL')
}

// ATTEST_SIGNING_KEY is either a 25-word Algorand mnemonic or a hex-encoded
// 32-byte seed (.env.example) — the exact same detection proxy/src/config.ts's
// getAttestationSigningKey() uses. Duplicated here only as the format-sniff
// (one regex); the actual key derivation is never duplicated — it always
// runs through proxy/src/attest/keys.ts's own loadSigningKey.
const HEX_SEED_RE = /^[0-9a-fA-F]{64}$/

/**
 * Derives the AuPM attestation signing key from ATTEST_SIGNING_KEY's raw
 * value, the same way the running proxy does, so this check can never
 * disagree with what the proxy actually signed with (Defect 1, R3b). The
 * former version always ran `Buffer.from(source, 'hex')`, which silently
 * mangled a mnemonic into 0-32 garbage bytes and failed with "seed must be
 * exactly 32 bytes" — the seed length check firing on the wrong root cause.
 *
 * @param {string} source - the raw ATTEST_SIGNING_KEY value.
 * @returns {Promise<import('../proxy/src/attest/keys.js').SigningKey>}
 */
export async function deriveAttestSigningKey(source) {
  const { loadSigningKey } = await import('../proxy/src/attest/keys.js')
  const mnemonicOrSeed = HEX_SEED_RE.test(source)
    ? Uint8Array.from(Buffer.from(source, 'hex'))
    : source
  return loadSigningKey(mnemonicOrSeed)
}

/**
 * Polls the indexer for `txid` until it appears or `timeoutMs` elapses.
 * WARNING: algod's `pendingTransactionInformation` is not a substitute for
 * an already-confirmed txid — a load-balanced public algod node can 404 a
 * transaction it never itself saw in its own mempool, even rounds after it
 * confirmed elsewhere (Defect 2, R3b). The indexer is the source of truth
 * for a confirmed transaction; it can lag confirmation by a few seconds, so
 * this polls with a bounded retry instead of a single lookup. A timeout is
 * a thrown error carrying the txid — never a silent pass.
 *
 * @param {{lookupTransactionByID(id: string): {do(): Promise<{transaction?: object}>}}} indexerClient
 * @param {string} txid
 * @param {{timeoutMs?: number, intervalMs?: number, sleep?: (ms: number) => Promise<void>}} [opts]
 * @returns {Promise<object>} the indexer's transaction record (camelCase, algosdk v3 shape)
 */
export async function waitForIndexerTransaction(indexerClient, txid, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 30_000
  const intervalMs = opts.intervalMs ?? 1_000
  const sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const deadline = Date.now() + timeoutMs
  let lastErrorMessage = 'never queried'
  while (Date.now() < deadline) {
    try {
      const { transaction } = await indexerClient.lookupTransactionByID(txid).do()
      if (transaction) return transaction
      lastErrorMessage = 'indexer returned no transaction'
    } catch (e) {
      lastErrorMessage = e.message
    }
    await sleep(intervalMs)
  }
  throw new Error(
    `indexer never confirmed txid ${txid} within ${timeoutMs}ms (last: ${lastErrorMessage})`,
  )
}

/**
 * Refuses unless `transaction` is a plain USDC asset transfer to `payToAddress`
 * with no inner transactions — the exact shape the x402 exact scheme settles
 * (CLAUDE.md invariant 3: `asset` always explicit; aupm-x402-flow: "the
 * payment is a plain USDC asset transfer to payTo"). Pure: no network access.
 *
 * @param {object} transaction - an indexer transaction record (camelCase, algosdk v3 shape)
 * @param {{payToAddress: string, assetId: number|bigint, txid: string}} expected
 */
export function assertPlainUsdcTransferNoInner(transaction, { payToAddress, assetId, txid }) {
  const axfer = transaction.assetTransferTransaction
  if (transaction.txType !== 'axfer' || !axfer) {
    throw new Error(`txid ${txid} is not an asset transfer (got txType ${transaction.txType})`)
  }
  if (BigInt(axfer.assetId) !== BigInt(assetId)) {
    throw new Error(`txid ${txid} moves asset ${axfer.assetId}, expected USDC asset ${assetId}`)
  }
  if (axfer.receiver !== payToAddress) {
    throw new Error(`txid ${txid} pays ${axfer.receiver}, expected payTo ${payToAddress}`)
  }
  const innerTxns = transaction.innerTxns ?? []
  if (innerTxns.length !== 0) {
    throw new Error(`txid ${txid} carries ${innerTxns.length} inner transaction(s), expected 0`)
  }
}

// ── On-chain: PaymentRouter 250-package credit/claim rehearsal (R3a) ───────
//
// One reviewed package's auditor share is 300 microUSDC — far below
// MIN_CLAIM (100,000, contract.algo.ts). This rehearsal pays for
// ONCHAIN_ENTRY_COUNT reviewed packages in one lockfile attestation so both
// the auditor and ops claims clear MIN_CLAIM in a single run. Every fixture
// row shares one repo and one reviewer identity: credit()'s entries[] is
// one row per (repo, identity), and buildCreditCallRefs (proxy/src/claims/
// credit.ts) caps a credit() call at 8 foreign references — a shared
// (repo, identity) collapses 250 packages into exactly one auditor entry.
//
// Hermetic (R3a): every run deploys its own fresh PaymentRouter app for
// fresh, in-memory payTo/auditor/ops accounts, and runs a dedicated proxy
// process against its own throwaway SQLite database. PaymentRouter's
// credit() accepts only batchSeq == on-chain last + 1 (one app, one
// ledger) — reusing a persistent app and payTo across runs made every run
// after the first FAIL on batch numbering. A fresh app has no other
// inflow, so this run's own totals are exact, not merely a lower bound.
//
// TestNet only (SPEC §17: never manufacture MainNet volume) — gated by
// onChainRehearsalSkipReason, unit-tested in scripts/e2e.test.mjs.

const ONCHAIN_ENTRY_COUNT = 250
const ONCHAIN_REPO = 'npm:aupm-e2e-rehearsal'
const ONCHAIN_REVIEWER_LOGIN = 'aupm-e2e-auditor'
const ONCHAIN_IDENTITY = `github:${ONCHAIN_REVIEWER_LOGIN}`
const ONCHAIN_OPS_IDENTITY = 'ops'
// SPEC §13.2 MVP split: 300 auditor / 700 ops per 1,000 microUSDC paid.
const ONCHAIN_TOTAL_MICRO = ONCHAIN_ENTRY_COUNT * 1_000
const ONCHAIN_AUDITOR_SHARE_MICRO = (ONCHAIN_TOTAL_MICRO * 300) / 1_000
const ONCHAIN_OPS_SHARE_MICRO = ONCHAIN_TOTAL_MICRO - ONCHAIN_AUDITOR_SHARE_MICRO

const ONCHAIN_REQUIRED_ENV_VARS = ['DEPLOYER_MNEMONIC', 'CREDITER_MNEMONIC', 'AUPM_DONOR_MNEMONIC']

/**
 * Why the 250-package on-chain rehearsal does not run, or null when it
 * should. Pure: no network access, no filesystem access — every check.mjs
 * that calls this passes NETWORK and the process environment explicitly,
 * so scripts/e2e.test.mjs covers both branches (MainNet, and each missing
 * variable by name) without touching a real chain.
 *
 * @param {'testnet'|'mainnet'} network
 * @param {NodeJS.ProcessEnv} env
 * @returns {string|null}
 */
export function onChainRehearsalSkipReason(network, env) {
  if (network !== 'testnet') {
    return '250-package claim rehearsal is TestNet only (SPEC §17: never manufacture volume)'
  }
  const missing = ONCHAIN_REQUIRED_ENV_VARS.filter((name) => !env[name])
  if (missing.length > 0) {
    return `missing env var(s): ${missing.join(', ')}`
  }
  return null
}

// ── Funding amounts (R3a) ───────────────────────────────────────────────
//
// The deployer pays for every fresh account's minimum balance and fees, in
// one run: payTo (opt-in + rekey), the auditor claimant (opt-in + claim),
// the ops claimant (opt-in + claim), the app account's own box MBR, the
// deployer's own creator MBR increase from creating the app, and the
// deploy call fees themselves.

const ACCOUNT_MBR_MICRO_ALGO = 100_000
const ASSET_MBR_MICRO_ALGO = 100_000
const STANDARD_FEE_MICRO_ALGO = 1_000
// Mirrors deploy-config.ts's own APP_ACCOUNT_FUNDING (box MBR for the
// balances/identityAddress boxes the deploy step creates).
const APP_ACCOUNT_FUNDING_MICRO_ALGO = 1_000_000
// createApplication + setCrediter + 2x setIdentity, with margin for a fee
// bump between rounds.
const DEPLOY_CALL_FEES_MICRO_ALGO = 10_000
// One funding payment each to payTo, the auditor claimant, the ops
// claimant, and the app account.
const FUNDING_TXN_FEES_MICRO_ALGO = STANDARD_FEE_MICRO_ALGO * 4
// Keeps the deployer's own MBR intact after every send in the run.
const DEPLOYER_RESERVE_MICRO_ALGO = 100_000

// AVM consensus MBR constants for creating an application (algod's
// MinBalance rules): a base amount per app (repeated per extra program
// page), plus a per-key amount for each declared global uint and each
// declared global byte-slice. Creating an app raises the CREATOR's own min
// balance by this amount, separately from APP_ACCOUNT_FUNDING_MICRO_ALGO
// above (the app account's own box MBR) — a live TestNet run (R3c
// coordinator note) undercounted this and failed setIdentity in simulate
// with "balance ... below min".
const APP_CREATION_BASE_MBR_MICRO_ALGO = 100_000
const GLOBAL_UINT_MBR_MICRO_ALGO = 28_500
const GLOBAL_BYTE_SLICE_MBR_MICRO_ALGO = 50_000
const MAX_APP_PROGRAM_LEN_BYTES = 2_048

function readPaymentRouterArc56Spec() {
  const specPath = path.join(
    scriptDir,
    '..',
    'contracts',
    'smart_contracts',
    'artifacts',
    'payment_router',
    'PaymentRouter.arc56.json',
  )
  return JSON.parse(fs.readFileSync(specPath, 'utf8'))
}

/**
 * The deployer's own min-balance increase from creating one PaymentRouter
 * app (AVM consensus formula) — driven entirely by the compiled ARC-56
 * spec's declared global schema and compiled program length, never a
 * hardcoded guess, so a future schema or program-size change is caught by
 * this function's own pinned test rather than silently under-funding the
 * deployer.
 *
 * @param {object} [spec] - defaults to the real compiled PaymentRouter spec.
 * @returns {number}
 */
export function creatorAppMbrIncreaseMicroAlgo(spec = readPaymentRouterArc56Spec()) {
  const globalSchema = spec.state.schema.global
  const approvalLen = Buffer.from(spec.byteCode.approval, 'base64').length
  const clearLen = Buffer.from(spec.byteCode.clear, 'base64').length
  const extraPages = Math.max(
    0,
    Math.ceil((approvalLen + clearLen) / MAX_APP_PROGRAM_LEN_BYTES) - 1,
  )
  return (
    APP_CREATION_BASE_MBR_MICRO_ALGO * (1 + extraPages) +
    GLOBAL_UINT_MBR_MICRO_ALGO * globalSchema.ints +
    GLOBAL_BYTE_SLICE_MBR_MICRO_ALGO * globalSchema.bytes
  )
}

/** MBR + one ASA opt-in's MBR increase + the opt-in fee + the rekey fee. */
export function payToFundingMicroAlgo() {
  return ACCOUNT_MBR_MICRO_ALGO + ASSET_MBR_MICRO_ALGO + STANDARD_FEE_MICRO_ALGO * 2
}

/** MBR + one ASA opt-in's MBR increase + the opt-in fee + claim()'s own outer-fee floor. */
export function claimantFundingMicroAlgo() {
  return ACCOUNT_MBR_MICRO_ALGO + ASSET_MBR_MICRO_ALGO + STANDARD_FEE_MICRO_ALGO + MIN_CLAIM_FEE
}

/** The deployer's own required ALGO balance for one whole rehearsal run. */
export function deployerFundingTotalMicroAlgo() {
  return (
    payToFundingMicroAlgo() +
    claimantFundingMicroAlgo() * 2 + // the auditor claimant and the ops claimant
    APP_ACCOUNT_FUNDING_MICRO_ALGO +
    creatorAppMbrIncreaseMicroAlgo() +
    DEPLOY_CALL_FEES_MICRO_ALGO +
    FUNDING_TXN_FEES_MICRO_ALGO +
    DEPLOYER_RESERVE_MICRO_ALGO
  )
}

/**
 * Refuses when the deployer cannot fund payTo, both claimants, the app
 * account, and the deploy itself. Pure: no network access. Names the
 * deployer's own public address in the message (Defect 3, R3b) — never a
 * mnemonic or any other secret.
 *
 * @param {number} deployerBalanceMicroAlgo
 * @param {number} [requiredMicroAlgo]
 * @param {string} [deployerAddress]
 */
export function assertDeployerFunded(
  deployerBalanceMicroAlgo,
  requiredMicroAlgo = deployerFundingTotalMicroAlgo(),
  deployerAddress = '(address unknown)',
) {
  if (deployerBalanceMicroAlgo < requiredMicroAlgo) {
    throw new Error(
      `deployer ${deployerAddress} holds ${deployerBalanceMicroAlgo} microALGO, needs at ` +
        `least ${requiredMicroAlgo} to fund payTo, the auditor and ops claimants, and deploy ` +
        'a fresh PaymentRouter',
    )
  }
}

/**
 * Refuses when the donor cannot pay for the whole ONCHAIN_ENTRY_COUNT-package
 * lockfile. Pure: no network access. Names the donor's own public address in
 * the message (Defect 3, R3b) — never a mnemonic or any other secret.
 *
 * @param {number} donorBalanceMicroUsdc
 * @param {string} [donorAddress]
 */
export function assertDonorFundedForRehearsal(
  donorBalanceMicroUsdc,
  donorAddress = '(address unknown)',
) {
  if (donorBalanceMicroUsdc < ONCHAIN_TOTAL_MICRO) {
    throw new Error(
      `donor ${donorAddress} holds ${donorBalanceMicroUsdc} microUSDC, needs at least ` +
        `${ONCHAIN_TOTAL_MICRO} to pay for the ${ONCHAIN_ENTRY_COUNT}-package lockfile`,
    )
  }
}

/**
 * Refuses when any two of the deployer, crediter, and donor resolve to the
 * same address — the crediter key must never double as a cold key
 * (aupm-payment-router skill), and a self-funding donor would make the
 * "donor holds enough USDC" precondition meaningless. Pure: no network
 * access. Names the two colliding public addresses in the message (Defect
 * 3, R3b) — never a mnemonic or any other secret.
 *
 * @param {{deployerAddress: string, crediterAddress: string, donorAddress: string}} addrs
 */
export function assertRehearsalKeysDistinct({ deployerAddress, crediterAddress, donorAddress }) {
  if (crediterAddress === deployerAddress) {
    throw new Error(
      `CREDITER_MNEMONIC must not resolve to the same address as DEPLOYER_MNEMONIC (both ${crediterAddress})`,
    )
  }
  if (deployerAddress === donorAddress) {
    throw new Error(
      `DEPLOYER_MNEMONIC must not resolve to the same address as AUPM_DONOR_MNEMONIC (both ${deployerAddress})`,
    )
  }
  if (crediterAddress === donorAddress) {
    throw new Error(
      `CREDITER_MNEMONIC must not resolve to the same address as AUPM_DONOR_MNEMONIC (both ${crediterAddress})`,
    )
  }
}

/**
 * Loads the first `ONCHAIN_ENTRY_COUNT` entries of the committed fixture:
 * real npm `express` name@version pairs and their real, published sha512
 * integrity (scripts/fixtures/e2e-lockfile-packages.json — public npm
 * facts, not a review record; see the fixture file's own banner). Every
 * entry resolves as reviewed, never UNRESOLVABLE or INTEGRITY_MISMATCH,
 * because both the lockfile body and the seeded audit_status row below
 * carry the exact same real digest.
 */
function loadOnChainFixtureEntries() {
  const fixturePath = path.join(scriptDir, 'fixtures', 'e2e-lockfile-packages.json')
  const entries = JSON.parse(fs.readFileSync(fixturePath, 'utf8'))
  if (entries.length < ONCHAIN_ENTRY_COUNT) {
    throw new Error(
      `fixtures/e2e-lockfile-packages.json has only ${entries.length} entries, ` +
        `need at least ${ONCHAIN_ENTRY_COUNT}`,
    )
  }
  return entries.slice(0, ONCHAIN_ENTRY_COUNT)
}

/**
 * Builds a lockfileVersion 3 body listing every fixture entry once, each
 * under its own synthetic nested path (`node_modules/depN/node_modules/
 * express`) — a real lockfile shape for a monorepo that pins many versions
 * of the same dependency across its workspaces. `packageNameFromKey`
 * (proxy/src/attest/lockfile.ts) reads the name from the path's last
 * segment, so the nesting never affects classification; `version` on each
 * entry is what actually varies.
 */
function buildOnChainLockfileBytes(entries) {
  const packages = {}
  entries.forEach((entry, index) => {
    packages[`node_modules/dep${index}/node_modules/${entry.name}`] = {
      version: entry.version,
      resolved: `https://registry.npmjs.org/${entry.name}/-/${entry.name}-${entry.version}.tgz`,
      integrity: entry.integrity,
    }
  })
  return Buffer.from(JSON.stringify({ lockfileVersion: 3, packages }))
}

/** `identity`'s USDC holding on `address`; 0 when not opted in or empty. */
async function usdcHolding(algod, address, assetId) {
  const info = await algod.accountInformation(address).do()
  const holding = (info.assets ?? []).find((a) => Number(a.assetId) === Number(assetId))
  return holding ? Number(holding.amount) : 0
}

/**
 * Claims `identity`'s whole PaymentRouter balance with `account`, and
 * asserts the claimant's own USDC balance grew by exactly the claimed
 * amount — reuses scripts/claim.mjs's own guards and submission logic
 * (never a second, hand-rolled claim path).
 */
async function claimOnChain(algod, appId, identity, account, payToAddress, assetId, loraUrl) {
  const mapped = await readMappedAddress(algod, appId, identity)
  assertSignerIsMappedAddress(mapped, account.addr.toString())
  const balance = await readIdentityBalance(algod, appId, identity)
  assertBalanceAtLeastMinClaim(balance)

  const usdcBefore = await usdcHolding(algod, account.addr.toString(), assetId)
  const txid = await submitClaim(algod, appId, identity, account, payToAddress, assetId)
  await algosdk.waitForConfirmation(algod, txid, 6)
  const usdcAfter = await usdcHolding(algod, account.addr.toString(), assetId)
  const grew = usdcAfter - usdcBefore
  if (grew !== balance) {
    throw new Error(`claimant USDC balance grew by ${grew}, expected exactly ${balance}`)
  }
  console.log(`\n    Claim (${identity}): ${txid}`)
  console.log(`    Lora: ${loraUrl(txid)}`)
}

/** A plain ALGO payment from `funderAccount` to `recipientAddress`. Returns the confirmed txid. */
async function fundAccount(algod, funderAccount, recipientAddress, amountMicroAlgo) {
  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: funderAccount.addr.toString(),
    receiver: recipientAddress,
    amount: amountMicroAlgo,
    suggestedParams: sp,
  })
  const signed = txn.signTxn(funderAccount.sk)
  const { txid } = await algod.sendRawTransaction(signed).do()
  await algosdk.waitForConfirmation(algod, txid, 6)
  return txid
}

/** An unused, OS-assigned TCP port on localhost, for the dedicated rehearsal proxy. */
function findFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
  })
}

export function resolveTsxBin() {
  for (const dir of ['mcp', 'proxy', 'cli']) {
    const bin = path.join(scriptDir, '..', dir, 'node_modules', '.bin', 'tsx')
    if (fs.existsSync(bin)) return bin
  }
  throw new Error(
    'no tsx binary found under proxy/, mcp/, or cli/ node_modules — set up dependencies with pnpm',
  )
}

/**
 * Runs `relativeScript` (inside `cwd`) to completion via `tsxBin`, with an
 * explicit env object only — never the operator's root .env (R3a Result
 * 2: a child process must never inherit a real donor or crediter key
 * through the shell's own environment or a `--env-file` flag). Throws with
 * the combined stdout/stderr on a non-zero exit.
 */
export function runTsxScript(tsxBin, cwd, relativeScript, env) {
  const result = spawnSync(tsxBin, [relativeScript], { cwd, env, encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${relativeScript} exited ${result.status}: ${result.stdout ?? ''}${result.stderr ?? ''}`,
    )
  }
  return result.stdout ?? ''
}

/**
 * Starts a dedicated proxy process for the rehearsal, with an explicit env
 * object only (see runTsxScript's own warning). Returns the running child
 * process; the caller stops it in a finally block (stopRehearsalProxy).
 */
function startRehearsalProxy(tsxBin, proxyDir, env) {
  const child = spawn(tsxBin, ['src/index.ts'], {
    cwd: proxyDir,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk) => {
    output += chunk
  })
  child.stderr.on('data', (chunk) => {
    output += chunk
  })
  child.rehearsalOutput = () => output
  return child
}

async function waitForRehearsalProxyReady(url, child, timeoutMs = 30_000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (child.exitCode !== null) {
      throw new Error(
        `rehearsal proxy exited early (code ${child.exitCode}): ${child.rehearsalOutput()}`,
      )
    }
    try {
      const res = await fetch(`${url}/api/v1/status/ping/1.0.0`)
      if (res.ok) return
    } catch {
      // not ready yet
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }
  throw new Error(`rehearsal proxy at ${url} never became ready: ${child.rehearsalOutput()}`)
}

function stopRehearsalProxy(child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
}

/**
 * The dedicated rehearsal proxy's own env — explicit keys only, so it can
 * never see DEPLOYER_MNEMONIC, CREDITER_MNEMONIC, AUPM_DONOR_MNEMONIC, or
 * the root .env (R3a Result 2). AUPM_ISSUER_URL uses an RFC 2606 reserved
 * domain (Q13 — the server refuses to boot without one on every network),
 * mirroring scripts/verify.sh's own rehearsal config.
 */
function buildRehearsalProxyEnv({ port, sqlitePath, payToAddress, attestSigningKey }) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NETWORK: 'testnet',
    PORT: String(port),
    SQLITE_PATH: sqlitePath,
    PAY_TO_ADDRESS: payToAddress,
    ATTEST_SIGNING_KEY: attestSigningKey,
    AUPM_ISSUER_URL: 'https://aupm-e2e-rehearsal.invalid',
    AUPM_KEY_VALID_FROM: '2026-01-01T00:00:00Z',
    FACILITATOR_URL: process.env.FACILITATOR_URL ?? 'https://facilitator.goplausible.xyz',
    ALGOD_SERVER: process.env.ALGOD_SERVER ?? 'https://testnet-api.algonode.cloud',
    ALGOD_PORT: process.env.ALGOD_PORT ?? '443',
    ALGOD_TOKEN: process.env.ALGOD_TOKEN ?? '',
    // The in-process nightly scheduler (ADR 0009) is off for this rehearsal
    // proxy: its start-up catch-up run would call out to the default
    // MainNet indexer/algod (this env sets no INDEXER_URL, and NETWORK is
    // testnet here) — a live network call this rehearsal does not expect.
    // runOnChainRehearsal runs the nightly job itself, explicitly, as its
    // own subprocess (runNightlySubprocess, buildRehearsalNightlyEnv).
    AUPM_NIGHTLY: 'off',
  }
}

/** The fixture-seeding subprocess's own env: only enough to open the rehearsal DB. */
function buildRehearsalSeedEnv({ sqlitePath }) {
  return { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', SQLITE_PATH: sqlitePath }
}

/**
 * The nightly-job subprocess's own env. Carries CREDITER_MNEMONIC (the one
 * secret this step needs) but never DEPLOYER_MNEMONIC or
 * AUPM_DONOR_MNEMONIC — and never the root .env (R3a Result 2: this
 * replaces `pnpm -C proxy nightly`, whose own npm script runs
 * `node --env-file=../.env`).
 */
function buildRehearsalNightlyEnv({ sqlitePath, payToAddress, appId, backupDir }) {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? '',
    NETWORK: 'testnet',
    SQLITE_PATH: sqlitePath,
    PAY_TO_ADDRESS: payToAddress,
    PAYMENT_ROUTER_APP_ID: String(appId),
    CREDITER_MNEMONIC: process.env.CREDITER_MNEMONIC,
    ALGOD_SERVER: process.env.ALGOD_SERVER ?? 'https://testnet-api.algonode.cloud',
    ALGOD_PORT: process.env.ALGOD_PORT ?? '443',
    ALGOD_TOKEN: process.env.ALGOD_TOKEN ?? '',
    INDEXER_URL: process.env.INDEXER_URL ?? 'https://testnet-idx.algonode.cloud',
    BACKUP_DIR: backupDir,
  }
}

/**
 * Writes a throwaway seed script that reuses proxy/src/status.js's own
 * review-status setter and e2e-guard.mjs's own assertSqliteWriteAllowed()
 * (never a second, hand-rolled write path) to seed `entries` as
 * COMMUNITY_REVIEWED rows. Runs as its own subprocess (its own
 * SQLITE_PATH), because proxy/src/db.js binds to whatever SQLITE_PATH was
 * set at its first import in a process (ESM module caching) — and this
 * process already imported it once, for the main proxy's own SQLITE_PATH,
 * earlier in main(). Returns the script's path.
 */
function writeSeedFixturesScript(entries, reviewerLogin, repo) {
  const rows = entries.map((e) => ({ name: e.name, version: e.version, integrity: e.integrity }))
  const statusHref = pathToFileURL(path.join(scriptDir, '..', 'proxy', 'src', 'status.ts')).href
  const guardHref = pathToFileURL(path.join(scriptDir, 'e2e-guard.mjs')).href
  const body = `import { setStatus } from ${JSON.stringify(statusHref)}
import { assertSqliteWriteAllowed } from ${JSON.stringify(guardHref)}

assertSqliteWriteAllowed(process.env.SQLITE_PATH)

const rows = ${JSON.stringify(rows)}
for (const row of rows) {
  /* guard-allow: RULE9 — the on-chain rehearsal's own throwaway-SQLITE_PATH fixture write, gated by assertSqliteWriteAllowed() above */ setStatus(
    row.name,
    row.version,
    'COMMUNITY_REVIEWED',
    'E2E_ONCHAIN_AUDITOR',
    'E2E_ONCHAIN_TXID',
    row.integrity,
    ${JSON.stringify(reviewerLogin)},
    null,
    ${JSON.stringify(repo)},
  )
}
console.log(\`seeded \${rows.length} rehearsal fixture rows\`)
`
  const scriptPath = path.join(tmpDir, 'seed-rehearsal-fixtures.mjs')
  fs.writeFileSync(scriptPath, body)
  return scriptPath
}

/** Runs the nightly job (proxy/src/claims/nightly-main.ts) as its own subprocess. */
function runNightlySubprocess(tsxBin, proxyDir, env) {
  return runTsxScript(tsxBin, proxyDir, 'src/claims/nightly-main.ts', env)
}

/**
 * Runs the 250-package on-chain rehearsal (R3a): generates fresh in-memory
 * payTo/auditor/ops accounts, funds and opts each in, deploys a fresh
 * PaymentRouter, rekeys payTo, starts a dedicated proxy process on its own
 * throwaway SQLite database, seeds the fixture rows into that database
 * only, pays for the lockfile via the real MCP attest_lockfile tool, runs
 * the nightly job, and claims both identities. Every sub-step is its own
 * `check()`, so a failure here is a FAIL with the exact assertion that
 * broke — never a silent skip and never a false PASS. Preconditions run
 * first and, on failure, stop the whole rehearsal. The dedicated proxy is
 * always stopped, even on failure (finally block).
 */
async function runOnChainRehearsal(loraUrl) {
  const { PRICE_PER_REVIEWED_PACKAGE_MICRO } = await import('../proxy/src/routes/attest.js')
  const priceMicro = ONCHAIN_ENTRY_COUNT * PRICE_PER_REVIEWED_PACKAGE_MICRO

  const usdcAsaId = BigInt(usdcAssetId('testnet'))
  const { server, port, token } = algodEndpoint('testnet')
  const algod = new algosdk.Algodv2(token, server, port)

  const deployerAccount = algosdk.mnemonicToSecretKey(process.env.DEPLOYER_MNEMONIC)
  const crediterAccount = algosdk.mnemonicToSecretKey(process.env.CREDITER_MNEMONIC)
  const donorAccount = algosdk.mnemonicToSecretKey(process.env.AUPM_DONOR_MNEMONIC)

  // Fresh, in-memory-only accounts — never written to disk or logged; only
  // their addresses are printed.
  const payToAccount = algosdk.generateAccount()
  const auditorAccount = algosdk.generateAccount()
  const opsAccount = algosdk.generateAccount()
  console.log(`  (rehearsal payTo: ${payToAccount.addr})`)
  console.log(`  (rehearsal auditor claimant: ${auditorAccount.addr})`)
  console.log(`  (rehearsal ops claimant: ${opsAccount.addr})`)

  const preconditionsOk = await check('on-chain: hermetic rehearsal preconditions', async () => {
    // Genesis guard first (R3c): nothing on-chain below this line may run
    // before algod and the indexer both agree with the rehearsal's own
    // TestNet-only network (onChainRehearsalSkipReason already refuses
    // MainNet before this function is ever called).
    await assertNetworkGenesisMatchesEverywhere('testnet')

    assertRehearsalKeysDistinct({
      deployerAddress: deployerAccount.addr.toString(),
      crediterAddress: crediterAccount.addr.toString(),
      donorAddress: donorAccount.addr.toString(),
    })
    const deployerInfo = await algod.accountInformation(deployerAccount.addr.toString()).do()
    assertDeployerFunded(Number(deployerInfo.amount), undefined, deployerAccount.addr.toString())
    const donorBalance = await usdcHolding(algod, donorAccount.addr.toString(), usdcAsaId)
    assertDonorFundedForRehearsal(donorBalance, donorAccount.addr.toString())
  })
  if (!preconditionsOk) return

  const tsxBin = resolveTsxBin()
  const proxyDir = path.join(scriptDir, '..', 'proxy')
  let rehearsalProxy
  try {
    const fundOk = await check('on-chain: fund and opt in payTo/auditor/ops', async () => {
      await fundAccount(
        algod,
        deployerAccount,
        payToAccount.addr.toString(),
        payToFundingMicroAlgo(),
      )
      await optinAccountToUsdc({ algod, network: 'testnet', account: payToAccount })
      await fundAccount(
        algod,
        deployerAccount,
        auditorAccount.addr.toString(),
        claimantFundingMicroAlgo(),
      )
      await optinAccountToUsdc({ algod, network: 'testnet', account: auditorAccount })
      await fundAccount(
        algod,
        deployerAccount,
        opsAccount.addr.toString(),
        claimantFundingMicroAlgo(),
      )
      await optinAccountToUsdc({ algod, network: 'testnet', account: opsAccount })
    })
    if (!fundOk) return

    let appId
    const deployOk = await check('on-chain: deploy fresh PaymentRouter', async () => {
      const { deployPaymentRouter } = await import(
        '../contracts/smart_contracts/payment_router/deploy-config.js'
      )
      const { AlgorandClient } = requireFromContracts('@algorandfoundation/algokit-utils')
      const algorand = AlgorandClient.testNet()
      const deployerSigner = await algorand.account.fromEnvironment('DEPLOYER')
      const identityMap = new Map([
        [ONCHAIN_IDENTITY, auditorAccount.addr.toString()],
        [ONCHAIN_OPS_IDENTITY, opsAccount.addr.toString()],
      ])
      // A unique app name per run (R3d): algokit's idempotent
      // factory.deploy() looks up an existing app by creator + name, and a
      // fixed "PaymentRouter" name let a live TestNet run find and reuse an
      // earlier failed rehearsal's leftover app — silently setting
      // crediter/identities on it before the rekey guard caught the
      // mismatch. requireFreshCreate makes deployPaymentRouter itself
      // refuse (before any setCrediter/setIdentity call) unless this run's
      // own deploy performed a fresh "create".
      const result = await deployPaymentRouter({
        algorand,
        network: 'testnet',
        deployer: deployerSigner,
        crediterAddress: crediterAccount.addr.toString(),
        payToAddress: payToAccount.addr.toString(),
        identityMap,
        appName: `PaymentRouter-e2e-${Date.now()}`,
        requireFreshCreate: true,
      })
      appId = result.appId
      return `app ${appId}`
    })
    if (!deployOk) return

    const rekeyOk = await check('on-chain: rekey fresh payTo to PaymentRouter', async () => {
      const txid = await rekeyPayToToApp({
        algod,
        network: 'testnet',
        payToAccount,
        appId,
        expectedCreator: deployerAccount.addr.toString(),
      })
      console.log(`\n    Rekey: ${txid}`)
      console.log(`    Lora: ${loraUrl(txid)}`)
    })
    if (!rekeyOk) return

    const rehearsalPort = await findFreePort()
    const rehearsalSqlitePath = path.join(tmpDir, 'rehearsal.db')
    const rehearsalBackupDir = path.join(tmpDir, 'nightly-backup')
    const rehearsalProxyUrl = `http://localhost:${rehearsalPort}`
    const attestSigningKey = randomBytes(32).toString('hex')

    const proxyStartOk = await check('on-chain: start rehearsal proxy', async () => {
      const env = buildRehearsalProxyEnv({
        port: rehearsalPort,
        sqlitePath: rehearsalSqlitePath,
        payToAddress: payToAccount.addr.toString(),
        attestSigningKey,
      })
      rehearsalProxy = startRehearsalProxy(tsxBin, proxyDir, env)
      await waitForRehearsalProxyReady(rehearsalProxyUrl, rehearsalProxy)
      return rehearsalProxyUrl
    })
    if (!proxyStartOk) return

    const fixtureEntries = loadOnChainFixtureEntries()
    const seedOk = await check('on-chain: seed 250 rehearsal fixture rows', () => {
      const scriptPath = writeSeedFixturesScript(
        fixtureEntries,
        ONCHAIN_REVIEWER_LOGIN,
        ONCHAIN_REPO,
      )
      const env = buildRehearsalSeedEnv({ sqlitePath: rehearsalSqlitePath })
      return runTsxScript(tsxBin, scriptDir, scriptPath, env).trim()
    })
    if (!seedOk) return

    const lockfilePath = path.join(tmpDir, 'onchain-package-lock.json')
    fs.writeFileSync(lockfilePath, buildOnChainLockfileBytes(fixtureEntries))

    // mcp/src/tools/attest.js's own PROXY_URL constant bakes in at its
    // first-ever import in this process — set AUPM_PROXY_URL to the
    // rehearsal proxy before that import ever runs, so it targets the
    // dedicated rehearsal proxy, never the main e2e proxy from earlier in
    // this file (a different module, mcp/src/tools/install.js, already
    // baked in that one in §8 above).
    process.env.AUPM_PROXY_URL = rehearsalProxyUrl
    const { attestLockfileTool } = await import('../mcp/src/tools/attest.js')

    const paymentOk = await check(
      `on-chain: ${ONCHAIN_ENTRY_COUNT}-pkg lockfile payment (${priceMicro} microUSDC)`,
      async () => {
        const result = await attestLockfileTool.handler({ lockfilePath, allowDonation: true })
        if (result.status !== 'attested') {
          throw new Error(`expected attested, got ${result.status}`)
        }
        if (result.summary?.reviewed !== ONCHAIN_ENTRY_COUNT) {
          throw new Error(
            `expected ${ONCHAIN_ENTRY_COUNT} reviewed, got ${result.summary?.reviewed}`,
          )
        }
      },
    )
    if (!paymentOk) return

    const nightlyEnv = buildRehearsalNightlyEnv({
      sqlitePath: rehearsalSqlitePath,
      payToAddress: payToAccount.addr.toString(),
      appId,
      backupDir: rehearsalBackupDir,
    })

    let batchSeq
    const creditOk = await check('on-chain: nightly credit (250-pkg batch)', () => {
      const output = runNightlySubprocess(tsxBin, proxyDir, nightlyEnv)
      for (const line of output.split('\n')) {
        if (line.trim()) console.log(`    ${line.trim()}`)
      }
      const match = /credited batch (\d+), txid (\S+)/.exec(output)
      if (!match) throw new Error(`nightly job did not credit a batch: ${output}`)
      batchSeq = Number(match[1])
      const creditTxid = match[2]
      if (batchSeq !== 1) {
        throw new Error(`expected batch 1 on a fresh app, got batch ${batchSeq}`)
      }
      console.log(`    Lora: ${loraUrl(creditTxid)}`)
    })
    if (!creditOk) return

    let auditorBalance
    let opsBalance
    const balancesOk = await check(
      'on-chain: fresh app balances match the 250-pkg batch exactly',
      async () => {
        const BetterSqlite3 = requireFromProxy('better-sqlite3')
        const rehearsalDb = new BetterSqlite3(rehearsalSqlitePath, { readonly: true })
        let batchRow
        try {
          batchRow = rehearsalDb
            .prepare(
              'SELECT attributed_micro, unattributed_micro, credit_txid FROM batches WHERE batch_seq = ?',
            )
            .get(batchSeq)
        } finally {
          rehearsalDb.close()
        }
        if (!batchRow?.credit_txid) {
          throw new Error(`batch ${batchSeq} has no recorded credit_txid`)
        }

        auditorBalance = await readIdentityBalance(algod, appId, ONCHAIN_IDENTITY)
        opsBalance = await readIdentityBalance(algod, appId, ONCHAIN_OPS_IDENTITY)
        if (auditorBalance !== ONCHAIN_AUDITOR_SHARE_MICRO) {
          throw new Error(
            `auditor balance is ${auditorBalance}, expected exactly ${ONCHAIN_AUDITOR_SHARE_MICRO}`,
          )
        }
        if (opsBalance !== ONCHAIN_OPS_SHARE_MICRO) {
          throw new Error(
            `ops balance is ${opsBalance}, expected exactly ${ONCHAIN_OPS_SHARE_MICRO}`,
          )
        }
      },
    )
    if (!balancesOk) return

    console.log(
      `  (auditor balance before claim: ${auditorBalance} microUSDC — at least MIN_CLAIM ${MIN_CLAIM})`,
    )
    console.log(
      `  (ops balance before claim: ${opsBalance} microUSDC — at least MIN_CLAIM ${MIN_CLAIM})`,
    )

    await check(`on-chain: claim (${ONCHAIN_IDENTITY})`, () =>
      claimOnChain(
        algod,
        appId,
        ONCHAIN_IDENTITY,
        auditorAccount,
        payToAccount.addr.toString(),
        usdcAsaId,
        loraUrl,
      ),
    )
    await check('on-chain: claim (ops)', () =>
      claimOnChain(
        algod,
        appId,
        ONCHAIN_OPS_IDENTITY,
        opsAccount,
        payToAccount.addr.toString(),
        usdcAsaId,
        loraUrl,
      ),
    )
  } finally {
    stopRehearsalProxy(rehearsalProxy)
  }
}

async function main() {
  // config.js resolves NETWORK/CAIP2/USDC-asset/payTo from the same
  // environment the proxy process reads — imported directly, never
  // re-derived, so this script can never drift from what the proxy is
  // actually enforcing.
  const { NETWORK, CAIP2_NETWORK, USDC_ASA_ID, PAY_TO, FACILITATOR_URL, resolveFeePayer } =
    await import('../proxy/src/config.js')
  const { setStatus } = await import('../proxy/src/status.js')
  const { decodePaymentRequiredHeader } = requireFromProxy('@x402-avm/core/http')
  const { HTTPFacilitatorClient } = requireFromProxy('@x402-avm/core/server')

  const netSegment = NETWORK === 'testnet' ? 'testnet' : 'mainnet'
  const loraUrl = (txid) => `https://lora.algokit.io/${netSegment}/transaction/${txid}`

  console.log(`== AuPM E2E (network=${NETWORK}, proxy=${PROXY_URL}) ==`)

  // ── 1. Free path: install an UNREVIEWED package — zero payment, no wallet ──
  await check('free install (UNREVIEWED): 200, no payment, no wallet', async () => {
    const res = await fetch(`${PROXY_URL}/chalk/-/chalk-5.3.0.tgz`)
    if (res.status === 402) throw new Error('unreviewed tarball must never return 402')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (res.headers.get('PAYMENT-REQUIRED')) {
      throw new Error('unreviewed tarball must carry no PAYMENT-REQUIRED header')
    }
  })

  // An unreviewed tarball never returns 402, even with the donate header —
  // the free tier is sacred (CLAUDE.md invariant 4).
  await check('unreviewed tarball, X-AuPM-Donate: 1: still 200, never 402', async () => {
    const res = await fetch(`${PROXY_URL}/chalk/-/chalk-5.3.0.tgz`, {
      headers: { 'X-AuPM-Donate': '1' },
    })
    if (res.status === 402) throw new Error('unreviewed tarball must never return 402')
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
  })

  // ── 2. Paid gate: seed a COMMUNITY_REVIEWED tarball ───────────────────────
  const PAID_PKG = 'express'
  const PAID_VER = '4.21.2'
  // The call below writes through the real status store (better-sqlite3,
  // the same SQLITE_PATH the proxy process has open) — no external
  // `sqlite3` binary dependency, and no hand-written SQL to drift from the
  // schema.
  //
  // Refuses first unless SQLITE_PATH resolves inside a throwaway directory
  // (os.tmpdir()): this script runs manually, on any machine, and a real
  // deployment's database (the Docker Compose path is /data/audit.db) must
  // never receive a fake review row (CLAUDE.md invariant 5). NETWORK alone
  // does not cover this — the first deploy is TestNet, not MainNet.
  assertSqliteWriteAllowed(process.env.SQLITE_PATH)
  setStatus(PAID_PKG, PAID_VER, 'COMMUNITY_REVIEWED', 'E2E_AUDITOR', 'E2E_TXID') // guard-allow: RULE9 — e2e.mjs's own throwaway-SQLITE_PATH fixture write, gated by assertSqliteWriteAllowed() above

  // A reviewed tarball is free by default (ADR 0006) — it returns 402 only
  // when the request opts in with X-AuPM-Donate: 1.
  await check(`reviewed tarball, no donate header: ${PAID_PKG}@${PAID_VER} -> 200`, async () => {
    const res = await fetch(`${PROXY_URL}/${PAID_PKG}/-/${PAID_PKG}-${PAID_VER}.tgz`)
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    if (!res.headers.get('X-AuPM-Tier')) throw new Error('missing X-AuPM-Tier response header')
    if (res.headers.get('X-AuPM-Donate-Hint') !== '1000') {
      throw new Error(`bad X-AuPM-Donate-Hint: ${res.headers.get('X-AuPM-Donate-Hint')}`)
    }
  })

  await check(`paid gate: ${PAID_PKG}@${PAID_VER} tarball, X-AuPM-Donate: 1 -> 402`, async () => {
    const res = await fetch(`${PROXY_URL}/${PAID_PKG}/-/${PAID_PKG}-${PAID_VER}.tgz`, {
      headers: { 'X-AuPM-Donate': '1' },
    })
    if (res.status !== 402) throw new Error(`expected 402, got ${res.status}`)

    // The 402 JSON body is always `{}` — requirements travel in the
    // PAYMENT-REQUIRED header (base64), never in the body (SPEC.md §11.3).
    const body = await res.json()
    if (Object.keys(body).length !== 0) {
      throw new Error(`402 body must be {}, got ${JSON.stringify(body)}`)
    }

    const headerB64 = res.headers.get('PAYMENT-REQUIRED')
    if (!headerB64) throw new Error('missing PAYMENT-REQUIRED response header')
    const decoded = decodePaymentRequiredHeader(headerB64)
    const accept = decoded.accepts?.[0]
    if (!accept) throw new Error('decoded header carries no accepts[0]')

    if (accept.scheme !== 'exact') throw new Error(`bad scheme: ${accept.scheme}`)
    if (accept.network !== CAIP2_NETWORK) throw new Error(`bad network: ${accept.network}`)
    if (accept.asset !== USDC_ASA_ID) throw new Error(`bad asset: ${accept.asset}`)
    if (accept.amount !== '1000') throw new Error(`bad amount: ${accept.amount}`)
    // G5: a bare equality check against PAY_TO proves nothing when the
    // proxy is misconfigured — an empty (or malformed) PAY_TO would equal
    // an equally empty advertised payTo. Assert the shape independently:
    // 58-char base32 with a valid checksum (algosdk.isValidAddress), then
    // assert it matches the configured value.
    if (!algosdk.isValidAddress(accept.payTo)) {
      throw new Error(`bad payTo: "${accept.payTo}" is not a valid Algorand address`)
    }
    if (accept.payTo !== PAY_TO) throw new Error(`bad payTo: ${accept.payTo}`)
    if (accept.extra?.asset !== USDC_ASA_ID)
      throw new Error(`bad extra.asset: ${accept.extra?.asset}`)
    if (accept.extra?.tag !== 'x402-global-challenge') {
      throw new Error(`bad extra.tag: ${accept.extra?.tag}`)
    }

    // Independently resolve the expected fee payer straight from the
    // facilitator, the same way proxy/src/x402/server.ts#boot() did — never
    // hardcoded, never assumed.
    const facilitator = new HTTPFacilitatorClient({ url: FACILITATOR_URL })
    const supported = await facilitator.getSupported()
    const expectedFeePayer = resolveFeePayer(supported, CAIP2_NETWORK)
    if (accept.extra?.feePayer !== expectedFeePayer) {
      throw new Error(`bad extra.feePayer: ${accept.extra?.feePayer}, want ${expectedFeePayer}`)
    }
  })

  // ── 3. Zero-coverage lockfile: 200, free, signed attestation ─────────────
  const lockfileBytes = Buffer.from(
    JSON.stringify({
      lockfileVersion: 3,
      packages: { 'node_modules/left-pad': { version: '1.3.0' } },
    }),
  )
  let attestation
  await check('lockfile (zero-coverage): 200 free, signed attestation', async () => {
    const res = await fetch(`${PROXY_URL}/v1/attest/lockfile`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: lockfileBytes,
    })
    if (res.status !== 200) throw new Error(`expected 200, got ${res.status}`)
    if (res.headers.get('PAYMENT-REQUIRED')) {
      throw new Error('a zero-coverage lockfile must never carry a PAYMENT-REQUIRED header')
    }
    const data = await res.json()
    if (data.summary?.reviewed !== 0)
      throw new Error(`expected 0 reviewed, got ${data.summary?.reviewed}`)
    if (!data.attestation?.signatures?.length) throw new Error('no signature on the attestation')
    attestation = data.attestation
  })

  // ── 4. Offline verification — reuse the CLI verifier, never reimplement ──
  await check('attestation verifies offline (aupm verify)', async () => {
    if (!attestation) throw new Error('no attestation captured from check 3')
    const signingKeySource = process.env.ATTEST_SIGNING_KEY
    if (!signingKeySource) throw new Error('ATTEST_SIGNING_KEY not set in this process')
    const signingKey = await deriveAttestSigningKey(signingKeySource)
    const keyArg = `${signingKey.keyid}:${Buffer.from(signingKey.publicKey).toString('base64')}`

    const envelopePath = path.join(tmpDir, 'lockfile-attestation.json')
    fs.writeFileSync(envelopePath, JSON.stringify(attestation))
    const lockfilePath = path.join(tmpDir, 'package-lock.json')
    fs.writeFileSync(lockfilePath, lockfileBytes)

    const { runVerify } = await import('../cli/src/verify.js')
    const code = await runVerify([envelopePath, '--lockfile', lockfilePath, '--key', keyArg])
    if (code !== 0) throw new Error('aupm verify exited non-zero — see output above')
  })

  // ── 5. Status API: row shape, and unknown version -> UNREVIEWED ──────────
  await check('status API: row shape for a reviewed package', async () => {
    const res = await fetch(`${PROXY_URL}/api/v1/status/${PAID_PKG}/${PAID_VER}`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    for (const key of [
      'pkg',
      'version',
      'status',
      'auditor_addr',
      'anchor_txid',
      'ts',
      'integrity',
    ]) {
      if (!(key in data)) throw new Error(`row missing key "${key}"`)
    }
    if (data.status !== 'COMMUNITY_REVIEWED') throw new Error(`got ${data.status}`)
  })

  await check('status API: unknown version -> UNREVIEWED', async () => {
    const res = await fetch(`${PROXY_URL}/api/v1/status/unknown-pkg-xyz-e2e/1.0.0`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data.status !== 'UNREVIEWED') throw new Error(`got ${data.status}`)
  })

  // ── 6. Auto-reset: version bump -> UNREVIEWED ─────────────────────────────
  await check('auto-reset: version bump -> UNREVIEWED', async () => {
    const res = await fetch(`${PROXY_URL}/api/v1/status/${PAID_PKG}/9.9.9-e2e-bump`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const data = await res.json()
    if (data.status !== 'UNREVIEWED') throw new Error(`got ${data.status}`)
  })

  // ── 7. Earnings ledger: free, reachable ───────────────────────────────────
  await check('earnings route: free, reachable', async () => {
    const res = await fetch(`${PROXY_URL}/api/v1/earnings/github/octocat`)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    if (res.headers.get('PAYMENT-REQUIRED')) throw new Error('earnings must never be gated')
  })

  // ── 8. On-chain: paid install ────────────────────────────────────────────
  // WARNING: never print PASS here for a step that did not run. A missing
  // credential is a SKIP with the exact reason — never a FAIL, never a
  // silent PASS.
  const payerMnemonic = process.env.AUPM_DONOR_MNEMONIC

  if (!payerMnemonic) {
    skip(
      'on-chain: paid install',
      'AUPM_DONOR_MNEMONIC not set — no funded wallet in this environment',
    )
  } else {
    let paymentTxid
    await check('on-chain: paid install -> plain USDC transfer, no inner txns', async () => {
      // Genesis guard first (R3c): nothing on-chain below this line may run
      // before algod and the indexer both agree with NETWORK.
      await assertNetworkGenesisMatchesEverywhere(NETWORK)

      // Reuses the real MCP install tool — never a hand-rolled payment flow.
      const { installTool } = await import('../mcp/src/tools/install.js')
      const result = await installTool.handler({
        pkg: PAID_PKG,
        version: PAID_VER,
        allowDonation: true,
      })
      if (!result.tarballPath || !fs.existsSync(result.tarballPath)) {
        throw new Error('tarball not saved to disk')
      }
      if (result.status !== 'paid') throw new Error(`expected paid, got ${result.status}`)
      if (!result.txid) throw new Error('no settlement txid returned')
      paymentTxid = result.txid

      // The payment leg is a plain USDC transfer to payTo. PaymentRouter's
      // credit/claim step runs later and separately (see §9 below) — this
      // check's own payment never lands on the fresh, dedicated rehearsal
      // payTo, so it never perturbs that step's exact-balance assertions.
      //
      // Looked up through the indexer, never algod's pendingTransactionInformation
      // (Defect 2, R3b): a load-balanced public algod node can 404 an
      // already-confirmed txid it never itself saw. The indexer lags
      // confirmation by a few seconds, so this retries with a bound.
      const { server, port, token } = indexerEndpoint(NETWORK)
      const indexerClient = new algosdk.Indexer(token, server, port)
      const transaction = await waitForIndexerTransaction(indexerClient, result.txid)
      assertPlainUsdcTransferNoInner(transaction, {
        payToAddress: PAY_TO,
        assetId: USDC_ASA_ID,
        txid: result.txid,
      })
      console.log(`\n    Settlement: ${result.txid}`)
      console.log(`    Lora: ${loraUrl(result.txid)}`)
      return result.txid
    })

    if (paymentTxid) console.log(`  (payment txid: ${paymentTxid})`)
  }

  // ── 9. On-chain: PaymentRouter 250-package credit/claim rehearsal ───────
  const onChainReason = onChainRehearsalSkipReason(NETWORK, process.env)
  if (onChainReason) {
    skip('on-chain: PaymentRouter 250-pkg credit/claim rehearsal', onChainReason)
  } else {
    await runOnChainRehearsal(loraUrl)
  }

  console.log('===========================')
  console.log(`E2E: ${passed} passed, ${failed} failed, ${skipped} skipped`)
  if (failed === 0) {
    console.log('E2E: PASS')
    process.exit(0)
  } else {
    console.log(`E2E: FAIL (${failed} check(s) failed)`)
    process.exit(1)
  }
}

// Guarded so scripts/e2e.test.mjs can import this module's pure exports
// (onChainRehearsalSkipReason and the funding/precondition helpers)
// without running the whole e2e suite — mirrors every other dual-purpose
// script in this directory (network.mjs, rekey-payto.mjs, claim.mjs).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error('E2E: FAIL', e.stack ?? e.message)
    process.exit(1)
  })
}
