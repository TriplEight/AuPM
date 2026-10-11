import crypto from 'node:crypto'
import fs from 'node:fs'
import { mnemonicFromSeed } from '@algorandfoundation/algokit-utils/algo25'
import { Address } from '@algorandfoundation/algokit-utils/common'
import { ed25519Verifier } from '@algorandfoundation/algokit-utils/crypto'
import {
  bytesForSigning,
  decodeSignedTransaction,
  encodeTransaction,
  Transaction,
  TransactionType,
} from '@algorandfoundation/algokit-utils/transact'
import { describe, expect, it } from 'vitest'
import { accountFromPhrase, DEFAULT_DERIVATION, isValidPhrase } from './key-phrase.js'
import { signerFromMnemonic } from './signer.js'

// The 24 words in the fixture come from a Pera Universal Wallet made for this test on TestNet.
// The wallet is a public throwaway. It never held funds. Never put a real key in a fixture.
const PERA_PHRASE = fs
  .readFileSync(new URL('./__fixtures__/pera-testnet-universal.txt', import.meta.url), 'utf8')
  .trim()
const DERIVATION_0 = 'JNFVWY2Q44O3K5IYRYG5JE7ZKR4KP34JEQVGCKE7ECXKTTX7364VXFDK7M'
const DERIVATION_1 = 'XRGJY2DYXW3E3O34VFKLSA4VLUESY77Z2D6NBNKTNFBA76WM3NYKPTRH7A'
const ALGO25_PHRASE = mnemonicFromSeed(crypto.randomBytes(32))

async function errorOf(action: () => Promise<unknown>): Promise<string> {
  try {
    await action()
  } catch (error) {
    return (error as Error).message
  }
  return ''
}

describe('24-word Universal Wallet phrase', () => {
  it('derives the Pera addresses for derivation 0 and 1', async () => {
    expect((await accountFromPhrase(PERA_PHRASE, { derivation: 0 })).address).toBe(DERIVATION_0)
    expect((await accountFromPhrase(PERA_PHRASE, { derivation: 1 })).address).toBe(DERIVATION_1)
  })

  it('defaults to derivation 1, the first named Pera account', async () => {
    expect(DEFAULT_DERIVATION).toBe(1)
    expect((await accountFromPhrase(PERA_PHRASE)).address).toBe(DERIVATION_1)
  })

  it('finds an address among derivations 0 to 19', async () => {
    expect((await accountFromPhrase(PERA_PHRASE, { address: DERIVATION_1 })).address).toBe(
      DERIVATION_1,
    )
    expect((await accountFromPhrase(PERA_PHRASE, { address: DERIVATION_0 })).address).toBe(
      DERIVATION_0,
    )
  })

  it('refuses an address that no derivation gives', async () => {
    const other = new Address(new Uint8Array(32).fill(7)).toString()
    expect(await errorOf(() => accountFromPhrase(PERA_PHRASE, { address: other }))).toContain(
      `No derivation from 0 to 19 of this phrase gives the address ${other}`,
    )
  })

  it('refuses --derivation and --address together', async () => {
    const message = await errorOf(() =>
      accountFromPhrase(PERA_PHRASE, { derivation: 1, address: DERIVATION_1 }),
    )
    expect(message).toBe('Use --derivation or --address, not both.')
  })

  it.each([-1, 1.5, 2 ** 31])('refuses derivation %s', async (derivation) => {
    expect(await errorOf(() => accountFromPhrase(PERA_PHRASE, { derivation }))).toContain(
      'non-negative integer',
    )
  })

  it('refuses a bad checksum and does not print the words', async () => {
    const phrase = 'abandon '.repeat(23).concat('abandon')
    expect(await errorOf(() => accountFromPhrase(phrase))).toBe(
      'The 24 words are not a valid Universal Wallet phrase. Check each word.',
    )
  })

  it('signs a transaction that verifies against the derived public key', async () => {
    const signer = await signerFromMnemonic(PERA_PHRASE)
    expect(signer.address).toBe(DERIVATION_1)
    const txn = new Transaction({
      type: TransactionType.Payment,
      sender: Address.fromString(DERIVATION_1),
      fee: 1000n,
      firstValid: 1n,
      lastValid: 1001n,
      genesisHash: new Uint8Array(32),
      genesisId: 'testnet-v1.0',
      payment: { receiver: Address.fromString(DERIVATION_1), amount: 0n },
    })
    const [signed] = await signer.signTransactions([encodeTransaction(txn)])
    const decoded = decodeSignedTransaction(signed as Uint8Array)
    const { publicKey } = await accountFromPhrase(PERA_PHRASE)
    expect(decoded.sig).toBeDefined()
    expect(
      await ed25519Verifier(decoded.sig as Uint8Array, bytesForSigning.transaction(txn), publicKey),
    ).toBe(true)
  })
})

describe('25-word Algo25 phrase', () => {
  it('derives an account and accepts it as valid', async () => {
    expect(isValidPhrase(ALGO25_PHRASE)).toBe(true)
    expect((await accountFromPhrase(ALGO25_PHRASE)).address).toMatch(/^[A-Z2-7]{58}$/)
  })

  it.each([{ derivation: 1 }, { address: DERIVATION_1 }])(
    'refuses the flags %j and says they apply to 24-word phrases',
    async (choice) => {
      expect(await errorOf(() => accountFromPhrase(ALGO25_PHRASE, choice))).toContain(
        'apply to 24-word Universal Wallet phrases only',
      )
    },
  )

  it('refuses 25 words that are not a mnemonic', async () => {
    expect(await errorOf(() => accountFromPhrase('abandon '.repeat(25)))).toBe(
      'The 25 words are not a valid Algorand mnemonic. Check each word.',
    )
  })
})

describe('word count', () => {
  it.each([23, 26])('refuses %s words and names both formats', async (count) => {
    const phrase = PERA_PHRASE.split(' ').concat(ALGO25_PHRASE.split(' ')).slice(0, count).join(' ')
    const message = await errorOf(() => accountFromPhrase(phrase))
    expect(message).toBe(
      `The key must be a 25-word Algorand mnemonic or a 24-word Universal Wallet phrase. ` +
        `You gave ${count} words.`,
    )
    expect(isValidPhrase(phrase)).toBe(false)
  })
})
