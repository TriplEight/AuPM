// cli/src/auditor-chain.ts
//
// The chain side of the auditor commands: box reads, the claim() checks and the two
// transactions. It ports scripts/claim.mjs and the former anchor script. Every send goes to
// algod. The facilitator is not involved (the anchor and the claim are the auditor's own).
import algosdk from 'algosdk'
import type { KeyAccount } from 'aupm-mcp/key-phrase'
import { describeMicroUsdc, formatMicro } from './donor-text.js'
import { signTxn } from './sign.js'

export const MIN_CLAIM_FEE = 2_000
export const CLAIM_METHOD_SIGNATURE = 'claim(string)void'

export type NetworkName = 'mainnet' | 'testnet'

const GENESIS_ID: Record<NetworkName, string> = {
  mainnet: 'mainnet-v1.0',
  testnet: 'testnet-v1.0',
}

export function loraLink(network: NetworkName, txid: string): string {
  return `https://lora.algokit.io/${network}/transaction/${txid}`
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
      `The Algorand node is on network "${genesisId}". The AuPM server uses ${network}. ` +
        `Unset ALGOD_MAINNET_URL and ALGOD_TESTNET_URL, or set them to a ${network} node.`,
    )
  }
}

/** Throws unless `signer` is the address mapped to the login. */
export function assertMappedSigner(mapped: string | null, signer: string, login: string): void {
  if (!mapped) {
    throw new Error(
      `No wallet address is linked to the GitHub login ${login}. ` +
        'Ask the AuPM ops to link your address in your auditor application issue.',
    )
  }
  if (mapped !== signer) {
    throw new Error(
      `The phrase you typed belongs to address ${signer}. ` +
        `AuPM expects address ${mapped} for ${login}. Type the phrase of address ${mapped}. ` +
        `For a Pera wallet with several accounts, add \`--address ${mapped}\`.`,
    )
  }
}

/** Throws unless the claim() checks pass. The messages match scripts/claim.mjs. */
export function assertClaimable(args: {
  balance: bigint
  minClaim: number
  mapped: string | null
  signer: string
  login: string
  usdcAssetId: number
  facts: AccountFacts
}): void {
  const { balance, minClaim, mapped, signer, login, usdcAssetId, facts } = args
  assertMappedSigner(mapped, signer, login)
  if (balance < BigInt(minClaim)) {
    throw new Error(
      `Your balance is ${describeMicroUsdc(balance)}. ` +
        `The minimum claim is ${describeMicroUsdc(BigInt(minClaim))}. ` +
        `Wait for more donations. Check with: aupm auditor balance ${login}`,
    )
  }
  if (!facts.optedIn) {
    throw new Error(
      `Address ${signer} has not opted in to USDC (asset id ${usdcAssetId}). ` +
        'Opt in with your wallet app. Then run `aupm auditor claim` again.',
    )
  }
  if (facts.algoAvailable < BigInt(MIN_CLAIM_FEE)) {
    const free = facts.algoAvailable > 0n ? facts.algoAvailable : 0n
    throw new Error(
      `Address ${signer} has ${formatMicro(free)} ALGO free. ` +
        `The claim fee is ${formatMicro(BigInt(MIN_CLAIM_FEE))} ALGO. ` +
        `Send at least ${formatMicro(BigInt(MIN_CLAIM_FEE) - free)} ALGO to ${signer}, ` +
        'then run the command again.',
    )
  }
}

async function sendAndConfirm(
  algod: algosdk.Algodv2,
  txn: algosdk.Transaction,
  account: KeyAccount,
  network: NetworkName,
) {
  await algod.sendRawTransaction(await signTxn(account, txn)).do()
  const txid = txn.txID()
  try {
    await algosdk.waitForConfirmation(algod, txid, 6)
  } catch {
    throw new Error(
      'The transaction was sent but is not confirmed yet. ' +
        `Check ${loraLink(network, txid)} before you send it again.`,
    )
  }
  return txid
}

/** Sends the review anchor: a 0-ALGO payment from the auditor to itself with the note. */
export async function sendAnchor(
  algod: algosdk.Algodv2,
  account: KeyAccount,
  note: Uint8Array,
  network: NetworkName,
): Promise<string> {
  const { address } = account
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    note,
    suggestedParams: await algod.getTransactionParams().do(),
  })
  return sendAndConfirm(algod, txn, account, network)
}

/** Sends one claim(identity) call. The outer fee pools the inner transfer fee. */
export async function sendClaim(
  algod: algosdk.Algodv2,
  account: KeyAccount,
  call: {
    appId: number
    identity: string
    payTo: string
    usdcAssetId: number
    network: NetworkName
  },
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
  return sendAndConfirm(algod, txn, account, call.network)
}
