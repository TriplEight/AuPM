// cli/src/donor.ts
//
// `aupm donor init|optin|status` (SPEC.md §11.4, ADR 0016). `init` creates a donor account and
// stores its key in the donor env file. `optin` checks the balance once and sends one 0-amount
// USDC transfer to self straight to algod. `status` reads the state and names the next step.
// No command waits or polls. The opt-in is not an x402 payment.
//
// WARNING: never print or log the mnemonic or the secret key.
import algosdk from 'algosdk'
import { donorAlgodUrl } from 'aupm-mcp/donor'
import {
  AUPM_DONOR_MNEMONIC_ENV,
  donorEnvFilePath,
  loadDonorMnemonic,
  readDonorEnvFile,
  writeDonorEnvFile,
} from 'aupm-mcp/donor-key'
import {
  addressLines,
  algoStep,
  currentNetwork,
  envNoticeLines,
  existingFileLines,
  formatMicro,
  initNextSteps,
  type Network,
  optInRequiredMicro,
  paint,
  type Snapshot,
  statusLines,
  usdcStep,
  warningBlock,
} from './donor-text.js'

const USAGE = 'Usage: aupm donor [init|optin|status]'

export interface DonorIo {
  out(line: string): void
  err(line: string): void
}

export interface DonorOptions {
  io?: DonorIo
}

const consoleIo: DonorIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

function emit(io: DonorIo, lines: string[]): void {
  for (const line of lines) io.out(line)
}

function accountOf(mnemonic: string): algosdk.Account {
  try {
    return algosdk.mnemonicToSecretKey(mnemonic)
  } catch {
    throw new Error('The donor key is not a valid 25-word mnemonic. Nothing was printed or sent.')
  }
}

function addressOf(mnemonic: string): string {
  return accountOf(mnemonic).addr.toString()
}

function envAddress(): string | null {
  try {
    return addressOf(process.env[AUPM_DONOR_MNEMONIC_ENV] ?? '')
  } catch {
    return null
  }
}

function envNotice(): string[] {
  if (!process.env[AUPM_DONOR_MNEMONIC_ENV]) return []
  return ['', ...envNoticeLines(envAddress())]
}

function newAlgod(): algosdk.Algodv2 {
  return new algosdk.Algodv2('', donorAlgodUrl(), '')
}

async function readSnapshot(address: string, usdcAsset: string): Promise<Snapshot> {
  const info = await newAlgod().accountInformation(address).do()
  const holding = (info.assets ?? []).find((asset) => asset.assetId === BigInt(usdcAsset))
  return {
    address,
    algo: info.amount,
    required: optInRequiredMicro(info.minBalance),
    optedIn: holding !== undefined,
    usdc: holding?.amount ?? 0n,
  }
}

function runInit(io: DonorIo, network: Network): number {
  const file = donorEnvFilePath()
  const existing = readDonorEnvFile()
  if (existing !== null) {
    emit(io, [...existingFileLines(file, addressOf(existing)), ...envNotice()])
    return 1
  }
  const account = algosdk.generateAccount()
  writeDonorEnvFile(algosdk.secretKeyToMnemonic(account.sk))
  const address = account.addr.toString()
  emit(io, [
    'Created the donor wallet.',
    '',
    ...warningBlock(file, process.platform === 'win32'),
    '',
    ...addressLines(address, network),
    ...envNotice(),
    '',
    ...initNextSteps(address, network),
  ])
  return 0
}

async function sendOptIn(address: string, secretKey: Uint8Array, network: Network) {
  const algod = newAlgod()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    assetIndex: BigInt(network.usdcAsset),
    suggestedParams: await algod.getTransactionParams().do(),
  })
  await algod.sendRawTransaction(txn.signTxn(secretKey)).do()
  await algosdk.waitForConfirmation(algod, txn.txID(), 4)
  return txn.txID()
}

async function runOptin(io: DonorIo, network: Network): Promise<number> {
  const { addr, sk } = accountOf(loadDonorMnemonic())
  const snapshot = await readSnapshot(addr.toString(), network.usdcAsset)
  if (snapshot.optedIn) {
    io.out(`The wallet is already opted in to USDC (ASA ${network.usdcAsset}).`)
    io.out('Run `aupm donor status` to see the next step.')
    return 0
  }
  if (snapshot.algo < snapshot.required) {
    const short = snapshot.required - snapshot.algo
    io.err('The wallet has too little ALGO to opt in. Nothing was sent.')
    emit(io, [
      `ALGO balance: ${formatMicro(snapshot.algo)} ALGO. Needed: ${formatMicro(snapshot.required)} ALGO.`,
      `Shortfall: ${formatMicro(short)} ALGO.`,
      '',
      ...algoStep('Next step.', snapshot.address, network, short),
      '',
      'Run `aupm donor optin` again after the ALGO arrives.',
    ])
    return 1
  }
  const txid = await sendOptIn(snapshot.address, sk, network)
  emit(io, [
    `Opted in to USDC (ASA ${network.usdcAsset}). Transaction: ${txid}`,
    `Explorer: https://lora.algokit.io/${network.explorer}/transaction/${txid}`,
    '',
    ...usdcStep('Next step.', snapshot.address, network),
  ])
  return 0
}

async function runStatus(io: DonorIo, network: Network): Promise<number> {
  const file = donorEnvFilePath()
  const address = addressOf(loadDonorMnemonic())
  const snapshot = await readSnapshot(address, network.usdcAsset)
  const fileLine = process.env[AUPM_DONOR_MNEMONIC_ENV] ? [] : [`Key file: ${file}`]
  emit(io, [paint('bold', 'Donor wallet'), ...fileLine, ...envNotice(), ''])
  emit(io, statusLines(snapshot, network))
  if (process.platform === 'win32') {
    io.out('')
    io.out('On Windows, the permissions of the key file are not protected.')
  }
  return 0
}

/** Runs `aupm donor <init|optin|status>`. Returns the process exit code. */
export async function runDonor(argv: string[], options: DonorOptions = {}): Promise<number> {
  const [subcommand = 'status', ...rest] = argv
  const io = options.io ?? consoleIo
  if (rest.length > 0 || !['init', 'optin', 'status'].includes(subcommand)) {
    io.err(USAGE)
    return 1
  }
  const network = currentNetwork()
  try {
    if (subcommand === 'init') return runInit(io, network)
    if (subcommand === 'optin') return await runOptin(io, network)
    return await runStatus(io, network)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}
