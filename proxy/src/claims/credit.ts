// proxy/src/claims/credit.ts
//
// Nightly credit step. Batches every
// still-uncredited accrual row and calls PaymentRouter.credit() with the
// crediter key. The on-chain call itself lives behind an injectable
// CreditChainClient — production code builds a real algosdk one
// (buildAlgodCreditClient), tests pass a stub, so no test in this
// directory performs a network call.
//
// WARNING: credit() is the only mutating on-chain call this module ever
// makes. It never submits a payment group directly — that is the
// facilitator's job, and only the facilitator's. This module never touches x402 settlement at all.

import algosdk from 'algosdk'
import { OPS_IDENTITY, TREASURY_IDENTITY } from './attribution-rules.js'
import {
  type BatchPlan,
  type CreditEntry,
  type CreditTotals,
  getLastBatchSeq,
  getPendingBatch,
  groupForCredit,
  isPoolShare,
  listCreditCandidates,
  openBatch,
  recordBatchCreditTxid,
  releaseBatch,
  summarizeBatch,
} from './ledger.js'
import type { AccrualRow, BatchRow } from './schema.js'

/**
 * The exact `credit` method signature from
 * contracts/smart_contracts/artifacts/payment_router/PaymentRouter.arc56.json:
 * `credit(batchSeq, newTotal, unattributedTotal, treasuryExtra, entries)`,
 * `entries` a `(repo, identity, amount)[]`. The contract computes the ops and
 * cut shares of `newTotal` itself, so this code never passes them. The proxy
 * Docker image never copies the contracts workspace's build artifacts
 * (proxy/Dockerfile installs only the proxy project's own dependency
 * tree, and does not depend on @algorandfoundation/algokit-utils), so this
 * reproduces the signature as a constant rather than reading the ARC-56
 * JSON or the typed client at runtime. Keep this in sync by hand if the
 * contract's credit() signature ever changes — contracts/ is out of scope
 * for this module.
 */
export const CREDIT_METHOD_SIGNATURE =
  'credit(uint64,uint64,uint64,uint64,(string,string,uint64)[])void'

/**
 * The note every credit() call carries: lets the recovery
 * path in `runCreditStep` find a confirmed credit() transaction by
 * `(appId, batchSeq)` through the indexer when the local batch row never
 * got its txid recorded.
 */
function creditNote(batchSeq: number): Uint8Array {
  return new TextEncoder().encode(`aupm:credit:${batchSeq}`)
}

// AVM app-call limit: accounts, assets, apps and boxes together must not
// exceed this many foreign references on one application-call transaction.
const MAX_TOTAL_REFERENCES = 8

/**
 * The most `(repo, identity)` entries one credit() call can hold. One app
 * call has an opcode budget of 700. credit() loops over `entries` twice, and
 * a simulate of the previous PaymentRouter (TestNet app 772851922,
 * 2026-09-29) measured its cost as 173 + 159 per entry: 3 entries cost 650,
 * 4 entries cost 809. The cost does not depend on string lengths (the loops
 * use constant-cost opcodes). The current credit() also writes the treasury
 * balance and checks running totals: re-measure this with a simulate of the
 * deployed contract before MainNet.
 */
export const MAX_CREDIT_ENTRIES = 3

/** The exact resource references one credit() call needs. */
export interface CreditCallRefs {
  boxes: { appIndex: number; name: Uint8Array }[]
  accounts: string[]
  assets: bigint[]
}

/**
 * Builds the resource references credit() needs (contract.algo.ts's
 * `credit()` body): one box per distinct identity it writes a balance to
 * (`bal:<identity>`, always including `bal:ops` and `bal:treasury`), one account reference for
 * `payTo` (its USDC holding is read via `asset.balance(payToAcct)`), and
 * one asset reference for the USDC ASA.
 *
 * Box key encoding: the literal utf8 bytes of the identity string after the
 * "bal:" prefix — never ARC-4 length-prefixed. Verified against
 * contracts/smart_contracts/artifacts/payment_router/PaymentRouter.approval.teal:
 * the credit() box-write path decodes each entry's ARC-4 string with
 * `extract_uint16` + `substring3` then strips the 2-byte length header with
 * `extract 2 0` *before* `bytec 7 // "bal:" ... concat` (see the lines
 * around `// balances = BoxMap<string, uint64>({ keyPrefix: 'bal:' })`).
 *
 * Pure and synchronous so it is independently testable: throws before any
 * network call when the batch needs more than MAX_TOTAL_REFERENCES total
 * references, rather than sending a call the AVM would reject and silently
 * losing track of which entries did not make it on-chain.
 */
export function buildCreditCallRefs(
  entries: CreditEntry[],
  payTo: string,
  assetId: bigint,
): CreditCallRefs {
  const identities = new Set<string>([
    OPS_IDENTITY,
    TREASURY_IDENTITY,
    ...entries.map((e) => e.identity),
  ])
  const boxes = [...identities].map((identity) => ({
    appIndex: 0,
    name: new TextEncoder().encode(`bal:${identity}`),
  }))
  const accounts = [payTo]
  const assets = [assetId]

  const total = boxes.length + accounts.length + assets.length
  if (total > MAX_TOTAL_REFERENCES) {
    const maxIdentityBoxes = MAX_TOTAL_REFERENCES - accounts.length - assets.length
    throw new Error(
      `buildCreditCallRefs: this batch needs ${total} foreign references ` +
        `(${boxes.length} identity box(es), ${accounts.length} account, ${assets.length} asset) — ` +
        `over the AVM's per-transaction limit of ${MAX_TOTAL_REFERENCES}. At most ${maxIdentityBoxes} ` +
        'distinct identities (including "ops" and "treasury") fit in one credit() call; split this batch into ' +
        'smaller ones before running the nightly job again.',
    )
  }
  return { boxes, accounts, assets }
}

// credit() references one payTo account and one asset; every other
// reference slot holds one `bal:<identity>` box, "ops" and "treasury"
// included. A batch of MAX_CREDIT_ENTRIES entries names at most that many
// payee identities plus those two, so the entry limit keeps every batch inside
// the box limit too. buildCreditCallRefs still checks the references before
// any network call.
const MAX_IDENTITY_BOXES = MAX_TOTAL_REFERENCES - 2
if (MAX_CREDIT_ENTRIES + 2 > MAX_IDENTITY_BOXES) {
  throw new Error(
    'credit.ts: MAX_CREDIT_ENTRIES plus "ops" and "treasury" must fit in MAX_IDENTITY_BOXES',
  )
}

/**
 * Plans the next credit() batch. The batch counts every payment that no batch
 * counted yet (`counted`; its sum is `newTotal`). It credits every matured,
 * unfrozen `unallocated`, `slash` and `forfeit` share (`treasuryExtra`) and
 * the matured, unfrozen payee shares of the first MAX_CREDIT_ENTRIES
 * `(repo, identity)` groups (`entries`). A group is never split between two
 * batches. The groups that do not fit wait for the next batch, which counts
 * nothing: the first batch carries `newTotal`, `unattributedTotal` and
 * `treasuryExtra`, and the later batches carry 0 of each. Pure: no database
 * or network access.
 *
 * @param candidates - rows from `listCreditCandidates`, oldest payment first.
 * @param now - the clock in ms; a share with `unlock_at` after it has not matured.
 */
export function planCreditBatch(candidates: AccrualRow[], now: number): BatchPlan {
  const counted = candidates.filter((row) => row.batch_seq === null)
  const matured = candidates.filter(
    (row) => row.paid_seq === null && isPoolShare(row) && row.frozen === 0 && row.unlock_at <= now,
  )
  const paid = matured.filter((row) => row.treasury_kind !== null)
  const groups = new Map<string, AccrualRow[]>()
  for (const row of matured) {
    if (row.treasury_kind !== null) continue
    const key = `${row.repo ?? ''}\u0000${row.identity}`
    const group = groups.get(key)
    if (group) group.push(row)
    else groups.set(key, [row])
  }
  for (const group of [...groups.values()].slice(0, MAX_CREDIT_ENTRIES)) paid.push(...group)
  return { counted, paid }
}

/** Chain access the credit step needs, injectable for tests. */
export interface CreditChainClient {
  /** True when `payTo`'s algod `auth-addr` is the PaymentRouter app address
   * — the rekey that is required before the first credit(). */
  isPayToRekeyed(appId: bigint, payTo: string): Promise<boolean>
  /** Submits one credit() call; resolves to the confirmed transaction id. */
  submitCredit(appId: bigint, batchSeq: number, totals: CreditTotals): Promise<string>
  /** The app's on-chain `lastBatchSeq` global (0 before the first credit()
   * call ever confirms). Read before resending a pending batch, so a batch
   * that already confirmed on-chain (crash before `recordBatchCreditTxid`)
   * is never resent — the contract would reject it forever. */
  getOnChainLastBatchSeq(appId: bigint): Promise<number>
  /** Looks up the confirmed credit() transaction id for `batchSeq` by its
   * `aupm:credit:<batchSeq>` note (see `creditNote`). Null when the indexer
   * has no matching, confirmed application call from this app. */
  findCreditTxidByNote(appId: bigint, batchSeq: number): Promise<string | null>
}

/** Why the credit step declined to run tonight. */
export type CreditSkipReason = 'app-id-unset' | 'payto-not-rekeyed' | 'nothing-to-credit'

export type CreditOutcome =
  | { ran: false; reason: CreditSkipReason }
  | { ran: true; batchSeq: number; creditTxid: string }

/**
 * Asserts every entry has an amount above 0 and names neither `ops` nor
 * `treasury` — the same checks the contract makes. Defence in depth: a ledger
 * bug here must fail loudly before it ever reaches the chain, not surface
 * only as a rejected transaction.
 */
function assertEntriesValid(entries: CreditEntry[]): void {
  for (const entry of entries) {
    const reserved = entry.identity === OPS_IDENTITY || entry.identity === TREASURY_IDENTITY
    if (entry.amountMicro <= 0 || reserved) {
      throw new Error(
        `runCreditStep: invalid entry (${entry.repo}, ${entry.identity}, ${entry.amountMicro}): ` +
          'an amount must be above 0 and the identity must not be "ops" or "treasury"',
      )
    }
  }
}

/**
 * The arguments of one credit() call, in ABI order: `batchSeq`, `newTotal`,
 * `unattributedTotal`, `treasuryExtra`, `entries`. The ops and cut shares are
 * not an argument: the contract computes them from `newTotal`.
 */
export function creditMethodArgs(
  batchSeq: number,
  totals: CreditTotals,
): [bigint, bigint, bigint, bigint, [string, string, bigint][]] {
  return [
    BigInt(batchSeq),
    BigInt(totals.newTotalMicro),
    BigInt(totals.unattributedMicro),
    BigInt(totals.treasuryExtraMicro),
    totals.entries.map((e) => [e.repo, e.identity, BigInt(e.amountMicro)]),
  ]
}

/** The amounts of a batch row, as `credit()` takes them, with its entries. */
function pendingTotals(pending: BatchRow, entries: CreditEntry[]): CreditTotals {
  return {
    newTotalMicro: pending.new_total_micro,
    unattributedMicro: pending.unattributed_micro,
    treasuryExtraMicro: pending.treasury_extra_micro,
    entries,
  }
}

/**
 * Handles the pending batch of `appId`: a batch row with no credit txid.
 * Returns the outcome when it recovered or resent the batch, or null when it
 * released an unsendable batch and the caller must plan a new one.
 */
async function settlePendingBatch(
  client: CreditChainClient,
  appId: bigint,
  pending: BatchRow,
): Promise<CreditOutcome | null> {
  const ledgerApp = Number(appId)
  const onChainLastBatchSeq = await client.getOnChainLastBatchSeq(appId)
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
    recordBatchCreditTxid(ledgerApp, pending.batch_seq, creditTxid)
    return { ran: true, batchSeq: pending.batch_seq, creditTxid }
  }

  const entries = summarizeBatch(ledgerApp, pending.batch_seq)
  if (entries.length > MAX_CREDIT_ENTRIES) {
    // The chain has not credited this batch (checked above), and a credit()
    // call with this many entries exceeds the opcode budget, so no earlier
    // attempt can ever confirm. Release its rows and plan within the limit.
    releaseBatch(ledgerApp, pending.batch_seq)
    return null
  }
  assertEntriesValid(entries)
  const creditTxid = await client.submitCredit(
    appId,
    pending.batch_seq,
    pendingTotals(pending, entries),
  )
  recordBatchCreditTxid(ledgerApp, pending.batch_seq, creditTxid)
  return { ran: true, batchSeq: pending.batch_seq, creditTxid }
}

/**
 * Run the credit step. Reads `PAYMENT_ROUTER_APP_ID`
 * from `env`; a missing value stops here with `{ ran: false, reason:
 * 'app-id-unset' }` rather than throwing — an unconfigured PaymentRouter is
 * an expected pre-launch state, not a failure. `payTo` not yet rekeyed to
 * the app address stops the same way.
 *
 * One call opens one batch (see `planCreditBatch`). The first batch after a
 * settlement carries `newTotal`, `unattributedTotal` and `treasuryExtra`; the
 * batches of a backlog that needs more entries carry 0 of each. A share
 * that has not matured at `now`, or that is frozen, is never credited.
 *
 * A batch row that already exists with no credit_txid (a crash between
 * "assign rows to a batch" and "record the credit txid") is resent as-is,
 * from its own stored totals and rows — unless the app's own on-chain
 * `lastBatchSeq` shows it already confirmed (a crash between "credit()
 * confirms" and "record the credit txid locally"): resending that batch
 * would make the contract reject it forever (`batchSeq must follow the
 * last credited batch`). This recovers the confirmed txid from the
 * `aupm:credit:<batchSeq>` note instead of resending, or stops with a
 * thrown error the operator must act on when the indexer has no match.
 * A pending batch that the chain has not credited and that holds more than
 * MAX_CREDIT_ENTRIES entries can never confirm (opcode budget): its rows
 * are released and planned again within the limit.
 */
export async function runCreditStep(
  client: CreditChainClient,
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): Promise<CreditOutcome> {
  const appIdRaw = env.PAYMENT_ROUTER_APP_ID
  if (!appIdRaw) return { ran: false, reason: 'app-id-unset' }
  const appId = BigInt(appIdRaw)
  const ledgerApp = Number(appId)

  const payTo = env.PAY_TO_ADDRESS ?? ''
  if (!payTo || !(await client.isPayToRekeyed(appId, payTo))) {
    return { ran: false, reason: 'payto-not-rekeyed' }
  }

  const pending = getPendingBatch(ledgerApp)
  if (pending) {
    const outcome = await settlePendingBatch(client, appId, pending)
    if (outcome) return outcome
  }

  const plan = planCreditBatch(listCreditCandidates(), now)
  if (plan.counted.length === 0 && plan.paid.length === 0) {
    return { ran: false, reason: 'nothing-to-credit' }
  }
  assertEntriesValid(groupForCredit(plan).entries)

  const batchSeq = getLastBatchSeq(ledgerApp) + 1
  const totals = openBatch(ledgerApp, batchSeq, plan)
  const creditTxid = await client.submitCredit(appId, batchSeq, totals)
  recordBatchCreditTxid(ledgerApp, batchSeq, creditTxid)
  return { ran: true, batchSeq, creditTxid }
}

// The exact global-state key of `lastBatchSeq` (contract.algo.ts:
// `lastBatchSeq = GlobalState<uint64>({ key: 'bsq' })`), confirmed against
// PaymentRouter.approval.teal's `bytec_3 // "bsq"` before every
// `app_global_get_ex` on that field.
const LAST_BATCH_SEQ_GLOBAL_KEY = new TextEncoder().encode('bsq')

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i])
}

/**
 * Build a real, injectable CreditChainClient over algosdk (see the
 * CREDIT_METHOD_SIGNATURE comment above for why not algokit-utils).
 * `algod` is a caller-built Algodv2 client; `indexer` is a caller-built
 * Indexer client, used only to recover a confirmed credit() txid the local
 * ledger never recorded (see `findCreditTxidByNote`). `crediterMnemonic`
 * signs the credit() call (CREDITER_MNEMONIC — never logged). `payTo` and
 * `assetId` are the resource references every credit() call needs
 * (`buildCreditCallRefs`).
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
  const method = algosdk.ABIMethod.fromSignature(CREDIT_METHOD_SIGNATURE)

  return {
    async isPayToRekeyed(appId, checkedPayTo) {
      const info = await algod.accountInformation(checkedPayTo).do()
      const appAddress = algosdk.getApplicationAddress(appId)
      return info.authAddr?.equals(appAddress) ?? false
    },

    async getOnChainLastBatchSeq(appId) {
      const app = await algod.getApplicationByID(appId).do()
      const entry = (app.params.globalState ?? []).find((kv) =>
        bytesEqual(kv.key, LAST_BATCH_SEQ_GLOBAL_KEY),
      )
      return entry ? Number(entry.value.uint) : 0
    },

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
      const refs = buildCreditCallRefs(totals.entries, payTo, assetId)
      const suggestedParams = await algod.getTransactionParams().do()
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addMethodCall({
        appID: appId,
        method,
        methodArgs: creditMethodArgs(batchSeq, totals),
        sender: account.addr,
        suggestedParams,
        signer,
        note: creditNote(batchSeq),
        appAccounts: refs.accounts,
        appForeignAssets: refs.assets,
        boxes: refs.boxes,
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
