import {
  Contract,
  GlobalState,
  BoxMap,
  Txn,
  Global,
  Uint64,
  Account,
  Asset,
  assert,
  itxn,
  type uint64,
  type bytes,
} from '@algorandfoundation/algorand-typescript'

const UNIT = Uint64(1000) // 1000 µUSDC = $0.001

export class SplitRouter extends Contract {
  auditor = GlobalState<bytes>({ key: 'aud' })
  maintainer = GlobalState<bytes>({ key: 'mnt' })
  adversarial = GlobalState<bytes>({ key: 'adv' })
  treasury = GlobalState<bytes>({ key: 'tre' })
  ops = GlobalState<bytes>({ key: 'ops' })
  assetId = GlobalState<uint64>({ key: 'ast' })

  attests = BoxMap<string, bytes>({ keyPrefix: 'attest:' })

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
  }

  public optInToAsset(asset: Asset): void {
    assert(Txn.sender.bytes === Global.creatorAddress.bytes, 'admin only')
    itxn
      .assetTransfer({
        xferAsset: asset,
        assetReceiver: Global.currentApplicationAddress,
        assetAmount: Uint64(0),
        fee: Uint64(0),
      })
      .submit()
  }
}
