import {
  Account,
  Asset,
  assert,
  BoxMap,
  type bytes,
  Contract,
  Global,
  GlobalState,
  itxn,
  Txn,
  Uint64,
  type uint64,
} from '@algorandfoundation/algorand-typescript'

// Off-the-top shares of newTotal, per 1,000 micro-units. The contract
// computes both and rounds down. The rest of newTotal goes to the pool part.
const OPS_SHARE_NUM = Uint64(50)
const TREASURY_CUT_NUM = Uint64(200)
const SPLIT_DEN = Uint64(1000)

// A claim below this floor costs more in fees than it pays out.
const MIN_CLAIM = Uint64(100_000)

// The outer fee of claim() must be at least this many minimum fees. The inner
// axfer fee is 0, so the claimant pools one minimum fee through the outer fee.
const CLAIM_MIN_FEE_MULTIPLE = Uint64(2)

// Fixed identity for the ops balance. The admin maps it to an address the
// same way it maps any other identity. An entry never names it.
const OPS_IDENTITY = 'ops'

// Fixed identity for the treasury balance. An entry never names it.
const TREASURY_IDENTITY = 'treasury'

// Delay, in rounds, between an announcement and its use: announceRelease()
// to executeRelease(), and setIdentity() on a mapped identity to
// applyIdentity(). About 7 days at ~2.9s/round. Compiled in: a new value
// needs a new contract.
const RELEASE_DELAY_ROUNDS = Uint64(216_000)

// Rounds after the delay during which the announced action may run. About 7
// days. After that the announcement expires and the admin must announce
// again, which restarts the delay.
const RELEASE_WINDOW_ROUNDS = Uint64(216_000)

// repo travels with each entry for shape parity with the off-chain ledger, but the
// contract never stores it. The per-repo breakdown lives in the off-chain
// ledger; on-chain, a balance is per identity only.
type CreditEntry = {
  repo: string
  identity: string
  amount: uint64
}

export class PaymentRouter extends Contract {
  // payTo is a plain account. It accrues USDC before this app exists, then
  // is rekeyed to this app. It never changes after creation.
  payTo = GlobalState<bytes>({ key: 'pto' })
  assetId = GlobalState<uint64>({ key: 'ast' })

  // Crediter key: the only sender credit() accepts.
  crediter = GlobalState<bytes>({ key: 'crd' })

  // Last batch number credit() accepted. Unset before the first batch, so
  // batch 1 is the first valid call.
  lastBatchSeq = GlobalState<uint64>({ key: 'bsq' })

  // Running total of credited, unclaimed balances. The unallocated balance
  // of payTo is its USDC balance minus this total.
  creditedUnclaimed = GlobalState<uint64>({ key: 'cru' })

  // Running totals, in micro-units. poolIn starts at carryIn and grows by the
  // pool part of each batch. poolOut grows by the pool payee credits and the
  // pool money sent to treasury. declaredTotal starts at carryIn and grows by
  // the USDC each batch declares as arrived. claimedTotal grows by each claim
  // payout. credit() keeps poolOut <= poolIn and
  // declaredTotal <= payTo USDC balance + claimedTotal.
  poolIn = GlobalState<uint64>({ key: 'pin' })
  poolOut = GlobalState<uint64>({ key: 'pot' })
  declaredTotal = GlobalState<uint64>({ key: 'dct' })
  claimedTotal = GlobalState<uint64>({ key: 'clt' })

  // identity ("github:<login>", "ops" or "treasury") -> claimant address,
  // admin-set.
  identityAddress = BoxMap<string, bytes>({ keyPrefix: 'id:' })

  // identity -> announced new address and the round of the announcement. Both
  // boxes exist together, only for an identity that already has an address.
  pendingAddress = BoxMap<string, bytes>({ keyPrefix: 'pa:' })
  pendingRound = BoxMap<string, uint64>({ keyPrefix: 'pr:' })

  // identity -> credited, unclaimed balance owed to that identity. A new
  // box needs minimum balance on this app's own account, not on payTo.
  // The deploy step must fund the app account before the first credit().
  balances = BoxMap<string, uint64>({ keyPrefix: 'bal:' })

  // Migration state. announcedTo/announcedRound are set together
  // by announceRelease() and read by executeRelease(). retired is set once,
  // by executeRelease(), and gates credit()/claim() from then on.
  announcedTo = GlobalState<bytes>({ key: 'ato' })
  announcedRound = GlobalState<uint64>({ key: 'arn' })
  retired = GlobalState<boolean>({ key: 'ret' })

  // Runs once, at creation. payTo and the USDC asset id are fixed here and
  // never change afterwards. carryIn is the USDC at payTo that an earlier
  // app did not pay out. It starts as both pool money and declared money.
  public createApplication(payTo: Account, usdcAsset: Asset, carryIn: uint64): void {
    this.payTo.value = payTo.bytes
    this.assetId.value = usdcAsset.id
    this.poolIn.value = carryIn
    this.poolOut.value = Uint64(0)
    this.declaredTotal.value = carryIn
    this.claimedTotal.value = Uint64(0)
  }

  // Admin-only. Authorises the hot key that can call credit().
  public setCrediter(addr: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.crediter.value = addr.bytes
  }

  // Admin-only. An identity with no address and no balance gets this address
  // at once. An identity with an address, or with a balance, is not mapped
  // yet: the new address is only announced, and applyIdentity() maps it after
  // RELEASE_DELAY_ROUNDS. A new call
  // replaces the announced address and restarts the delay.
  public setIdentity(identity: string, addr: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    const hasBalance: boolean = this.balances(identity).exists
      ? this.balances(identity).value > Uint64(0)
      : false
    if (!this.identityAddress(identity).exists && !hasBalance) {
      this.identityAddress(identity).value = addr.bytes
      return
    }
    this.pendingAddress(identity).value = addr.bytes
    this.pendingRound(identity).value = Global.round
  }

  // Anybody can call it. Maps the announced address of an identity once
  // RELEASE_DELAY_ROUNDS have passed and before RELEASE_WINDOW_ROUNDS have
  // passed after that. Claims go to the current address until this call.
  // Fails once the app is retired.
  public applyIdentity(identity: string): void {
    const isRetired: boolean = this.retired.hasValue ? this.retired.value : false
    assert(!isRetired, 'app is retired')
    assert(this.pendingAddress(identity).exists, 'no pending address')
    const applicableFrom: uint64 = this.pendingRound(identity).value + RELEASE_DELAY_ROUNDS
    assert(Global.round >= applicableFrom, 'identity delay has not passed')
    assert(
      Global.round < applicableFrom + RELEASE_WINDOW_ROUNDS,
      'identity window has expired; announce again',
    )
    this.identityAddress(identity).value = this.pendingAddress(identity).value
    this.pendingAddress(identity).delete()
    this.pendingRound(identity).delete()
  }

  // Crediter-only. Credits one numbered batch. The contract computes ops and
  // the treasury cut from newTotal and rounds down. entries are pool payee
  // credits, one per (repo, identity). treasuryExtra and unattributedTotal go
  // to treasury. Never split per payment.
  public credit(
    batchSeq: uint64,
    newTotal: uint64,
    unattributedTotal: uint64,
    treasuryExtra: uint64,
    entries: CreditEntry[],
  ): void {
    const isRetired: boolean = this.retired.hasValue ? this.retired.value : false
    assert(!isRetired, 'app is retired')
    assert(Txn.sender.bytes === this.crediter.value, 'not crediter')

    const last: uint64 = this.lastBatchSeq.hasValue ? this.lastBatchSeq.value : Uint64(0)
    assert(batchSeq === last + Uint64(1), 'batchSeq must follow the last credited batch')

    let entriesTotal: uint64 = Uint64(0)
    for (let i: uint64 = Uint64(0); i < entries.length; i = i + Uint64(1)) {
      assert(entries[i].amount > Uint64(0), 'entry amount must be above 0')
      assert(
        entries[i].identity !== OPS_IDENTITY && entries[i].identity !== TREASURY_IDENTITY,
        'entry must not name ops or treasury',
      )
      entriesTotal = entriesTotal + entries[i].amount
    }

    const opsAmount: uint64 = (newTotal * OPS_SHARE_NUM) / SPLIT_DEN
    const cutAmount: uint64 = (newTotal * TREASURY_CUT_NUM) / SPLIT_DEN
    const treasuryAmount: uint64 = cutAmount + treasuryExtra + unattributedTotal

    const held: uint64 = Asset(this.assetId.value).balance(Account(this.payTo.value))
    this.checkAndAdvanceTotals(
      newTotal - opsAmount - cutAmount,
      entriesTotal + treasuryExtra,
      newTotal + unattributedTotal,
      held,
    )

    const alreadyCredited: uint64 = this.creditedUnclaimed.hasValue
      ? this.creditedUnclaimed.value
      : Uint64(0)
    const batchTotal: uint64 = opsAmount + treasuryAmount + entriesTotal
    assert(batchTotal + alreadyCredited <= held, 'batch total exceeds the unallocated balance')

    // Credit each identity directly. No identity mapping is required here,
    // so an unmapped identity never stalls a batch: it still accrues a
    // balance, and claims once the admin maps it to an address.
    for (let i: uint64 = Uint64(0); i < entries.length; i = i + Uint64(1)) {
      this.addBalance(entries[i].identity, entries[i].amount)
    }
    this.addBalance(OPS_IDENTITY, opsAmount)
    this.addBalance(TREASURY_IDENTITY, treasuryAmount)

    this.creditedUnclaimed.value = alreadyCredited + batchTotal
    this.lastBatchSeq.value = batchSeq
  }

  // Adds one batch to the four running totals and asserts both bounds.
  private checkAndAdvanceTotals(
    poolInAdd: uint64,
    poolOutAdd: uint64,
    declaredAdd: uint64,
    held: uint64,
  ): void {
    const newPoolIn: uint64 = this.poolIn.value + poolInAdd
    const newPoolOut: uint64 = this.poolOut.value + poolOutAdd
    assert(newPoolOut <= newPoolIn, 'pool payouts exceed the pool part')

    const newDeclared: uint64 = this.declaredTotal.value + declaredAdd
    assert(
      newDeclared <= held + this.claimedTotal.value,
      'declared total exceeds the USDC that arrived',
    )

    this.poolIn.value = newPoolIn
    this.poolOut.value = newPoolOut
    this.declaredTotal.value = newDeclared
  }

  // Adds amount to the balance of an identity. A zero amount writes no box,
  // so it needs no box reference.
  private addBalance(identity: string, amount: uint64): void {
    if (amount === Uint64(0)) {
      return
    }
    const current: uint64 = this.balances(identity).exists
      ? this.balances(identity).value
      : Uint64(0)
    this.balances(identity).value = current + amount
  }

  // The mapped address of an identity claims its whole balance. MIN_CLAIM
  // gates dust claims. Inner fees are 0; the claimant pools the fee through
  // the outer app-call fee. A remap applied by applyIdentity() moves future
  // claims to the new address; it does not touch a balance already claimed.
  public claim(identity: string): void {
    const isRetired: boolean = this.retired.hasValue ? this.retired.value : false
    assert(!isRetired, 'app is retired')
    assert(this.identityAddress(identity).exists, 'unmapped identity')
    assert(Txn.sender.bytes === this.identityAddress(identity).value, 'not the mapped address')

    const balance: uint64 = this.balances(identity).exists
      ? this.balances(identity).value
      : Uint64(0)
    assert(balance >= MIN_CLAIM, 'balance below MIN_CLAIM')
    assert(
      Txn.fee >= CLAIM_MIN_FEE_MULTIPLE * Global.minTxnFee,
      'outer fee must pool the inner fee',
    )

    this.balances(identity).delete()
    this.creditedUnclaimed.value = this.creditedUnclaimed.value - balance
    this.claimedTotal.value = this.claimedTotal.value + balance

    const asset = Asset(this.assetId.value)
    const payToAcct = Account(this.payTo.value)
    itxn
      .assetTransfer({
        sender: payToAcct,
        xferAsset: asset,
        assetReceiver: Txn.sender,
        assetAmount: balance,
        fee: Uint64(0),
      })
      .submit()
  }

  // Admin-only. Records the migration target and the current round.
  // executeRelease() may run once RELEASE_DELAY_ROUNDS have passed, for
  // RELEASE_WINDOW_ROUNDS. A second call overwrites the target and restarts
  // the delay from the new round: the delay always measures from
  // the most recent announcement, not the first one.
  public announceRelease(to: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.announcedTo.value = to.bytes
    this.announcedRound.value = Global.round
  }

  // Admin-only. Runs only after the announce-to-execute delay has passed and
  // before the execute window that follows it closes.
  // Moves no USDC. Marks the app retired (credit() and claim() fail on it
  // from then on), then rekeys payTo to the announced address. payTo's own
  // address never changes; only the authorizer does.
  public executeRelease(): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    assert(this.announcedTo.hasValue, 'no release announced')
    const executableFrom: uint64 = this.announcedRound.value + RELEASE_DELAY_ROUNDS
    assert(Global.round >= executableFrom, 'release delay has not passed')
    assert(
      Global.round < executableFrom + RELEASE_WINDOW_ROUNDS,
      'release window has expired; announce again',
    )

    this.retired.value = true

    const payToAcct = Account(this.payTo.value)
    const releaseTo = Account(this.announcedTo.value)
    itxn
      .payment({
        sender: payToAcct,
        receiver: payToAcct,
        amount: Uint64(0),
        rekeyTo: releaseTo,
        fee: Uint64(0),
      })
      .submit()
  }
}
