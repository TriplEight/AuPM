// proxy/src/claims/ledger-check.ts
//
// Compares the ledger with the PaymentRouter app globals and the USDC balance
// of payTo. The nightly job runs it after the credit step. The comparison is
// pure; the reader and the algod chain reader sit around it.
//
// Globals: `pin` and `pot` are the pool part in and out, `dct` is the total the
// batches declared, `pdt` is the total credit() sent. The first two start at
// the carry-in, which the ledger does not store. So the check compares
// `dct - declared` with `pin - pool`: both must equal the carry-in.

import type algosdk from 'algosdk'
import { CUT_PER_1000, OPS_PER_1000 } from './attribution-rules.js'
import { findGlobal, shareOf } from './credit.js'
import db from './schema.js'

/** The app globals that the ledger must match, and the payTo USDC balance. */
export interface RouterTotals {
  pin: bigint
  pot: bigint
  dct: bigint
  pdt: bigint
  payToBalance: bigint
}

/** Reads the chain side of the check. Tests pass a fake. */
export interface RouterChainReader {
  readRouterTotals(appId: bigint, payTo: string): Promise<RouterTotals>
}

/** One credited batch of the ledger, with its payouts summed. */
export interface LedgerBatch {
  newTotalMicro: number
  unattributedMicro: number
  treasuryExtraMicro: number
  payoutsMicro: number
}

export interface LedgerCheckResult {
  /** One text per global that differs, with the chain value and the ledger value. */
  mismatches: string[]
  /** Micro-USDC that the ledger expects but payTo does not hold; 0 when none. */
  excessMicro: bigint
  /** Micro-USDC on payTo that the ledger does not expect. Normal; only logged. */
  gapMicro: bigint
}

/** Micro-USDC that credit() sends for one batch, as the contract computes it. */
export function batchTotalOf(batch: LedgerBatch): bigint {
  const ops = shareOf(batch.newTotalMicro, OPS_PER_1000)
  const cut = shareOf(batch.newTotalMicro, CUT_PER_1000)
  return (
    ops +
    cut +
    BigInt(batch.treasuryExtraMicro) +
    BigInt(batch.unattributedMicro) +
    BigInt(batch.payoutsMicro)
  )
}

function poolPartOf(batch: LedgerBatch): bigint {
  const ops = shareOf(batch.newTotalMicro, OPS_PER_1000)
  const cut = shareOf(batch.newTotalMicro, CUT_PER_1000)
  return BigInt(batch.newTotalMicro) - ops - cut
}

function sum(values: bigint[]): bigint {
  return values.reduce((a, b) => a + b, 0n)
}

/**
 * Compares the credited batches and the uncounted payments of the ledger with
 * the chain. `unbatchedMicro` is the sum of the accruals that no batch counted.
 * Pure.
 */
export function compareLedger(
  batches: LedgerBatch[],
  unbatchedMicro: number,
  chain: RouterTotals,
): LedgerCheckResult {
  const mismatches: string[] = []
  const expectPot = sum(batches.map((b) => BigInt(b.payoutsMicro + b.treasuryExtraMicro)))
  const expectPdt = sum(batches.map(batchTotalOf))
  const declared = sum(batches.map((b) => BigInt(b.newTotalMicro + b.unattributedMicro)))
  const pool = sum(batches.map(poolPartOf))
  const carryByDct = chain.dct - declared
  const carryByPin = chain.pin - pool

  if (chain.pot !== expectPot) mismatches.push(`pot chain=${chain.pot} ledger=${expectPot}`)
  if (chain.pdt !== expectPdt) mismatches.push(`pdt chain=${chain.pdt} ledger=${expectPdt}`)
  if (carryByDct !== carryByPin) {
    mismatches.push(`carry-in by dct=${carryByDct} by pin=${carryByPin}`)
  }

  const chainUndeclared = chain.payToBalance - (chain.dct - chain.pdt)
  const ledgerUnbatched = BigInt(unbatchedMicro)
  const excessMicro = ledgerUnbatched > chainUndeclared ? ledgerUnbatched - chainUndeclared : 0n
  const gapMicro = chainUndeclared > ledgerUnbatched ? chainUndeclared - ledgerUnbatched : 0n
  return { mismatches, excessMicro, gapMicro }
}

const listCreditedBatches = db.prepare<
  [number],
  {
    new_total_micro: number
    unattributed_micro: number
    treasury_extra_micro: number
    payouts_micro: number
  }
>(
  `SELECT b.new_total_micro, b.unattributed_micro, b.treasury_extra_micro,
          (SELECT COALESCE(SUM(p.amount_micro), 0) FROM batch_payouts p
            WHERE p.app_id = b.app_id AND p.batch_seq = b.batch_seq) AS payouts_micro
   FROM batches b WHERE b.app_id = ? AND b.credit_txid IS NOT NULL`,
)

const sumUnbatched = db.prepare<[], { total: number | null }>(
  'SELECT SUM(amount_micro) AS total FROM accruals WHERE batch_seq IS NULL',
)

/** Reads the credited batches of `appId` and the accruals that no batch counted yet. */
export function readLedgerSide(appId: number): { batches: LedgerBatch[]; unbatchedMicro: number } {
  const batches = listCreditedBatches.all(appId).map((row) => ({
    newTotalMicro: row.new_total_micro,
    unattributedMicro: row.unattributed_micro,
    treasuryExtraMicro: row.treasury_extra_micro,
    payoutsMicro: row.payouts_micro,
  }))
  return { batches, unbatchedMicro: sumUnbatched.get()?.total ?? 0 }
}

// The exact global-state keys of the PaymentRouter totals (contract.algo.ts):
// `poolIn` 'pin', `poolOut` 'pot', `declaredTotal` 'dct', `paidTotal` 'pdt'.
const TOTAL_KEYS = ['pin', 'pot', 'dct', 'pdt'] as const

/** Builds a RouterChainReader over an algod client. */
export function buildAlgodRouterReader(algod: algosdk.Algodv2, assetId: bigint): RouterChainReader {
  return {
    async readRouterTotals(appId, payTo) {
      const app = await algod.getApplicationByID(appId).do()
      const state = app.params.globalState ?? []
      const [pin, pot, dct, pdt] = TOTAL_KEYS.map((name) => {
        const value = findGlobal(state, name)
        if (!value) throw new Error(`PaymentRouter global state "${name}" is not set`)
        return value.uint
      }) as [bigint, bigint, bigint, bigint]
      const holding = await algod.accountAssetInformation(payTo, assetId).do()
      return { pin, pot, dct, pdt, payToBalance: holding.assetHolding?.amount ?? 0n }
    },
  }
}
