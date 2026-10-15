// cli/src/sign.ts
//
// Signs an algosdk transaction with a KeyAccount. The account holds a signer function, not a
// 64-byte secret key, because a Universal Wallet account has no algosdk secret key.
import type algosdk from 'algosdk'
import type { KeyAccount } from 'aupm-mcp/key-phrase'

/** Returns the signed transaction bytes. */
export async function signTxn(account: KeyAccount, txn: algosdk.Transaction): Promise<Uint8Array> {
  const signature = await account.signRaw(txn.bytesToSign())
  return txn.attachSignature(account.address, signature)
}
