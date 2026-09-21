import {
  Account,
  Asset,
  assert,
  BoxMap,
  Bytes,
  type bytes,
  Contract,
  Global,
  GlobalState,
  itxn,
  log,
  op,
  Txn,
  Uint64,
  type uint64,
} from '@algorandfoundation/algorand-typescript'

// Rounding granularity for the distributable portion. Dust below this always
// stays at payTo for the next call.
const DIVISIBLE_UNIT = Uint64(1000)

// Hard gating floor: distribute() will not run below this divisible amount.
// Guards against fee-drain by permissionless callers looping distribute() on
// trivial balances. This is a threshold, NOT the rounding unit above.
const MIN_DISTRIBUTE = Uint64(100_000)

// Minimum outer application-call fee. Inner axfers are sent with fee 0, so the
// caller must pool at least 6 min-fees (self + 5 inner) via this outer fee.
const MIN_DISTRIBUTE_FEE = Uint64(6000)

export class SplitRouter extends Contract {
  auditor = GlobalState<bytes>({ key: 'aud' })
  maintainer = GlobalState<bytes>({ key: 'mnt' })
  adversarial = GlobalState<bytes>({ key: 'adv' })
  treasury = GlobalState<bytes>({ key: 'tre' })
  ops = GlobalState<bytes>({ key: 'ops' })
  assetId = GlobalState<uint64>({ key: 'ast' })

  // Escrow account that accrues USDC before distribute() fans it out.
  // Defaults to the app address; may instead be a plain account rekeyed to
  // this app (see releaseAuthority()).
  payTo = GlobalState<bytes>({ key: 'pto' })

  // Optional SPM attestation public key, admin-set.
  attestationKey = GlobalState<bytes>({ key: 'atk' })

  attests = BoxMap<string, bytes>({ keyPrefix: 'attest:' })

  // Admin-only. Sets payTo to an external account, bootstrapping variant B.
  // Correctable while payTo holds zero revenue; locked once revenue lands,
  // because payTo is the competition leaderboard key. The asset balance is
  // the signal a payment has settled, so a non-zero balance rejects the
  // change.
  //
  // No-assetId rule: if setRecipients has never run, assetId has no value.
  // No payment can have settled without a configured asset, so the balance
  // check is skipped and the change is allowed.
  public setPayTo(addr: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    assert(
      addr.bytes !== Global.currentApplicationAddress.bytes,
      'use the default app-address path instead',
    )
    if (this.assetId.hasValue) {
      // setRecipients always sets payTo alongside assetId, so payTo has a
      // value here too.
      const asset = Asset(this.assetId.value)
      const currentPayTo = Account(this.payTo.value)
      // op.AssetHolding.assetBalance returns [balance, exists]. Use it
      // instead of asset.balance(), which fails outright for an account
      // that has never opted in. A not-opted-in account holds no revenue,
      // so treat "not opted in" as a zero balance, not a rejection.
      const [bal, exists] = op.AssetHolding.assetBalance(currentPayTo, asset)
      const balance: uint64 = exists ? bal : Uint64(0)
      assert(balance === Uint64(0), 'payTo already holds revenue')
    }
    this.payTo.value = addr.bytes
  }

  public setRecipients(
    auditor: Account,
    maintainer: Account,
    adversarial: Account,
    treasury: Account,
    ops: Account,
    assetId: Asset,
  ): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.auditor.value = auditor.bytes
    this.maintainer.value = maintainer.bytes
    this.adversarial.value = adversarial.bytes
    this.treasury.value = treasury.bytes
    this.ops.value = ops.bytes
    this.assetId.value = assetId.id

    if (!this.payTo.hasValue) {
      this.payTo.value = Global.currentApplicationAddress.bytes
    }
  }

  // Opts in the account that actually receives USDC, not always the app.
  // Variant A (default, payTo == app address): the sender is the app
  // account, opting itself in.
  // Variant B (payTo is an external, rekeyed account): the sender is payTo.
  // payTo is rekeyed to this app (see releaseAuthority()), so the app can
  // authorise an inner transaction on payTo's behalf. This is the same
  // rekeyed-sender pattern distribute() and releaseAuthority() already rely
  // on, so it is confirmed to work for this contract.
  public optInToAsset(asset: Asset): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    const receiver = this.payTo.hasValue
      ? Account(this.payTo.value)
      : Global.currentApplicationAddress
    itxn
      .assetTransfer({
        sender: receiver,
        xferAsset: asset,
        assetReceiver: receiver,
        assetAmount: Uint64(0),
        fee: Uint64(0),
      })
      .submit()
  }

  // Permissionless, no args. Fans out whatever USDC has accrued at payTo.
  // See MIN_DISTRIBUTE / MIN_DISTRIBUTE_FEE for the fee-drain guard.
  public distribute(): void {
    const asset = Asset(this.assetId.value)
    const payToAcct = Account(this.payTo.value)
    const balance = asset.balance(payToAcct)

    const divisible: uint64 = (balance / DIVISIBLE_UNIT) * DIVISIBLE_UNIT
    assert(divisible >= MIN_DISTRIBUTE, 'below minimum distribution')
    assert(Txn.fee >= MIN_DISTRIBUTE_FEE, 'outer fee must pool inner fees')

    const auditorShare: uint64 = (divisible * Uint64(50)) / Uint64(100)
    const maintainerShare: uint64 = (divisible * Uint64(20)) / Uint64(100)
    const adversarialShare: uint64 = (divisible * Uint64(15)) / Uint64(100)
    const treasuryShare: uint64 = (divisible * Uint64(10)) / Uint64(100)
    // Remainder, not a fresh division, so the five shares always sum exactly
    // to divisible regardless of rounding in the shares above.
    const opsShare: uint64 =
      divisible - auditorShare - maintainerShare - adversarialShare - treasuryShare

    itxn.submitGroup(
      itxn.assetTransfer({
        sender: payToAcct,
        xferAsset: asset,
        assetReceiver: Account(this.auditor.value),
        assetAmount: auditorShare,
        fee: Uint64(0),
      }),
      itxn.assetTransfer({
        sender: payToAcct,
        xferAsset: asset,
        assetReceiver: Account(this.maintainer.value),
        assetAmount: maintainerShare,
        fee: Uint64(0),
      }),
      itxn.assetTransfer({
        sender: payToAcct,
        xferAsset: asset,
        assetReceiver: Account(this.adversarial.value),
        assetAmount: adversarialShare,
        fee: Uint64(0),
      }),
      itxn.assetTransfer({
        sender: payToAcct,
        xferAsset: asset,
        assetReceiver: Account(this.treasury.value),
        assetAmount: treasuryShare,
        fee: Uint64(0),
      }),
      itxn.assetTransfer({
        sender: payToAcct,
        xferAsset: asset,
        assetReceiver: Account(this.ops.value),
        assetAmount: opsShare,
        fee: Uint64(0),
      }),
    )
  }

  // integrity binds the tarball's dist.integrity (sha512), not just name@version,
  // so lockfiles cannot re-point the same name@version at other bytes.
  public attest(pkg: string, ver: string, status: uint64, integrity: string): void {
    assert(Txn.sender.bytes === this.auditor.value, 'not auditor')
    const key = `${pkg}@${ver}`
    // Pack: auditor(32) + txId(32) + status(8) + ts(8) + integrity(variable)
    const packed: bytes = Txn.sender.bytes
      .concat(Txn.txId)
      .concat(op.itob(status))
      .concat(op.itob(Global.latestTimestamp))
      .concat(Bytes(integrity))
    this.attests(key).value = packed
    log(pkg, '@', ver, ' ', Txn.sender.bytes)
  }

  // Admin-gated: rekeys payTo away from this app. Publicly disclose the
  // recipient address; once called, distribute() can no longer move funds
  // held at the (now-released) payTo account.
  public releaseAuthority(to: Account): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    assert(
      this.payTo.value !== Global.currentApplicationAddress.bytes,
      'payTo is the application address; an app account cannot be rekeyed',
    )
    const payToAcct = Account(this.payTo.value)
    itxn
      .payment({
        sender: payToAcct,
        receiver: payToAcct,
        amount: Uint64(0),
        rekeyTo: to,
        fee: Uint64(0),
      })
      .submit()
  }

  public setAttestationKey(key: bytes): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    this.attestationKey.value = key
  }
}
