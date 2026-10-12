// mcp/src/key-phrase.ts
//
// Turns a typed recovery phrase into an ed25519 account (ADR 0028).
// 25 words: Algo25. 24 words: a Universal Wallet phrase (BIP-39 seed, ARC-52 Peikert derivation,
// path m/44'/283'/n'/0/0). The word count picks the format.
//
// WARNING: never print or expose the phrase. Error messages never contain the words.
import { seedFromMnemonic } from '@algorandfoundation/algokit-utils/algo25'
import { encodeAddress } from '@algorandfoundation/algokit-utils/common'
import {
  ed25519Generator,
  peikertXHdAccountGenerator,
  peikertXHdWalletGenerator,
  type RawEd25519Signer,
} from '@algorandfoundation/algokit-utils/crypto'
import { mnemonicToSeedSync, validateMnemonic } from '@scure/bip39'
import { wordlist } from '@scure/bip39/wordlists/english'

/** Pera's first named account. Derivation 0 is the wallet root. */
export const DEFAULT_DERIVATION = 1
/** `--address` looks at derivations 0 up to this number, not including it. */
export const ADDRESS_SEARCH_LIMIT = 20

const MAX_DERIVATION = 0x7fffffff
const ALGO25_WORDS = 25
const UNIVERSAL_WORDS = 24

export interface DerivationChoice {
  /** The account number n in m/44'/283'/n'/0/0. 24-word phrases only. */
  derivation?: number
  /** Search derivations 0 to 19 for this address. 24-word phrases only. */
  address?: string
}

export interface KeyAccount {
  address: string
  publicKey: Uint8Array
  /** Signs the bytes to sign of a transaction. Returns the 64-byte signature. */
  signRaw: RawEd25519Signer
}

function words(phrase: string): string[] {
  return phrase.trim().split(/\s+/).filter(Boolean)
}

const COUNT_ERROR = (count: number) =>
  `The key must be a 25-word Algorand mnemonic or a 24-word Universal Wallet phrase. ` +
  `You gave ${count} words.`

/** True when `phrase` is a valid 25-word Algo25 mnemonic or a valid 24-word BIP-39 phrase. */
export function isValidPhrase(phrase: string): boolean {
  const list = words(phrase)
  try {
    if (list.length === ALGO25_WORDS) {
      seedFromMnemonic(list.join(' '))
      return true
    }
    return list.length === UNIVERSAL_WORDS && validateMnemonic(list.join(' '), wordlist)
  } catch {
    return false
  }
}

function assertDerivation(value: number): void {
  if (!Number.isInteger(value) || value < 0 || value > MAX_DERIVATION) {
    throw new Error(`The derivation must be a non-negative integer. You gave ${value}.`)
  }
}

function accountFrom(publicKey: Uint8Array, signRaw: RawEd25519Signer): KeyAccount {
  return { address: encodeAddress(publicKey), publicKey, signRaw }
}

function algo25Account(phrase: string, choice: DerivationChoice): KeyAccount {
  if (choice.derivation !== undefined || choice.address !== undefined) {
    throw new Error(
      '--derivation and --address apply to 24-word Universal Wallet phrases only. ' +
        'A 25-word Algorand mnemonic has one account.',
    )
  }
  let seed: Uint8Array
  try {
    seed = seedFromMnemonic(phrase)
  } catch {
    throw new Error('The 25 words are not a valid Algorand mnemonic. Check each word.')
  }
  const { ed25519Pubkey, rawEd25519Signer } = ed25519Generator(seed)
  return accountFrom(ed25519Pubkey, rawEd25519Signer)
}

async function derive(rootKey: Uint8Array, derivation: number): Promise<KeyAccount> {
  const { ed25519Pubkey, rawEd25519Signer } = await peikertXHdAccountGenerator(
    rootKey,
    derivation,
    0,
  )
  return accountFrom(ed25519Pubkey, rawEd25519Signer)
}

async function findByAddress(rootKey: Uint8Array, address: string): Promise<KeyAccount> {
  for (let derivation = 0; derivation < ADDRESS_SEARCH_LIMIT; derivation++) {
    const account = await derive(rootKey, derivation)
    if (account.address === address) return account
  }
  throw new Error(
    `No derivation from 0 to ${ADDRESS_SEARCH_LIMIT - 1} of this phrase gives the address ` +
      `${address}. Check the address, or use --derivation <n>.`,
  )
}

async function universalAccount(phrase: string, choice: DerivationChoice): Promise<KeyAccount> {
  if (choice.derivation !== undefined && choice.address !== undefined) {
    throw new Error('Use --derivation or --address, not both.')
  }
  if (choice.derivation !== undefined) assertDerivation(choice.derivation)
  if (!validateMnemonic(phrase, wordlist)) {
    throw new Error('The 24 words are not a valid Universal Wallet phrase. Check each word.')
  }
  const { hdRootKey } = await peikertXHdWalletGenerator(mnemonicToSeedSync(phrase))
  if (choice.address !== undefined) return findByAddress(hdRootKey, choice.address)
  return derive(hdRootKey, choice.derivation ?? DEFAULT_DERIVATION)
}

/** Derives the account of a 25-word or 24-word phrase. A 24-word phrase defaults to derivation 1. */
export async function accountFromPhrase(
  phrase: string,
  choice: DerivationChoice = {},
): Promise<KeyAccount> {
  const list = words(phrase)
  const normalized = list.join(' ')
  if (list.length === ALGO25_WORDS) return algo25Account(normalized, choice)
  if (list.length === UNIVERSAL_WORDS) return universalAccount(normalized, choice)
  throw new Error(COUNT_ERROR(list.length))
}
