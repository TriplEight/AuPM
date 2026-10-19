import {
  Account,
  Asset,
  assert,
  Bytes,
  type bytes,
  Contract,
  Global,
  GlobalState,
  itxn,
  op,
  TemplateVar,
  Txn,
  Uint64,
  type uint64,
} from '@algorandfoundation/algorand-typescript'

// Off-the-top shares of newTotal, per 1,000 micro-units. The contract
// computes both and rounds down. The rest of newTotal goes to the pool part.
const OPS_SHARE_NUM = Uint64(50)
const TREASURY_CUT_NUM = Uint64(200)
const SPLIT_DEN = Uint64(1000)

// Length, in rounds, of one cap period. About 1 day at ~2.9s/round. The period
// index is the round divided by this length. Compiled in: a new value needs a
// new contract.
const CAP_PERIOD_ROUNDS = Uint64(30_000)

// Release timing is set when the app is deployed. The deploy step substitutes
// both values into the programs, and createApplication() stores them in global
// state so tools read them from the chain.
//   TMPL_RELEASE_DELAY_ROUNDS   rounds between an announcement and its use:
//                               announceRelease() to executeRelease(), and
//                               announceChange() to applyChange().
//   TMPL_RELEASE_WINDOW_ROUNDS  rounds after the delay in which the announced
//                               action may run. After that the announcement
//                               expires and the admin must announce again,
//                               which restarts the delay.
// MainNet uses 216,000 and 216,000 rounds (about 7 days each at ~2.9s/round).
// TestNet uses short values so the path can be rehearsed in minutes. The
// deploy tooling refuses any other MainNet value.
// Each method reads the template values where it uses them.

// Keys that announceChange() accepts.
const CHANGE_CAP = 'cap'
const CHANGE_OPS = 'ops'
const CHANGE_TREASURY = 'trs'

const ADDRESS_LENGTH = Uint64(32)

// One pool payee of a batch. credit() pays it directly from payTo.
type Payout = {
  receiver: Account
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

  // Running totals, in micro-units. poolIn starts at carryIn and grows by the
  // pool part of each batch. poolOut grows by the payouts and the pool money
  // sent to treasury. declaredTotal starts at carryIn and grows by the USDC
  // each batch declares as arrived. paidTotal grows by every USDC transfer
  // credit() sends. credit() keeps poolOut <= poolIn and
  // declaredTotal <= payTo USDC balance + paidTotal.
  poolIn = GlobalState<uint64>({ key: 'pin' })
  poolOut = GlobalState<uint64>({ key: 'pot' })
  declaredTotal = GlobalState<uint64>({ key: 'dct' })
  paidTotal = GlobalState<uint64>({ key: 'pdt' })

  // Receivers of the ops share and of the treasury money. The admin changes
  // them through announceChange() and applyChange().
  opsAddress = GlobalState<bytes>({ key: 'ops' })
  treasuryAddress = GlobalState<bytes>({ key: 'trs' })

  // Cap on the payouts of one cap period. paidInPeriod counts the payouts
  // sent in the period that capPeriodIndex names.
  payoutCap = GlobalState<uint64>({ key: 'cap' })
  capPeriodIndex = GlobalState<uint64>({ key: 'cpi' })
  paidInPeriod = GlobalState<uint64>({ key: 'pip' })

  // The one pending change. An empty pendingKey means none is pending.
  pendingKey = GlobalState<string>({ key: 'pky' })
  pendingValue = GlobalState<bytes>({ key: 'pvl' })
  pendingRound = GlobalState<uint64>({ key: 'prn' })

  // Migration state. announcedTo/announcedRound are set together
  // by announceRelease() and read by executeRelease(). retired is set once,
  // by executeRelease(), and gates credit() from then on.
  announcedTo = GlobalState<bytes>({ key: 'ato' })
  announcedRound = GlobalState<uint64>({ key: 'arn' })
  retired = GlobalState<boolean>({ key: 'ret' })

  // The release delay and window this app was deployed with, in rounds.
  // createApplication() copies them from the template values.
  releaseDelay = GlobalState<uint64>({ key: 'rdl' })
  releaseWindow = GlobalState<uint64>({ key: 'rwn' })

  // Runs once, at creation. payTo and the USDC asset id are fixed here and
  // never change afterwards. carryIn is the USDC at payTo that an earlier
  // app did not pay out. It starts as both pool money and declared money.
  public createApplication(
    payTo: Account,
    usdcAsset: Asset,
    carryIn: uint64,
    opsAddress: Account,
    treasuryAddress: Account,
    payoutCap: uint64,
  ): void {
    this.payTo.value = payTo.bytes
    this.assetId.value = usdcAsset.id
    this.poolIn.value = carryIn
    this.poolOut.value = Uint64(0)
    this.declaredTotal.value = carryIn
    this.paidTotal.value = Uint64(0)
    this.opsAddress.value = opsAddress.bytes
    this.treasuryAddress.value = treasuryAddress.bytes
    this.payoutCap.value = payoutCap
    this.capPeriodIndex.value = Global.round / CAP_PERIOD_ROUNDS
    this.paidInPeriod.value = Uint64(0)
    this.pendingKey.value = ''
    this.pendingValue.value = Bytes()
    this.pendingRound.value = Uint64(0)
    this.releaseDelay.value = TemplateVar<uint64>('RELEASE_DELAY_ROUNDS')
    this.releaseWindow.value = TemplateVar<uint64>('RELEASE_WINDOW_ROUNDS')
  }

  // Admin-only. Authorises the hot key that can call credit().
  public setCrediter(addr: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.crediter.value = addr.bytes
  }

  // Admin-only. Lowers the payout cap at once. A raise goes through
  // announceChange() and its delay.
  public lowerPayoutCap(cap: uint64): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    assert(cap <= this.payoutCap.value, 'cap can only be lowered')
    this.payoutCap.value = cap
  }

  // Admin-only. Records one change: 'cap' (8-byte big-endian uint64), 'ops' or
  // 'trs' (32-byte address). A new call replaces the pending change and
  // restarts the delay.
  public announceChange(key: string, value: bytes): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    assert(
      key === CHANGE_CAP || key === CHANGE_OPS || key === CHANGE_TREASURY,
      'unknown change key',
    )
    if (key === CHANGE_CAP) {
      assert(value.length === Uint64(8), 'cap must be 8 bytes')
    } else {
      assert(value.length === ADDRESS_LENGTH, 'address must be 32 bytes')
    }
    this.pendingKey.value = key
    this.pendingValue.value = value
    this.pendingRound.value = Global.round
  }

  // Admin-only. Applies the pending change once the release delay has
  // passed and before the release window has passed after that. Clears the
  // pending change. A 'cap' change may raise the cap.
  public applyChange(): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    const key: string = this.pendingKey.value
    assert(key !== '', 'no pending change')
    const delayRounds = TemplateVar<uint64>('RELEASE_DELAY_ROUNDS')
    const windowRounds = TemplateVar<uint64>('RELEASE_WINDOW_ROUNDS')
    const applicableFrom: uint64 = this.pendingRound.value + delayRounds
    assert(Global.round >= applicableFrom, 'change delay has not passed')
    assert(
      Global.round < applicableFrom + windowRounds,
      'change window has expired; announce again',
    )
    if (key === CHANGE_CAP) {
      this.payoutCap.value = op.btoi(this.pendingValue.value)
    } else if (key === CHANGE_OPS) {
      this.opsAddress.value = this.pendingValue.value
    } else {
      this.treasuryAddress.value = this.pendingValue.value
    }
    this.pendingKey.value = ''
    this.pendingValue.value = Bytes()
    this.pendingRound.value = Uint64(0)
  }

  // Does nothing. The off-chain job puts up to 15 of these in the group of a
  // credit() call. They carry the USDC asset and up to 7 receiver accounts
  // each, so credit() reaches those holdings through group resource sharing.
  public refs(): void {}

  // Crediter-only. Credits one numbered batch and pays it out of payTo. The
  // contract computes ops and the treasury cut from newTotal and rounds down.
  // payouts are pool payees, paid one transfer each. treasuryExtra and
  // unattributedTotal go to treasury. Any failing transfer fails the whole
  // call, so batchSeq does not advance. Never split per payment.
  public credit(
    batchSeq: uint64,
    newTotal: uint64,
    unattributedTotal: uint64,
    treasuryExtra: uint64,
    payouts: Payout[],
  ): void {
    const isRetired: boolean = this.retired.hasValue ? this.retired.value : false
    assert(!isRetired, 'app is retired')
    assert(Txn.sender.bytes === this.crediter.value, 'not crediter')

    const last: uint64 = this.lastBatchSeq.hasValue ? this.lastBatchSeq.value : Uint64(0)
    assert(batchSeq === last + Uint64(1), 'batchSeq must follow the last credited batch')

    let payoutsTotal: uint64 = Uint64(0)
    for (let i: uint64 = Uint64(0); i < payouts.length; i = i + Uint64(1)) {
      assert(payouts[i].amount > Uint64(0), 'payout amount must be above 0')
      assert(
        payouts[i].receiver.bytes !== this.payTo.value &&
          payouts[i].receiver !== Global.currentApplicationAddress,
        'payout must not name payTo or the app',
      )
      payoutsTotal = payoutsTotal + payouts[i].amount
    }
    this.checkCap(payoutsTotal)

    const opsAmount: uint64 = (newTotal * OPS_SHARE_NUM) / SPLIT_DEN
    const cutAmount: uint64 = (newTotal * TREASURY_CUT_NUM) / SPLIT_DEN
    const treasuryAmount: uint64 = cutAmount + treasuryExtra + unattributedTotal

    const batchTotal: uint64 = opsAmount + treasuryAmount + payoutsTotal
    const heldBefore: uint64 = Asset(this.assetId.value).balance(Account(this.payTo.value))
    assert(batchTotal <= heldBefore, 'batch total exceeds the balance of payTo')

    const newPoolIn: uint64 = this.poolIn.value + (newTotal - opsAmount - cutAmount)
    const newPoolOut: uint64 = this.poolOut.value + payoutsTotal + treasuryExtra
    assert(newPoolOut <= newPoolIn, 'pool payouts exceed the pool part')

    for (let i: uint64 = Uint64(0); i < payouts.length; i = i + Uint64(1)) {
      this.pay(payouts[i].receiver, payouts[i].amount)
    }
    this.pay(Account(this.opsAddress.value), opsAmount)
    this.pay(Account(this.treasuryAddress.value), treasuryAmount)

    const newPaid: uint64 = this.paidTotal.value + batchTotal
    const newDeclared: uint64 = this.declaredTotal.value + newTotal + unattributedTotal
    const heldAfter: uint64 = Asset(this.assetId.value).balance(Account(this.payTo.value))
    assert(newDeclared <= heldAfter + newPaid, 'declared total exceeds the USDC that arrived')

    this.poolIn.value = newPoolIn
    this.poolOut.value = newPoolOut
    this.declaredTotal.value = newDeclared
    this.paidTotal.value = newPaid
    this.lastBatchSeq.value = batchSeq
  }

  // Starts a new cap period when the round index changes, then asserts that
  // the payouts of this batch fit under the cap. The cap bounds payouts only.
  private checkCap(payoutsTotal: uint64): void {
    const period: uint64 = Global.round / CAP_PERIOD_ROUNDS
    if (period !== this.capPeriodIndex.value) {
      this.capPeriodIndex.value = period
      this.paidInPeriod.value = Uint64(0)
    }
    const paid: uint64 = this.paidInPeriod.value + payoutsTotal
    assert(paid <= this.payoutCap.value, 'payouts exceed the cap of this period')
    this.paidInPeriod.value = paid
  }

  // Sends USDC from payTo. A zero amount sends nothing. The inner fee is 0;
  // the caller pools the fee through the outer fee.
  private pay(receiver: Account, amount: uint64): void {
    if (amount === Uint64(0)) {
      return
    }
    itxn
      .assetTransfer({
        sender: Account(this.payTo.value),
        xferAsset: Asset(this.assetId.value),
        assetReceiver: receiver,
        assetAmount: amount,
        fee: Uint64(0),
      })
      .submit()
  }

  // Admin-only. Records the migration target and the current round.
  // executeRelease() may run once the release delay has passed, for
  // the release window. A second call overwrites the target and restarts
  // the delay from the new round: the delay always measures from
  // the most recent announcement, not the first one.
  public announceRelease(to: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.announcedTo.value = to.bytes
    this.announcedRound.value = Global.round
  }

  // Admin-only. Runs only after the announce-to-execute delay has passed and
  // before the execute window that follows it closes.
  // Moves no USDC. Marks the app retired (credit() fails on it
  // from then on), then rekeys payTo to the announced address. payTo's own
  // address never changes; only the authorizer does.
  public executeRelease(): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    assert(this.announcedTo.hasValue, 'no release announced')
    const delayRounds = TemplateVar<uint64>('RELEASE_DELAY_ROUNDS')
    const windowRounds = TemplateVar<uint64>('RELEASE_WINDOW_ROUNDS')
    const executableFrom: uint64 = this.announcedRound.value + delayRounds
    assert(Global.round >= executableFrom, 'release delay has not passed')
    assert(
      Global.round < executableFrom + windowRounds,
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
