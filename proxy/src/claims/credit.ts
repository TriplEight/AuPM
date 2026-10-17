// proxy/src/claims/credit.ts
//
// Nightly credit step. Counts every payment no batch counted yet, picks the
// payees whose matured balance is due, and calls PaymentRouter.credit() with
// the crediter key. credit() pays each payee from payTo itself. One batch is
// one group: one credit() call plus the refs() calls that make the payout
// holdings reachable. The on-chain calls live behind an injectable
// CreditChainClient — production code builds a real algosdk one
// (buildAlgodCreditClient), tests pass a stub, so no test in this
// directory performs a network call.
//
// WARNING: credit() is the only mutating on-chain call this module ever
// makes. It never submits a payment group directly — that is the
// facilitator's job, and only the facilitator's. This module never touches x402 settlement at all.

import algosdk from 'algosdk'
import {
  CUT_PER_1000,
  isPayoutDue,
  OPS_IDENTITY,
  OPS_PER_1000,
  type PayoutRules,
  payoutRulesFromEnv,
  TREASURY_IDENTITY,
} from './attribution-rules.js'
import {
  type BatchPlan,
  type CreditPayout,
  type CreditTotals,
  getLastBatchSeq,
  getPendingBatch,
  groupForCredit,
  isPoolShare,
  listBatchPayouts,
  listCreditCandidates,
  listPayeeBalances,
  listPayees,
  openBatch,
  type PayeeBalance,
  recordBatchCreditTxid,
  releaseBatch,
  touchPayeeOptInCheck,
  upsertPayee,
} from './ledger.js'
import type { AccrualRow, BatchRow, PayeeRow } from './schema.js'

/**
 * The exact `credit` method signature from
 * contracts/smart_contracts/artifacts/payment_router/PaymentRouter.arc56.json:
 * `credit(batchSeq, newTotal, unattributedTotal, treasuryExtra, payouts)`,
 * `payouts` an `(address, amount)[]`. The contract computes the ops and cut
 * shares of `newTotal` itself, so this code never passes them. The proxy
 * Docker image never copies the contracts workspace's build artifacts
 * (proxy/Dockerfile installs only the proxy project's own dependency
 * tree, and does not depend on @algorandfoundation/algokit-utils), so this
 * reproduces the signature as a constant rather than reading the ARC-56
 * JSON or the typed client at runtime. Keep this in sync by hand if the
 * contract's credit() signature ever changes — contracts/ is out of scope
 * for this module.
 */
export const CREDIT_METHOD_SIGNATURE = 'credit(uint64,uint64,uint64,uint64,(address,uint64)[])void'

/** refs() does nothing. It only carries references for the group. */
export const REFS_METHOD_SIGNATURE = 'refs()void'

/**
 * The most payouts one credit() call holds. The application arguments of one
 * call fill at most 2048 bytes. The selector takes 4, the four uint64
 * arguments take 4 x 8 and the array length takes 2. Each payout takes
 * 40 (an address and a uint64), so (2048 - 4 - 32 - 2) / 40 = 50.
 */
export const MAX_PAYOUTS_PER_GROUP = 50

// One group holds 16 transactions: credit() and up to 15 refs() calls.
const MAX_REFS_CALLS = 15

// Each refs() call names the USDC asset and up to 7 receiver accounts: one
// call may carry 8 foreign references.
const ACCOUNTS_PER_REFS_CALL = 7

/**
 * The note every credit() call carries: lets the recovery
 * path in `runCreditStep` find a confirmed credit() transaction by
 * `(appId, batchSeq)` through the indexer when the local batch row never
 * got its txid recorded.
 */
function creditNote(batchSeq: number): Uint8Array {
  return new TextEncoder().encode(`aupm:credit:${batchSeq}`)
}

/** Result of the opt-in check of a payout address. */
export type PayoutAddressStatus = 'ok' | 'not-opted-in' | 'frozen'

/**
 * Plans the next credit() batch. The batch counts every payment that no batch
 * counted yet (`counted`; its sum is `newTotal`). It credits every matured,
 * unfrozen `unallocated`, `slash` and `forfeit` share (`treasuryExtra`) and
 * the matured, unfrozen shares of the payees in `addresses` (`payouts`). A
 * payee is paid with its whole matured balance. Pure: no database or network
 * access.
 *
 * @param candidates - rows from `listCreditCandidates`, oldest payment first.
 * @param addresses - payout address of each payee identity that this batch pays.
 * @param now - the clock in ms; a share with `unlock_at` after it has not matured.
 */
export function planCreditBatch(
  candidates: AccrualRow[],
  addresses: Readonly<Record<string, string>>,
  now: number,
): BatchPlan {
  const counted = candidates.filter((row) => row.batch_seq === null)
  const paid = candidates.filter(
    (row) =>
      row.paid_seq === null &&
      isPoolShare(row) &&
      row.frozen === 0 &&
      row.unlock_at <= now &&
      (row.treasury_kind !== null || Object.hasOwn(addresses, row.identity)),
  )
  return { counted, paid, addresses }
}

/** A payee whose matured balance passes the payout rules. */
export interface DuePayee {
  identity: string
  address: string
  balanceMicro: number
}

/**
 * Picks the payees to pay tonight: those with a payout address whose matured,
 * unfrozen balance passes the payout rules. A payee that never got a payout
 * counts its onboarding time as the last payout. A balance without a payee
 * row is listed in `unmapped` and stays in the ledger. Pure.
 */
export function selectDuePayees(
  balances: PayeeBalance[],
  payees: PayeeRow[],
  now: number,
  rules: PayoutRules,
): { due: DuePayee[]; unmapped: string[] } {
  const byIdentity = new Map(payees.map((payee) => [payee.identity, payee]))
  const due: DuePayee[] = []
  const unmapped: string[] = []
  for (const { identity, balanceMicro } of balances) {
    const payee = byIdentity.get(identity)
    if (!payee) {
      unmapped.push(identity)
      continue
    }
    const lastPayoutAt = payee.last_payout_at ?? payee.onboarded_at
    if (isPayoutDue(balanceMicro, lastPayoutAt, now, rules)) {
      due.push({ identity, address: payee.payout_address, balanceMicro })
    }
  }
  return { due, unmapped }
}

/** Chain access the credit step needs, injectable for tests. */
export interface CreditChainClient {
  /** True when `payTo`'s algod `auth-addr` is the PaymentRouter app address
   * — the rekey that is required before the first credit(). */
  isPayToRekeyed(appId: bigint, payTo: string): Promise<boolean>
  /** Submits one credit() group; resolves to the confirmed credit() transaction id. */
  submitCredit(appId: bigint, batchSeq: number, totals: CreditTotals): Promise<string>
  /** The app's on-chain `lastBatchSeq` global (0 before the first credit()
   * call ever confirms). The next batch is this number plus 1, and a pending
   * batch that already confirmed on-chain (crash before `recordBatchCreditTxid`)
   * is never resent — the contract would reject it forever. */
  getOnChainLastBatchSeq(appId: bigint): Promise<number>
  /** Looks up the confirmed credit() transaction id for `batchSeq` by its
   * `aupm:credit:<batchSeq>` note (see `creditNote`). Null when the indexer
   * has no matching, confirmed application call from this app. */
  findCreditTxidByNote(appId: bigint, batchSeq: number): Promise<string | null>
  /** Checks that `address` holds a USDC opt-in and that the holding is not
   * frozen. credit() fails as a whole when one receiver fails this check. */
  checkPayoutAddress(address: string): Promise<PayoutAddressStatus>
}

/** Why the credit step declined to run tonight. */
export type CreditSkipReason = 'app-id-unset' | 'payto-not-rekeyed' | 'nothing-to-credit'

export type CreditOutcome =
  | { ran: false; reason: CreditSkipReason }
  | { ran: true; batchSeq: number; creditTxid: string }

/** What one credit step knows while it runs. */
interface StepContext {
  client: CreditChainClient
  appId: bigint
  /** Addresses that credit() refuses as a payout receiver: payTo and the app. */
  reserved: ReadonlySet<string>
  now: number
  log: (line: string) => void
}

/**
 * Asserts every payout has an amount above 0 and names neither `ops` nor
 * `treasury` — the same checks the contract makes. Defence in depth: a ledger
 * bug here must fail loudly before it ever reaches the chain, not surface
 * only as a rejected transaction.
 */
function assertPayoutsValid(payouts: CreditPayout[]): void {
  for (const payout of payouts) {
    const reserved = payout.identity === OPS_IDENTITY || payout.identity === TREASURY_IDENTITY
    if (payout.amountMicro <= 0 || reserved) {
      throw new Error(
        `runCreditStep: invalid payout (${payout.identity}, ${payout.amountMicro}): ` +
          'an amount must be above 0 and the identity must not be "ops" or "treasury"',
      )
    }
  }
}

/**
 * The arguments of one credit() call, in ABI order: `batchSeq`, `newTotal`,
 * `unattributedTotal`, `treasuryExtra`, `payouts`. The ops and cut shares are
 * not an argument: the contract computes them from `newTotal`.
 */
export function creditMethodArgs(
  batchSeq: number,
  totals: CreditTotals,
): [bigint, bigint, bigint, bigint, [string, bigint][]] {
  return [
    BigInt(batchSeq),
    BigInt(totals.newTotalMicro),
    BigInt(totals.unattributedMicro),
    BigInt(totals.treasuryExtraMicro),
    totals.payouts.map((p) => [p.address, BigInt(p.amountMicro)]),
  ]
}

/**
 * Checks one payout address and records the time of the check. Returns the
 * reason to leave the payee out of the batch, or null when the address is fine.
 */
async function payoutBlocker(ctx: StepContext, payout: CreditPayout): Promise<string | null> {
  if (ctx.reserved.has(payout.address)) return 'address is payTo or the app address'
  const status = await ctx.client.checkPayoutAddress(payout.address)
  touchPayeeOptInCheck(payout.identity, ctx.now)
  return status === 'ok' ? null : status
}

/**
 * Walks the due payees in order, checks each payout address and keeps the
 * ones that pass, up to MAX_PAYOUTS_PER_GROUP. A payee that fails the check is
 * left out and logged; its share stays in the ledger.
 */
async function admitPayees(ctx: StepContext, due: DuePayee[]): Promise<Record<string, string>> {
  const addresses: Record<string, string> = {}
  let admitted = 0
  for (const payee of due) {
    if (admitted >= MAX_PAYOUTS_PER_GROUP) break
    const payout = { identity: payee.identity, address: payee.address, amountMicro: 0 }
    const blocker = await payoutBlocker(ctx, payout)
    if (blocker) {
      ctx.log(
        `aupm-nightly: payout left out for ${payee.identity} (${payee.balanceMicro} micro-USDC ` +
          `stay in the ledger): ${blocker}`,
      )
      continue
    }
    addresses[payee.identity] = payee.address
    admitted += 1
  }
  return addresses
}

/** True when a payout of a pending batch can never confirm: credit() would fail whole. */
async function pendingBatchIsUnsendable(
  ctx: StepContext,
  payouts: CreditPayout[],
): Promise<boolean> {
  if (payouts.length > MAX_PAYOUTS_PER_GROUP) return true
  for (const payout of payouts) {
    const blocker = await payoutBlocker(ctx, payout)
    if (blocker) {
      ctx.log(`aupm-nightly: pending batch released, ${payout.identity}: ${blocker}`)
      return true
    }
  }
  return false
}

/** The amounts of a batch row, as `credit()` takes them, with its payouts. */
function pendingTotals(pending: BatchRow, payouts: CreditPayout[]): CreditTotals {
  return {
    newTotalMicro: pending.new_total_micro,
    unattributedMicro: pending.unattributed_micro,
    treasuryExtraMicro: pending.treasury_extra_micro,
    payouts,
  }
}

/**
 * Handles the pending batch of `ctx.appId`: a batch row with no credit txid.
 * Returns the outcome when it recovered or resent the batch, or null when it
 * released an unsendable batch and the caller must plan a new one.
 */
async function settlePendingBatch(
  ctx: StepContext,
  pending: BatchRow,
  onChainLastBatchSeq: number,
): Promise<CreditOutcome | null> {
  const { client, appId, now } = ctx
  const ledgerApp = Number(appId)
  if (onChainLastBatchSeq >= pending.batch_seq) {
    const creditTxid = await client.findCreditTxidByNote(appId, pending.batch_seq)
    if (!creditTxid) {
      throw new Error(
        `runCreditStep: batch ${pending.batch_seq} is already credited on-chain ` +
          `(app ${appId}'s lastBatchSeq is ${onChainLastBatchSeq}), but no local credit_txid ` +
          `is recorded and the indexer found no confirmed credit() transaction noted ` +
          `"aupm:credit:${pending.batch_seq}". Check the indexer is caught up and reachable; ` +
          'if it is, find the credit() transaction manually (by app id and note) and record ' +
          'its txid with recordBatchCreditTxid before the next nightly run.',
      )
    }
    recordBatchCreditTxid(ledgerApp, pending.batch_seq, creditTxid, now)
    return { ran: true, batchSeq: pending.batch_seq, creditTxid }
  }

  const payouts = listBatchPayouts(ledgerApp, pending.batch_seq)
  if (await pendingBatchIsUnsendable(ctx, payouts)) {
    // The chain has not credited this batch (checked above), and a receiver
    // that fails the check makes credit() fail whole, so no resend can
    // confirm. Release its rows and plan again without that payee.
    releaseBatch(ledgerApp, pending.batch_seq)
    return null
  }
  assertPayoutsValid(payouts)
  const creditTxid = await client.submitCredit(
    appId,
    pending.batch_seq,
    pendingTotals(pending, payouts),
  )
  recordBatchCreditTxid(ledgerApp, pending.batch_seq, creditTxid, now)
  return { ran: true, batchSeq: pending.batch_seq, creditTxid }
}

/**
 * The number of the next batch: the on-chain `lastBatchSeq` plus 1. Once no
 * batch is pending, the ledger and the chain must hold the same last batch.
 * A ledger ahead means a recorded txid that never confirmed. A chain ahead
 * means a confirmed batch that the ledger lost, and a new batch would pay its
 * payees again. In both states the operator must look first.
 */
function nextBatchSeq(ledgerApp: number, onChainLastBatchSeq: number): number {
  const ledgerLast = getLastBatchSeq(ledgerApp)
  if (ledgerLast !== onChainLastBatchSeq) {
    throw new Error(
      `runCreditStep: the ledger holds batch ${ledgerLast} for app ${ledgerApp}, but the app's ` +
        `lastBatchSeq is ${onChainLastBatchSeq}. Check the recorded credit txids before the ` +
        'next nightly run.',
    )
  }
  return onChainLastBatchSeq + 1
}

/**
 * Run the credit step. Reads `PAYMENT_ROUTER_APP_ID`
 * from `env`; a missing value stops here with `{ ran: false, reason:
 * 'app-id-unset' }` rather than throwing — an unconfigured PaymentRouter is
 * an expected pre-launch state, not a failure. `payTo` not yet rekeyed to
 * the app address stops the same way.
 *
 * One call opens one batch (see `planCreditBatch`). The payees to pay come
 * from the payout rules (`PAYOUT_MIN`, `PAYOUT_DUST`, `PAYOUT_FLOOR`) and the
 * opt-in check of each payout address. At most MAX_PAYOUTS_PER_GROUP payees
 * fit in one batch, so a larger backlog needs several calls: the first batch
 * carries `newTotal`, `unattributedTotal` and `treasuryExtra`; later batches
 * carry 0 of each. A share that has not matured at `now`, or that is frozen,
 * is never credited. A payee whose address fails the check stays in the ledger.
 *
 * A batch row that already exists with no credit_txid (a crash between
 * "assign rows to a batch" and "record the credit txid") is resent as-is,
 * from its own stored totals and payouts — unless the app's own on-chain
 * `lastBatchSeq` shows it already confirmed (a crash between "credit()
 * confirms" and "record the credit txid locally"): resending that batch
 * would make the contract reject it forever (`batchSeq must follow the
 * last credited batch`). This recovers the confirmed txid from the
 * `aupm:credit:<batchSeq>` note instead of resending, or stops with a
 * thrown error the operator must act on when the indexer has no match.
 * A pending batch that the chain has not credited and that names a payout
 * address that fails the check can never confirm: its rows are released and
 * planned again without that payee.
 */
export async function runCreditStep(
  client: CreditChainClient,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
  log: (line: string) => void = () => undefined,
): Promise<CreditOutcome> {
  const appIdRaw = env.PAYMENT_ROUTER_APP_ID
  if (!appIdRaw) return { ran: false, reason: 'app-id-unset' }
  const appId = BigInt(appIdRaw)
  const ledgerApp = Number(appId)

  const payTo = env.PAY_TO_ADDRESS ?? ''
  if (!payTo || !(await client.isPayToRekeyed(appId, payTo))) {
    return { ran: false, reason: 'payto-not-rekeyed' }
  }

  const reserved = new Set([payTo, algosdk.getApplicationAddress(appId).toString()])
  const ctx: StepContext = { client, appId, reserved, now, log }
  const onChainLastBatchSeq = await client.getOnChainLastBatchSeq(appId)

  const pending = getPendingBatch(ledgerApp)
  if (pending) {
    const outcome = await settlePendingBatch(ctx, pending, onChainLastBatchSeq)
    if (outcome) return outcome
  }

  const rules = payoutRulesFromEnv(env)
  const { due, unmapped } = selectDuePayees(listPayeeBalances(now), listPayees(), now, rules)
  for (const identity of unmapped) {
    log(`aupm-nightly: ${identity} has a matured balance but no payout address`)
  }
  const addresses = await admitPayees(ctx, due)
  const plan = planCreditBatch(listCreditCandidates(), addresses, now)
  if (plan.counted.length === 0 && plan.paid.length === 0) {
    return { ran: false, reason: 'nothing-to-credit' }
  }
  assertPayoutsValid(groupForCredit(plan).payouts)

  const batchSeq = nextBatchSeq(ledgerApp, onChainLastBatchSeq)
  const totals = openBatch(ledgerApp, batchSeq, plan)
  const creditTxid = await client.submitCredit(appId, batchSeq, totals)
  recordBatchCreditTxid(ledgerApp, batchSeq, creditTxid, now)
  return { ran: true, batchSeq, creditTxid }
}

/**
 * Adds a payee, or changes its payout address, after the same opt-in check
 * that the nightly job runs. Throws when the address is not valid, holds no
 * USDC opt-in or is frozen: such an address would make credit() fail whole.
 * `now` is the onboarding time of a new payee.
 */
export async function onboardPayee(
  client: Pick<CreditChainClient, 'checkPayoutAddress'>,
  identity: string,
  address: string,
  now: number = Date.now(),
): Promise<void> {
  if (!algosdk.isValidAddress(address)) {
    throw new Error(`onboardPayee: "${address}" is not an Algorand address`)
  }
  const status = await client.checkPayoutAddress(address)
  if (status !== 'ok') {
    throw new Error(
      `onboardPayee: ${address} cannot receive USDC (${status}). ` +
        'Opt the address in to USDC, or unfreeze it, then onboard it again.',
    )
  }
  upsertPayee(identity, address, now, now)
}

// The exact global-state keys of the PaymentRouter fields this module reads
// (contract.algo.ts): `lastBatchSeq` 'bsq', `opsAddress` 'ops',
// `treasuryAddress` 'trs'.
const LAST_BATCH_SEQ_GLOBAL_KEY = 'bsq'
const OPS_ADDRESS_GLOBAL_KEY = 'ops'
const TREASURY_ADDRESS_GLOBAL_KEY = 'trs'

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

type GlobalState = { key: Uint8Array; value: { bytes: Uint8Array; uint: bigint } }[]

function findGlobal(state: GlobalState, name: string): GlobalState[number]['value'] | undefined {
  const key = new TextEncoder().encode(name)
  return state.find((kv) => bytesEqual(kv.key, key))?.value
}

function globalAddress(state: GlobalState, name: string): string {
  const value = findGlobal(state, name)
  if (value?.bytes.length !== 32) {
    throw new Error(`PaymentRouter global state "${name}" is not set to an address`)
  }
  return new algosdk.Address(value.bytes).toString()
}

/** Floor of `newTotal * perThousand / 1000`, as the contract computes it. */
function shareOf(newTotalMicro: number, perThousand: number): bigint {
  return (BigInt(newTotalMicro) * BigInt(perThousand)) / 1000n
}

/**
 * How many inner USDC transfers credit() sends for `totals`: one per payout,
 * one for ops and one for treasury. The contract skips a transfer of 0.
 */
export function innerTransferCount(totals: CreditTotals): number {
  const ops = shareOf(totals.newTotalMicro, OPS_PER_1000)
  const treasury =
    shareOf(totals.newTotalMicro, CUT_PER_1000) +
    BigInt(totals.treasuryExtraMicro) +
    BigInt(totals.unattributedMicro)
  return totals.payouts.length + (ops > 0n ? 1 : 0) + (treasury > 0n ? 1 : 0)
}

/** Everything `buildCreditGroup` needs to build one credit() group. */
export interface CreditGroupParams {
  appId: bigint
  sender: string
  signer: algosdk.TransactionSigner
  suggestedParams: algosdk.SuggestedParams
  batchSeq: number
  totals: CreditTotals
  payTo: string
  opsAddress: string
  treasuryAddress: string
  assetId: bigint
}

/**
 * Builds the group of one batch: one credit() call and one refs() call per 7
 * receiver accounts, at most 15.
 *
 * credit() names payTo, ops, treasury and the USDC asset: its transfers read
 * those holdings. Each refs() call names the USDC asset and up to 7 receiver
 * accounts. A holding is reachable only when its account and its asset sit in
 * the same transaction, so every payout receiver shares a transaction with the
 * asset.
 *
 * Fees: the outer fee of credit() covers its own fee and the fee of every
 * inner transfer (fee pooling), so the inner transfers pay 0. Each refs() call
 * pays its own minimum fee.
 */
export function buildCreditGroup(params: CreditGroupParams): algosdk.AtomicTransactionComposer {
  const { totals, suggestedParams, assetId } = params
  const receivers = [...new Set(totals.payouts.map((p) => p.address))]
  const chunks: string[][] = []
  for (let i = 0; i < receivers.length; i += ACCOUNTS_PER_REFS_CALL) {
    chunks.push(receivers.slice(i, i + ACCOUNTS_PER_REFS_CALL))
  }
  if (chunks.length > MAX_REFS_CALLS) {
    throw new Error(
      `buildCreditGroup: ${receivers.length} receivers need ${chunks.length} refs() calls, ` +
        `over the limit of ${MAX_REFS_CALLS}; plan at most ${MAX_PAYOUTS_PER_GROUP} payouts per batch`,
    )
  }

  const creditFee = BigInt(suggestedParams.minFee) * BigInt(1 + innerTransferCount(totals))
  const atc = new algosdk.AtomicTransactionComposer()
  atc.addMethodCall({
    appID: params.appId,
    method: algosdk.ABIMethod.fromSignature(CREDIT_METHOD_SIGNATURE),
    methodArgs: creditMethodArgs(params.batchSeq, totals),
    sender: params.sender,
    suggestedParams: { ...suggestedParams, flatFee: true, fee: creditFee },
    signer: params.signer,
    note: creditNote(params.batchSeq),
    appAccounts: [params.payTo, params.opsAddress, params.treasuryAddress],
    appForeignAssets: [assetId],
  })
  const refs = algosdk.ABIMethod.fromSignature(REFS_METHOD_SIGNATURE)
  for (const accounts of chunks) {
    atc.addMethodCall({
      appID: params.appId,
      method: refs,
      sender: params.sender,
      suggestedParams,
      signer: params.signer,
      appAccounts: accounts,
      appForeignAssets: [assetId],
    })
  }
  return atc
}

function httpStatusOf(err: unknown): number | undefined {
  return (err as { response?: { status?: number } }).response?.status
}

/**
 * Builds the USDC opt-in check for a payout address over an algod client. It needs no signing key.
 * A missing asset holding, or a 404 from algod, means the address has not opted in.
 */
export function buildAlgodPayoutChecker(
  algod: algosdk.Algodv2,
  assetId: bigint,
): CreditChainClient['checkPayoutAddress'] {
  return async (address) => {
    try {
      const info = await algod.accountAssetInformation(address, assetId).do()
      if (!info.assetHolding) return 'not-opted-in'
      return info.assetHolding.isFrozen ? 'frozen' : 'ok'
    } catch (err) {
      if (httpStatusOf(err) === 404) return 'not-opted-in'
      throw err
    }
  }
}

/**
 * Build a real, injectable CreditChainClient over algosdk (see the
 * CREDIT_METHOD_SIGNATURE comment above for why not algokit-utils).
 * `algod` is a caller-built Algodv2 client; `indexer` is a caller-built
 * Indexer client, used only to recover a confirmed credit() txid the local
 * ledger never recorded (see `findCreditTxidByNote`). `crediterMnemonic`
 * signs the credit() call (CREDITER_MNEMONIC — never logged). `payTo` and
 * `assetId` are the resource references every credit() group needs
 * (`buildCreditGroup`).
 */
export function buildAlgodCreditClient(
  algod: algosdk.Algodv2,
  indexer: algosdk.Indexer,
  crediterMnemonic: string,
  payTo: string,
  assetId: bigint,
): CreditChainClient {
  const account = algosdk.mnemonicToSecretKey(crediterMnemonic)
  const signer = algosdk.makeBasicAccountTransactionSigner(account)

  return {
    async isPayToRekeyed(appId, checkedPayTo) {
      const info = await algod.accountInformation(checkedPayTo).do()
      const appAddress = algosdk.getApplicationAddress(appId)
      return info.authAddr?.equals(appAddress) ?? false
    },

    async getOnChainLastBatchSeq(appId) {
      const app = await algod.getApplicationByID(appId).do()
      const value = findGlobal(app.params.globalState ?? [], LAST_BATCH_SEQ_GLOBAL_KEY)
      return value ? Number(value.uint) : 0
    },

    checkPayoutAddress: buildAlgodPayoutChecker(algod, assetId),

    async findCreditTxidByNote(appId, batchSeq) {
      const note = creditNote(batchSeq)
      const page = await indexer
        .searchForTransactions()
        .applicationID(appId)
        .notePrefix(note)
        .limit(50)
        .do()
      // notePrefix is a byte-prefix match ("aupm:credit:1" also matches
      // "aupm:credit:10"), so re-check the exact note before trusting a hit.
      const match = page.transactions.find(
        (txn) => txn.applicationTransaction !== undefined && txn.note && bytesEqual(txn.note, note),
      )
      return match?.id ?? null
    },

    async submitCredit(appId, batchSeq, totals) {
      const app = await algod.getApplicationByID(appId).do()
      const state = app.params.globalState ?? []
      const atc = buildCreditGroup({
        appId,
        sender: account.addr.toString(),
        signer,
        suggestedParams: await algod.getTransactionParams().do(),
        batchSeq,
        totals,
        payTo,
        opsAddress: globalAddress(state, OPS_ADDRESS_GLOBAL_KEY),
        treasuryAddress: globalAddress(state, TREASURY_ADDRESS_GLOBAL_KEY),
        assetId,
      })
      const result = await atc.execute(algod, 4)
      const txid = result.txIDs[0]
      if (!txid) {
        throw new Error('submitCredit: credit() call confirmed with no transaction id')
      }
      return txid
    },
  }
}
