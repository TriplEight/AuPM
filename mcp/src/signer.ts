// mcp/src/signer.ts
//
// Derives a ClientAvmSigner (the 2.6 x402-avm signer helper) from a 25-word
// Algorand mnemonic. Uses algokit-utils' key primitives, not algosdk — algosdk
// stays in this repo for contract and deployment scripts only.
//
// WARNING: never print or expose the mnemonic or the derived private key.
import { seedFromMnemonic } from '@algorandfoundation/algokit-utils/algo25'
import { ed25519Generator } from '@algorandfoundation/algokit-utils/crypto'
import { type ClientAvmSigner, toClientAvmSigner } from '@x402-avm/avm'

export function signerFromMnemonic(mnemonic: string): ClientAvmSigner {
  const seed = seedFromMnemonic(mnemonic)
  const { ed25519Pubkey } = ed25519Generator(seed)

  // toClientAvmSigner expects a Base64-encoded 64-byte key: 32-byte seed + 32-byte public key.
  const privateKey = new Uint8Array(64)
  privateKey.set(seed, 0)
  privateKey.set(ed25519Pubkey, 32)

  return toClientAvmSigner(Buffer.from(privateKey).toString('base64'))
}
