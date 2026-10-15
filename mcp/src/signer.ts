// mcp/src/signer.ts
//
// Derives a ClientAvmSigner (the 2.6 x402-avm signer helper) from a donor phrase: a 25-word
// Algorand mnemonic, or a 24-word Universal Wallet phrase at derivation 1.
// Uses algokit-utils' key primitives, not algosdk — algosdk stays in this repo for contract
// and deployment scripts only. The signing steps match toClientAvmSigner.
//
// WARNING: never print or expose the phrase or the derived private key.
import {
  bytesForSigning,
  decodeTransaction,
  encodeSignedTransaction,
} from '@algorandfoundation/algokit-utils/transact'
import type { ClientAvmSigner } from '@x402-avm/avm'
import { accountFromPhrase } from './key-phrase.js'

export async function signerFromMnemonic(mnemonic: string): Promise<ClientAvmSigner> {
  const { address, signRaw } = await accountFromPhrase(mnemonic)
  return {
    address,
    signTransactions: (txns, indexesToSign) =>
      Promise.all(
        txns.map(async (txn, i) => {
          if (indexesToSign && !indexesToSign.includes(i)) return null
          const decoded = decodeTransaction(txn)
          const sig = await signRaw(bytesForSigning.transaction(decoded))
          return encodeSignedTransaction({ txn: decoded, sig })
        }),
      ),
  }
}
