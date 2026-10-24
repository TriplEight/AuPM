// cli/src/auditor-chain.ts
//
// The chain side of the auditor commands: the USDC holding read and the review anchor. Every
// send goes to algod. The facilitator is not involved (the anchor is the auditor's own).
import algosdk from 'algosdk'
import type { KeyAccount } from 'aupm-mcp/key-phrase'
import { signTxn } from './sign.js'

export type NetworkName = 'mainnet' | 'testnet'

const GENESIS_ID: Record<NetworkName, string> = {
  mainnet: 'mainnet-v1.0',
  testnet: 'testnet-v1.0',
}

export function loraLink(network: NetworkName, txid: string): string {
  return `https://lora.algokit.io/${network}/transaction/${txid}`
}

export interface AccountFacts {
  optedIn: boolean
  frozen: boolean
}

/** The USDC opt-in and the frozen state of the USDC holding of `address`. */
export async function readAccountFacts(
  algod: algosdk.Algodv2,
  address: string,
  usdcAssetId: number,
): Promise<AccountFacts> {
  const info = await algod.accountInformation(address).do()
  const holding = (info.assets ?? []).find((asset) => asset.assetId === BigInt(usdcAssetId))
  return { optedIn: holding !== undefined, frozen: holding?.isFrozen === true }
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
