// cli/src/auditor-chain.ts
//
// The chain side of the auditor commands: box reads, the claim() checks and the two
// transactions. It ports scripts/claim.mjs and scripts/anchor-review.mjs. Every send goes to
// algod. The facilitator is not involved (the anchor and the claim are the auditor's own).
import algosdk from 'algosdk'
import type { KeyAccount } from 'aupm-mcp/key-phrase'
import { signTxn } from './sign.js'

export const MIN_CLAIM_FEE = 2_000
export const CLAIM_METHOD_SIGNATURE = 'claim(string)void'

export type NetworkName = 'mainnet' | 'testnet'

const GENESIS_ID: Record<NetworkName, string> = {
  mainnet: 'mainnet-v1.0',
  testnet: 'testnet-v1.0',
}

const encoder = new TextEncoder()

/** The box name of `identityAddress`: the utf8 bytes of `id:` and the identity. */
export function identityBoxName(identity: string): Uint8Array {
  return encoder.encode(`id:${identity}`)
}

/** The box name of `balances`: the utf8 bytes of `bal:` and the identity. */
export function balanceBoxName(identity: string): Uint8Array {
  return encoder.encode(`bal:${identity}`)
}

function isBoxNotFound(error: unknown): boolean {
  const e = error as { message?: unknown; status?: unknown; statusCode?: unknown }
  return (
    /box not found/i.test(String(e?.message ?? error)) || e?.status === 404 || e?.statusCode === 404
  )
}

/** The credited, unclaimed balance in microUSDC. 0 when the box does not exist. */
export async function readBalance(
  algod: algosdk.Algodv2,
  appId: number,
  identity: string,
): Promise<bigint> {
  try {
    const box = await algod.getApplicationBoxByName(appId, balanceBoxName(identity)).do()
    return BigInt(algosdk.decodeUint64(box.value, 'bigint'))
  } catch (error) {
    if (isBoxNotFound(error)) return 0n
    throw error
  }
}

/** The address mapped to the identity. null when unmapped. */
export async function readMappedAddress(
  algod: algosdk.Algodv2,
  appId: number,
  identity: string,
): Promise<string | null> {
  try {
    const box = await algod.getApplicationBoxByName(appId, identityBoxName(identity)).do()
    return algosdk.encodeAddress(box.value)
  } catch (error) {
    if (isBoxNotFound(error)) return null
    throw error
  }
}

export interface AccountFacts {
  optedIn: boolean
  algoAvailable: bigint
}

/** The USDC opt-in and the ALGO above the minimum balance of `address`. */
export async function readAccountFacts(
  algod: algosdk.Algodv2,
  address: string,
  usdcAssetId: number,
): Promise<AccountFacts> {
  const info = await algod.accountInformation(address).do()
  const holding = (info.assets ?? []).find((asset) => asset.assetId === BigInt(usdcAssetId))
  return { optedIn: holding !== undefined, algoAvailable: info.amount - info.minBalance }
}

/** Throws when the connected algod is not on the network the server reports. */
export function assertGenesis(network: NetworkName, genesisId: string): void {
  if (genesisId !== GENESIS_ID[network]) {
    throw new Error(
      `The algod node reports network "${genesisId}". The server reports ${network}. ` +
        'Check ALGOD_MAINNET_URL and ALGOD_TESTNET_URL.',
    )
  }
}

/** Throws unless `signer` is the address mapped to the login. */
export function assertMappedSigner(mapped: string | null, signer: string): void {
  if (!mapped) {
    throw new Error('This login is not mapped to any address on-chain. Ask an admin to map it.')
  }
  if (mapped !== signer) {
    throw new Error(
      `The key address (${signer}) is not the address mapped to this login (${mapped}). ` +
        'claim() would reject this call.',
    )
  }
}

/** Throws unless the claim() checks pass. The messages match scripts/claim.mjs. */
export function assertClaimable(args: {
  balance: bigint
  minClaim: number
  mapped: string | null
  signer: string
  facts: AccountFacts
}): void {
  const { balance, minClaim, mapped, signer, facts } = args
  assertMappedSigner(mapped, signer)
  if (balance < BigInt(minClaim)) {
    throw new Error(
      `The credited balance is ${balance} microUSDC. MIN_CLAIM is ${minClaim}. ` +
        'Wait for more nightly batches before you claim.',
    )
  }
  if (!facts.optedIn) {
    throw new Error('This address has not opted in to USDC. Opt in first, then claim.')
  }
  if (facts.algoAvailable < BigInt(MIN_CLAIM_FEE)) {
    throw new Error(
      `This address has ${facts.algoAvailable} microALGO above its minimum balance. ` +
        `The claim needs ${MIN_CLAIM_FEE} microALGO for the fee.`,
    )
  }
}

async function sendAndConfirm(
  algod: algosdk.Algodv2,
  txn: algosdk.Transaction,
  account: KeyAccount,
) {
  await algod.sendRawTransaction(await signTxn(account, txn)).do()
  const txid = txn.txID()
  await algosdk.waitForConfirmation(algod, txid, 6)
  return txid
}

/** Sends the review anchor: a 0-ALGO payment from the auditor to itself with the note. */
export async function sendAnchor(
  algod: algosdk.Algodv2,
  account: KeyAccount,
  note: Uint8Array,
): Promise<string> {
  const { address } = account
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    note,
    suggestedParams: await algod.getTransactionParams().do(),
  })
  return sendAndConfirm(algod, txn, account)
}

/** Sends one claim(identity) call. The outer fee pools the inner transfer fee. */
export async function sendClaim(
  algod: algosdk.Algodv2,
  account: KeyAccount,
  call: { appId: number; identity: string; payTo: string; usdcAssetId: number },
): Promise<string> {
  const suggestedParams = await algod.getTransactionParams().do()
  suggestedParams.flatFee = true
  suggestedParams.fee = BigInt(Math.max(Number(suggestedParams.minFee), MIN_CLAIM_FEE))
  const method = algosdk.ABIMethod.fromSignature(CLAIM_METHOD_SIGNATURE)
  const txn = algosdk.makeApplicationCallTxnFromObject({
    sender: account.address,
    appIndex: call.appId,
    onComplete: algosdk.OnApplicationComplete.NoOpOC,
    appArgs: [method.getSelector(), algosdk.ABIType.from('string').encode(call.identity)],
    accounts: [call.payTo],
    foreignAssets: [call.usdcAssetId],
    boxes: [
      { appIndex: 0, name: identityBoxName(call.identity) },
      { appIndex: 0, name: balanceBoxName(call.identity) },
    ],
    suggestedParams,
  })
  return sendAndConfirm(algod, txn, account)
}
