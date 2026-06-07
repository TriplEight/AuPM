// mcp/src/signer.ts
import algosdk from 'algosdk'

export type AvmSigner = {
  address: string
  account: algosdk.Account
  signer: algosdk.TransactionSigner
}

export function signerFromMnemonic(mnemonic: string): AvmSigner {
  const account = algosdk.mnemonicToSecretKey(mnemonic)
  // algosdk v3 TransactionSigner: (txns, indexes) => Promise<Uint8Array[]>
  const signer: algosdk.TransactionSigner = (txns, indexes) =>
    Promise.resolve(indexes.map((i) => algosdk.signTransaction(txns[i]!, account.sk).blob))
  return { address: account.addr.toString(), account, signer }
}
