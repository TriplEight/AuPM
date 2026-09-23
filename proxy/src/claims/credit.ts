// proxy/src/claims/credit.ts
//
// Nightly credit step (SPEC.md §13.2 step 3, ADR 0005). Batches every
// still-uncredited accrual row and calls PaymentRouter.credit() with the
// crediter key. The on-chain call itself lives behind an injectable
// CreditChainClient — production code builds a real algosdk one
// (buildAlgodCreditClient), tests pass a stub, so no test in this
// directory performs a network call.
//
// WARNING: credit() is the only mutating on-chain call this module ever
// makes. It never submits a payment group directly — that is the
// facilitator's job, and only the facilitator's (see SPEC.md, CLAUDE.md
// invariant 6). This module never touches x402 settlement at all.

import algosdk from 'algosdk'
import {
  assignUncreditedToBatch,
  type CreditEntry,
  getLastBatchSeq,
  getPendingBatch,
  insertPendingBatch,
  recordBatchCreditTxid,
  summarizeBatch,
  summarizeUncredited,
} from './ledger.js'

/**
 * The exact `credit` method signature from
 * contracts/smart_contracts/artifacts/payment_router/PaymentRouter.arc56.json
 * (ADR 0005): `credit(batchSeq, attributedTotal, unattributedTotal,
 * entries)`, `entries` a `(repo, identity, amount)[]`. The proxy Docker
 * image never copies the contracts workspace's build artifacts
 * (proxy/Dockerfile installs only the proxy project's own dependency
 * tree, and does not depend on @algorandfoundation/algokit-utils), so this
 * reproduces the signature as a constant rather than reading the ARC-56
 * JSON or the typed client at runtime. Keep this in sync by hand if the
 * contract's credit() signature ever changes — contracts/ is out of scope
 * for this module.
 */
const CREDIT_METHOD_SIGNATURE = 'credit(uint64,uint64,uint64,(string,string,uint64)[])void'

/**
 * Fixed identity for the ops pool
 * (contracts/smart_contracts/payment_router/contract.algo.ts,
 * `OPS_IDENTITY`). Kept as a literal copy, not an import: credit.ts must not
 * depend on contracts/ (out of scope here, and the proxy Docker image never
 * installs that workspace's dependency tree — see the comment above
 * CREDIT_METHOD_SIGNATURE). Keep this in sync by hand if the contract's
 * OPS_IDENTITY ever changes.
 */
const OPS_IDENTITY = 'ops'

/**
 * The note every credit() call carries (SPEC.md §13.2): lets the recovery
 * path in `runCreditStep` find a confirmed credit() transaction by
 * `(appId, batchSeq)` through the indexer when the local batch row never
 * got its txid recorded.
 */
function creditNote(batchSeq: number): Uint8Array {
  return new TextEncoder().encode(`spm:credit:${batchSeq}`)
}

// AVM app-call limit: accounts, assets, apps and boxes together must not
// exceed this many foreign references on one application-call transaction.
const MAX_TOTAL_REFERENCES = 8

/** The exact resource references one credit() call needs. */
export interface CreditCallRefs {
  boxes: { appIndex: number; name: Uint8Array }[]
  accounts: string[]
  assets: bigint[]
}

/**
 * Builds the resource references credit() needs (contract.algo.ts's
 * `credit()` body): one box per distinct identity it writes a balance to
 * (`bal:<identity>`, always including `bal:ops`), one account reference for
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
  const identities = new Set<string>([OPS_IDENTITY, ...entries.map((e) => e.identity)])
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
        'distinct identities (including "ops") fit in one credit() call; split this batch into ' +
        'smaller ones before running the nightly job again.',
    )
  }
  return { boxes, accounts, assets }
}

/** Chain access the credit step needs, injectable for tests. */
export interface CreditChainClient {
  /** True when `payTo`'s algod `auth-addr` is the PaymentRouter app address
   * — the rekey SPEC.md §10.2 requires before the first credit(). */
  isPayToRekeyed(appId: bigint, payTo: string): Promise<boolean>
  /** Submits one credit() call; resolves to the confirmed transaction id. */
  submitCredit(
    appId: bigint,
    batchSeq: number,
    attributedMicro: number,
    unattributedMicro: number,
    entries: CreditEntry[],
  ): Promise<string>
  /** The app's on-chain `lastBatchSeq` global (0 before the first credit()
   * call ever confirms). Read before resending a pending batch, so a batch
   * that already confirmed on-chain (crash before `recordBatchCreditTxid`)
   * is never resent — the contract would reject it forever. */
  getOnChainLastBatchSeq(appId: bigint): Promise<number>
  /** Looks up the confirmed credit() transaction id for `batchSeq` by its
   * `spm:credit:<batchSeq>` note (see `creditNote`). Null when the indexer
   * has no matching, confirmed application call from this app. */
  findCreditTxidByNote(appId: bigint, batchSeq: number): Promise<string | null>
}

/** Why the credit step declined to run tonight. */
export type CreditSkipReason = 'app-id-unset' | 'payto-not-rekeyed' | 'nothing-to-credit'

export type CreditOutcome =
  | { ran: false; reason: CreditSkipReason }
  | { ran: true; batchSeq: number; creditTxid: string }

/**
 * Asserts `entries` sum to exactly `attributedMicro * 400 / 1000` — the
 * same check the contract itself makes (ADR 0005). Defence in depth: a
 * ledger bug here must fail loudly before it ever reaches the chain, not
 * surface only as a rejected transaction.
 */
function assertEntriesMatchAuditorShare(attributedMicro: number, entries: CreditEntry[]): void {
  const entriesTotal = entries.reduce((sum, e) => sum + e.amountMicro, 0)
  const auditorShare = (attributedMicro * 400) / 1000
  if (entriesTotal !== auditorShare) {
    throw new Error(
      `runCreditStep: entries sum to ${entriesTotal}, expected attributedMicro x 400 / 1000 ` +
        `= ${auditorShare} (attributedMicro=${attributedMicro})`,
    )
  }
}

/**
 * Run the credit step (SPEC.md §13.2 step 3). Reads `PAYMENT_ROUTER_APP_ID`
 * from `env`; a missing value stops here with `{ ran: false, reason:
 * 'app-id-unset' }` rather than throwing — an unconfigured PaymentRouter is
 * an expected pre-launch state, not a failure. `payTo` not yet rekeyed to
 * the app address stops the same way.
 *
 * A batch row that already exists with no credit_txid (a crash between
 * "assign rows to a batch" and "record the credit txid") is resent as-is,
 * from its own stored totals and rows — unless the app's own on-chain
 * `lastBatchSeq` shows it already confirmed (a crash between "credit()
 * confirms" and "record the credit txid locally"): resending that batch
 * would make the contract reject it forever (`batchSeq must follow the
 * last credited batch`). This recovers the confirmed txid from the
 * `spm:credit:<batchSeq>` note instead of resending, or stops with a
 * thrown error the operator must act on when the indexer has no match.
 */
export async function runCreditStep(
  client: CreditChainClient,
  env: NodeJS.ProcessEnv = process.env,
): Promise<CreditOutcome> {
  const appIdRaw = env.PAYMENT_ROUTER_APP_ID
  if (!appIdRaw) return { ran: false, reason: 'app-id-unset' }
  const appId = BigInt(appIdRaw)

  const payTo = env.PAY_TO_ADDRESS ?? ''
  if (!payTo || !(await client.isPayToRekeyed(appId, payTo))) {
    return { ran: false, reason: 'payto-not-rekeyed' }
  }

  const pending = getPendingBatch()
  if (pending) {
    const onChainLastBatchSeq = await client.getOnChainLastBatchSeq(appId)
    if (onChainLastBatchSeq >= pending.batch_seq) {
      const creditTxid = await client.findCreditTxidByNote(appId, pending.batch_seq)
      if (!creditTxid) {
        throw new Error(
          `runCreditStep: batch ${pending.batch_seq} is already credited on-chain ` +
            `(app ${appId}'s lastBatchSeq is ${onChainLastBatchSeq}), but no local credit_txid ` +
            `is recorded and the indexer found no confirmed credit() transaction noted ` +
            `"spm:credit:${pending.batch_seq}". Check the indexer is caught up and reachable; ` +
            'if it is, find the credit() transaction manually (by app id and note) and record ' +
            'its txid with recordBatchCreditTxid before the next nightly run.',
        )
      }
      recordBatchCreditTxid(pending.batch_seq, creditTxid)
      return { ran: true, batchSeq: pending.batch_seq, creditTxid }
    }

    const { entries } = summarizeBatch(pending.batch_seq)
    assertEntriesMatchAuditorShare(pending.attributed_micro, entries)
    const creditTxid = await client.submitCredit(
      appId,
      pending.batch_seq,
      pending.attributed_micro,
      pending.unattributed_micro,
      entries,
    )
    recordBatchCreditTxid(pending.batch_seq, creditTxid)
    return { ran: true, batchSeq: pending.batch_seq, creditTxid }
  }

  const totals = summarizeUncredited()
  if (totals.attributedMicro === 0 && totals.unattributedMicro === 0) {
    return { ran: false, reason: 'nothing-to-credit' }
  }
  assertEntriesMatchAuditorShare(totals.attributedMicro, totals.entries)

  const batchSeq = getLastBatchSeq() + 1
  insertPendingBatch(batchSeq, totals.attributedMicro, totals.unattributedMicro)
  assignUncreditedToBatch(batchSeq)

  const creditTxid = await client.submitCredit(
    appId,
    batchSeq,
    totals.attributedMicro,
    totals.unattributedMicro,
    totals.entries,
  )
  recordBatchCreditTxid(batchSeq, creditTxid)
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
      // notePrefix is a byte-prefix match ("spm:credit:1" also matches
      // "spm:credit:10"), so re-check the exact note before trusting a hit.
      const match = page.transactions.find(
        (txn) => txn.applicationTransaction !== undefined && txn.note && bytesEqual(txn.note, note),
      )
      return match?.id ?? null
    },

    async submitCredit(appId, batchSeq, attributedMicro, unattributedMicro, entries) {
      const refs = buildCreditCallRefs(entries, payTo, assetId)
      const suggestedParams = await algod.getTransactionParams().do()
      const atc = new algosdk.AtomicTransactionComposer()
      atc.addMethodCall({
        appID: appId,
        method,
        methodArgs: [
          BigInt(batchSeq),
          BigInt(attributedMicro),
          BigInt(unattributedMicro),
          entries.map((e) => [e.repo, e.identity, BigInt(e.amountMicro)]),
        ],
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
