#!/usr/bin/env node

// scripts/reconcile.ts
//
// Nightly claims-ledger reconciliation runner (SPEC-v3.md 5.2, CLAUDE.md
// invariant 2). Lists confirmed USDC axfers into payTo from an Algorand
// indexer and ledgers any inflow with no matching accrual row as
// `unassigned`. An external cron or systemd timer starts this script — it
// holds no scheduling logic of its own (mirrors scripts/payout.ts).
//
// CAUTION: this script lives outside the proxy pnpm workspace package, so
// plain `node` cannot resolve the `./foo.js`-style specifiers
// proxy/src/claims/*.ts uses to import each other — those resolve under
// vitest's bundler-mode module resolution, not under plain Node. Exactly
// like scripts/payout.ts, this script is therefore self-contained: it talks
// to the indexer and the ledger with its own logic, mirroring
// proxy/src/claims/indexer.ts and reconcile.ts rather than importing them.
// Keep this in lock-step with those two files by hand — their unit tests
// (proxy/src/claims/indexer.test.ts, reconcile.test.ts) are the ones that
// actually exercise this behavior.
//
// Run with: node --experimental-strip-types scripts/reconcile.ts

import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const proxyRoot = path.join(__dirname, '..', 'proxy')

// This script lives outside the proxy pnpm workspace package, so it has no
// node_modules of its own. Anchor `require` at proxy/package.json to reach
// the dependencies already installed there (better-sqlite3, algosdk,
// @x402-avm/avm) without adding a new dependency declaration anywhere.
const proxyRequire = createRequire(path.join(proxyRoot, 'package.json'))

const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud'

// One page of `/v2/transactions` per request. Well under the indexer's own
// hard cap, and small enough that a single page never times out.
const PAGE_LIMIT = 1000

// Mirrors proxy/src/claims/reconcile.ts's MIN_INFLOW_AGE_SECONDS exactly —
// see that file for why 900 seconds, and why this stays a constant, not an
// env var.
const MIN_INFLOW_AGE_SECONDS = 900

// Mirrors proxy/src/claims/attribution-rules.ts's ROLE_SHARE_PER_1000 and
// ROLES (CLAUDE.md "Canonical facts": split per 1,000 microUSDC is
// 500/200/150/100/50 — treasury and ops are not ledgered here, same as
// there).
const ROLE_SHARE_PER_1000: Record<string, number> = { auditor: 500, maintainer: 200, reviewer: 150 }
const ROLES = ['auditor', 'maintainer', 'reviewer'] as const

interface UsdcInflow {
  txid: string
  amountMicro: number
  /** Indexer round-time: unix seconds the confirming block landed. */
  confirmedAt: number
}

interface BetterSqlite3Database {
  prepare<T = unknown>(
    sql: string,
  ): {
    all(...params: unknown[]): T[]
    get(...params: unknown[]): T | undefined
    run(...params: unknown[]): unknown
  }
  transaction<A extends unknown[]>(fn: (...args: A) => void): (...args: A) => void
  close(): void
}

interface AssetTransferTxn {
  amount: bigint
  receiver: string
}

interface IndexerTxn {
  id?: string
  roundTime?: number
  assetTransferTransaction?: AssetTransferTxn
}

interface TransactionsPage {
  transactions: IndexerTxn[]
  nextToken?: string
}

interface SearchForTransactionsBuilder {
  address(address: string): SearchForTransactionsBuilder
  addressRole(role: string): SearchForTransactionsBuilder
  txType(type: string): SearchForTransactionsBuilder
  assetID(id: bigint): SearchForTransactionsBuilder
  limit(n: number): SearchForTransactionsBuilder
  nextToken(token: string): SearchForTransactionsBuilder
  do(): Promise<TransactionsPage>
}

interface AlgosdkIndexerModule {
  Indexer: new (
    token: string,
    server: string,
    port: string,
  ) => { searchForTransactions(): SearchForTransactionsBuilder }
}

/**
 * algosdk's Indexer constructor always sets `URL.port` from this argument —
 * passing the same URL's own `.port` back is a no-op for a bare host (no
 * port in the URL) and preserves an explicit one.
 */
function portOf(indexerUrl: string): string {
  return new URL(indexerUrl).port
}

/** Mirrors proxy/src/claims/indexer.ts's createIndexerClient. */
async function listUsdcInflows(
  indexerUrl: string,
  usdcAssetId: string,
  payTo: string,
): Promise<UsdcInflow[]> {
  const { Indexer } = proxyRequire('algosdk') as AlgosdkIndexerModule
  const client = new Indexer('', indexerUrl, portOf(indexerUrl))
  const assetId = BigInt(usdcAssetId)

  const inflows: UsdcInflow[] = []
  let nextToken: string | undefined

  for (;;) {
    let request = client
      .searchForTransactions()
      .address(payTo)
      .addressRole('receiver')
      .txType('axfer')
      .assetID(assetId)
      .limit(PAGE_LIMIT)
    if (nextToken) request = request.nextToken(nextToken)

    const page = await request.do()
    for (const txn of page.transactions) {
      const transfer = txn.assetTransferTransaction
      // Defence in depth: the query above already filters on these — skip
      // anything malformed rather than ledgering a wrong receiver.
      if (!transfer || transfer.receiver !== payTo) continue
      if (!txn.id || txn.roundTime === undefined) continue
      inflows.push({
        txid: txn.id,
        amountMicro: Number(transfer.amount),
        confirmedAt: txn.roundTime,
      })
    }

    nextToken = page.nextToken
    if (!nextToken) break
  }

  return inflows
}

/** Mirrors proxy/src/claims/reconcile.ts's findUnmatchedInflows. */
function findUnmatchedInflows(db: BetterSqlite3Database, inflows: UsdcInflow[]): UsdcInflow[] {
  const countForTxid = db.prepare<{ n: number }>(
    'SELECT COUNT(*) as n FROM accruals WHERE settle_txid = ?',
  )
  return inflows.filter((inflow) => (countForTxid.get(inflow.txid)?.n ?? 0) === 0)
}

/** Mirrors proxy/src/claims/reconcile.ts's isMatureEnough. */
function isMatureEnough(inflow: UsdcInflow, nowSeconds: number): boolean {
  return nowSeconds - inflow.confirmedAt >= MIN_INFLOW_AGE_SECONDS
}

interface SkippedInflow {
  txid: string
  amountMicro: number
  reason: string
}

interface ReconcileResult {
  inflowsChecked: number
  unmatchedLedgered: number
  skipped: SkippedInflow[]
}

/** Mirrors proxy/src/claims/reconcile.ts's ledgerUnassignedInflow + reconcile. */
function reconcileOnce(
  db: BetterSqlite3Database,
  inflows: UsdcInflow[],
  nowSeconds: number,
): ReconcileResult {
  const mature = inflows.filter((inflow) => isMatureEnough(inflow, nowSeconds))
  const unmatched = findUnmatchedInflows(db, mature)

  const insertUnassignedAccrual = db.prepare(
    `INSERT INTO accruals
       (settle_txid, route, pkg, version, role, identity, amount_micro, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (settle_txid, role, pkg, version) DO NOTHING`,
  )

  let unmatchedLedgered = 0
  const skipped: SkippedInflow[] = []
  for (const inflow of unmatched) {
    if (inflow.amountMicro <= 0) {
      skipped.push({
        txid: inflow.txid,
        amountMicro: inflow.amountMicro,
        reason: 'non-positive-amount',
      })
      continue
    }
    if (inflow.amountMicro % 1000 !== 0) {
      skipped.push({
        txid: inflow.txid,
        amountMicro: inflow.amountMicro,
        reason: 'not-a-multiple-of-1000-microusdc',
      })
      continue
    }
    const createdAt = Date.now()
    const writeAll = db.transaction(() => {
      for (const role of ROLES) {
        const amountMicro = (inflow.amountMicro / 1000) * (ROLE_SHARE_PER_1000[role] ?? 0)
        insertUnassignedAccrual.run(
          inflow.txid,
          'unassigned',
          '(unassigned)',
          '',
          role,
          'unassigned',
          amountMicro,
          createdAt,
        )
      }
    })
    writeAll()
    unmatchedLedgered += 1
  }

  return { inflowsChecked: inflows.length, unmatchedLedgered, skipped }
}

function resolveUsdcAssetId(network: string): string {
  const avm = proxyRequire('@x402-avm/avm') as {
    USDC_MAINNET_ASA_ID: string
    USDC_TESTNET_ASA_ID: string
  }
  return network === 'testnet' ? avm.USDC_TESTNET_ASA_ID : avm.USDC_MAINNET_ASA_ID
}

function printResult(result: ReconcileResult): void {
  console.log(`spm-reconcile: checked ${result.inflowsChecked} inflow(s)`)
  console.log(`  ledgered as unassigned: ${result.unmatchedLedgered}`)
  if (result.skipped.length > 0) {
    console.log(`  skipped: ${result.skipped.length}`)
    for (const s of result.skipped) {
      console.log(`    ${s.txid}\tamount_micro=${s.amountMicro}\treason=${s.reason}`)
    }
  }
}

async function main(): Promise<void> {
  const network = (process.env.NETWORK ?? 'mainnet').toLowerCase()
  const payTo = process.env.SPLIT_APP_ADDRESS ?? ''
  if (!payTo) {
    console.error('ERROR: SPLIT_APP_ADDRESS is not set — nothing to reconcile against')
    process.exitCode = 1
    return
  }

  const indexerUrl = process.env.INDEXER_URL ?? DEFAULT_INDEXER_URL
  const usdcAssetId = resolveUsdcAssetId(network)
  const dbPath = process.env.SQLITE_PATH ?? path.join(proxyRoot, 'audit.db')

  const BetterSqlite3 = proxyRequire('better-sqlite3') as new (
    filename: string,
  ) => BetterSqlite3Database
  const db = new BetterSqlite3(dbPath)

  try {
    const inflows = await listUsdcInflows(indexerUrl, usdcAssetId, payTo)
    const nowSeconds = Math.floor(Date.now() / 1000)
    printResult(reconcileOnce(db, inflows, nowSeconds))
  } finally {
    db.close()
  }
}

main().catch((err: unknown) => {
  console.error('spm-reconcile: failed —', err instanceof Error ? err.message : err)
  process.exitCode = 1
})
