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

// Auditor share of an attributed batch, per 1,000 micro-units. Ops gets the
// rest of attributedTotal plus all of unattributedTotal. MVP split (P8):
// auditor 300, ops 700.
const AUDITOR_SHARE_NUM = Uint64(300)
const SPLIT_DEN = Uint64(1000)

// A claim below this floor costs more in fees than it pays out.
const MIN_CLAIM = Uint64(100_000)

// Minimum outer application-call fee for claim(). The inner axfer fee is 0,
// so the claimant pools one min-fee through this outer fee.
const MIN_CLAIM_FEE = Uint64(2_000)

// Fixed identity for the ops pool. The admin maps it to an address the same
// way it maps an auditor identity.
const OPS_IDENTITY = 'ops'

// Fixed identity for the migration sweep target (ADR 0010, SPEC §10.2a).
// executeRelease() sweeps creditedUnclaimed to whatever address this
// identity is mapped to; it fails if the identity is unmapped.
const TREASURY_IDENTITY = 'treasury'

// Delay, in rounds, between announceRelease() and a successful
// executeRelease() call. About 7 days at ~2.9s/round (ADR 0010). Compiled
// in: a new value needs a new contract, per docs/adr/0010.
const RELEASE_DELAY_ROUNDS = Uint64(216_000)

// repo travels with each entry for shape parity with SPEC §10.1, but the
// contract never stores it. The per-repo breakdown lives in the off-chain
// ledger (SPEC §13.2); on-chain, a balance is per identity only.
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

  // identity ("github:<login>", or "ops") -> claimant address, admin-set.
  identityAddress = BoxMap<string, bytes>({ keyPrefix: 'id:' })

  // identity -> credited, unclaimed balance owed to that identity. A new
  // box needs minimum balance on this app's own account, not on payTo.
  // R2's deploy step must fund the app account before the first credit().
  balances = BoxMap<string, uint64>({ keyPrefix: 'bal:' })

  // Migration state (ADR 0010). announcedTo/announcedRound are set together
  // by announceRelease() and read by executeRelease(). retired is set once,
  // by executeRelease(), and gates credit()/claim() from then on.
  announcedTo = GlobalState<bytes>({ key: 'ato' })
  announcedRound = GlobalState<uint64>({ key: 'arn' })
  retired = GlobalState<boolean>({ key: 'ret' })

  // Runs once, at creation. payTo and the USDC asset id are fixed here and
  // never change afterwards.
  public createApplication(payTo: Account, usdcAsset: Asset): void {
    this.payTo.value = payTo.bytes
    this.assetId.value = usdcAsset.id
  }

  // Admin-only. Authorises the hot key that can call credit().
  public setCrediter(addr: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.crediter.value = addr.bytes
  }

  // Admin-only. Maps an identity to the address that claims its balance.
  // The same map holds every auditor identity and the fixed "ops" identity.
  public setIdentity(identity: string, addr: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.identityAddress(identity).value = addr.bytes
  }

  // Crediter-only. Credits one numbered batch of settled payments. entries
  // are auditor amounts, one per (repo, identity), already summed over the
  // batch by the caller (SPEC §10.1, ADR 0005). Never split per payment.
  public credit(
    batchSeq: uint64,
    attributedTotal: uint64,
    unattributedTotal: uint64,
    entries: CreditEntry[],
  ): void {
    const isRetired: boolean = this.retired.hasValue ? this.retired.value : false
    assert(!isRetired, 'app is retired')
    assert(Txn.sender.bytes === this.crediter.value, 'not crediter')

    const last: uint64 = this.lastBatchSeq.hasValue ? this.lastBatchSeq.value : Uint64(0)
    assert(batchSeq === last + Uint64(1), 'batchSeq must follow the last credited batch')

    let entriesTotal: uint64 = Uint64(0)
    for (let i: uint64 = Uint64(0); i < entries.length; i = i + Uint64(1)) {
      entriesTotal = entriesTotal + entries[i].amount
    }
    const auditorShare: uint64 = (attributedTotal * AUDITOR_SHARE_NUM) / SPLIT_DEN
    assert(entriesTotal === auditorShare, 'entries must sum to attributedTotal x 300 / 1000')

    const asset = Asset(this.assetId.value)
    const payToAcct = Account(this.payTo.value)
    const held: uint64 = asset.balance(payToAcct)
    const alreadyCredited: uint64 = this.creditedUnclaimed.hasValue
      ? this.creditedUnclaimed.value
      : Uint64(0)
    const unallocated: uint64 = held - alreadyCredited
    const batchTotal: uint64 = attributedTotal + unattributedTotal
    assert(batchTotal <= unallocated, 'batch total exceeds the unallocated balance')

    // Credit each identity directly. No identity mapping is required here,
    // so an unmapped identity never stalls a batch: it still accrues a
    // balance, and claims once the admin maps it to an address.
    for (let i: uint64 = Uint64(0); i < entries.length; i = i + Uint64(1)) {
      const identity = entries[i].identity
      const current: uint64 = this.balances(identity).exists
        ? this.balances(identity).value
        : Uint64(0)
      this.balances(identity).value = current + entries[i].amount
    }

    const opsAmount: uint64 = attributedTotal - entriesTotal + unattributedTotal
    const opsCurrent: uint64 = this.balances(OPS_IDENTITY).exists
      ? this.balances(OPS_IDENTITY).value
      : Uint64(0)
    this.balances(OPS_IDENTITY).value = opsCurrent + opsAmount

    this.creditedUnclaimed.value = alreadyCredited + batchTotal
    this.lastBatchSeq.value = batchSeq
  }

  // The mapped address of an identity claims its whole balance. MIN_CLAIM
  // gates dust claims. Inner fees are 0; the claimant pools the fee through
  // the outer app-call fee. A later admin remap moves future claims to the
  // new address; it does not touch a balance already claimed.
  public claim(identity: string): void {
    const isRetired: boolean = this.retired.hasValue ? this.retired.value : false
    assert(!isRetired, 'app is retired')
    assert(this.identityAddress(identity).exists, 'unmapped identity')
    assert(Txn.sender.bytes === this.identityAddress(identity).value, 'not the mapped address')

    const balance: uint64 = this.balances(identity).exists
      ? this.balances(identity).value
      : Uint64(0)
    assert(balance >= MIN_CLAIM, 'balance below MIN_CLAIM')
    assert(Txn.fee >= MIN_CLAIM_FEE, 'outer fee must pool the inner fee')

    this.balances(identity).delete()
    this.creditedUnclaimed.value = this.creditedUnclaimed.value - balance

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
  // executeRelease() may run once RELEASE_DELAY_ROUNDS have passed. A
  // second call before that overwrites the target and restarts the delay
  // from the new round (ADR 0010): the delay always measures from the
  // most recent announcement, not the first one.
  public announceRelease(to: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.announcedTo.value = to.bytes
    this.announcedRound.value = Global.round
  }

  // Admin-only. Runs only after the announce-to-execute delay has passed.
  // Sweeps creditedUnclaimed to the "treasury" identity's mapped address,
  // zeroes creditedUnclaimed, marks the app retired (credit() and claim()
  // fail on it from then on), then rekeys payTo to the announced address.
  // payTo's own address never changes; only the authorizer does
  // (invariant 1, CLAUDE.md).
  public executeRelease(): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    assert(this.announcedTo.hasValue, 'no release announced')
    assert(
      Global.round >= this.announcedRound.value + RELEASE_DELAY_ROUNDS,
      'release delay has not passed',
    )
    assert(this.identityAddress(TREASURY_IDENTITY).exists, 'treasury identity not mapped')

    const payToAcct = Account(this.payTo.value)
    const sweepAmount: uint64 = this.creditedUnclaimed.hasValue
      ? this.creditedUnclaimed.value
      : Uint64(0)

    if (sweepAmount > Uint64(0)) {
      const asset = Asset(this.assetId.value)
      const treasuryAcct = Account(this.identityAddress(TREASURY_IDENTITY).value)
      itxn
        .assetTransfer({
          sender: payToAcct,
          xferAsset: asset,
          assetReceiver: treasuryAcct,
          assetAmount: sweepAmount,
          fee: Uint64(0),
        })
        .submit()
    }

    this.creditedUnclaimed.value = Uint64(0)
    this.retired.value = true

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
