// cli/src/donor.ts
//
// `aupm donor init|optin|status` (SPEC.md §11.4, ADR 0016). `init` creates a donor account and
// stores its key in the donor key file. On a terminal it then guides the donor one step at a
// time: it waits for Enter, checks the balance once, and sends the opt-in. Without a terminal,
// or with `--yes`, it prints the steps and exits. `optin` checks the balance once and sends one
// 0-amount USDC transfer to self straight to algod. `status` reads the state and names the
// next step. No command uses a timer or polls. The opt-in is not an x402 payment.
//
// The key file and the env var hold a 25-word or a 24-word phrase (ADR 0028). `init` makes a
// 25-word key.
//
// WARNING: never print or log the mnemonic or the secret key.
import readline from 'node:readline'
import type { Readable } from 'node:stream'
import algosdk from 'algosdk'
import { donorAlgodUrl } from 'aupm-mcp/donor'
import {
  AUPM_DONOR_MNEMONIC_ENV,
  donorKeyFilePath,
  loadDonorMnemonic,
  readDonorKeyFile,
  writeDonorKeyFile,
} from 'aupm-mcp/donor-key'
import { accountFromPhrase, type KeyAccount } from 'aupm-mcp/key-phrase'
import {
  ALGO_PENDING_LINE,
  ALGO_SUGGESTED_MICRO,
  addressLines,
  afterOptInStep,
  algoStep,
  backupLines,
  continueLines,
  currentNetwork,
  envNoticeLines,
  formatMicro,
  initNextSteps,
  type Network,
  optedInLines,
  optInRequiredMicro,
  PROMPT_ENTER_ALGO,
  PROMPT_RETRY_YES,
  PROMPT_YES,
  paint,
  type Snapshot,
  STOPPED_LINE,
  shortfallLines,
  statusLines,
  testnetNote,
  warningBlock,
} from './donor-text.js'
import { signTxn } from './sign.js'

const USAGE = [
  'Usage: aupm donor init [--yes] | optin | status',
  '  init     Make a donor wallet and show the next steps. --yes asks no questions.',
  '  optin    Let the wallet hold USDC.',
  '  status   Show the balances and the next step. This is the default.',
]

export interface DonorIo {
  out(line: string): void
  err(line: string): void
}

export interface DonorOptions {
  io?: DonorIo
  /** Where `init` reads the answers. Defaults to stdin. */
  input?: Readable
  /** True when `init` may ask questions. Defaults to: stdin and stdout are terminals. */
  interactive?: boolean
}

const consoleIo: DonorIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

function emit(io: DonorIo, lines: string[]): void {
  for (const line of lines) io.out(line)
}

async function accountOf(mnemonic: string): Promise<KeyAccount> {
  try {
    return await accountFromPhrase(mnemonic)
  } catch {
    const source = process.env[AUPM_DONOR_MNEMONIC_ENV]
      ? `the ${AUPM_DONOR_MNEMONIC_ENV} variable`
      : `the key file ${donorKeyFilePath()}`
    throw new Error(
      `The donor key is not a valid recovery phrase. Check ${source}. Nothing was sent.`,
    )
  }
}

async function envAddress(): Promise<string | null> {
  try {
    return (await accountOf(process.env[AUPM_DONOR_MNEMONIC_ENV] ?? '')).address
  } catch {
    return null
  }
}

async function envNotice(): Promise<string[]> {
  if (!process.env[AUPM_DONOR_MNEMONIC_ENV]) return []
  return ['', ...envNoticeLines(await envAddress())]
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

/** The reason of a failure. A fetch failure keeps its cause: `fetch failed` alone says nothing. */
function failureReason(error: unknown): string {
  const cause = error instanceof Error ? error.cause : undefined
  if (cause instanceof Error) return cause.message
  return error instanceof Error ? error.message : String(error)
}

async function sendOptIn(account: KeyAccount, network: Network) {
  const algod = newAlgod()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: account.address,
    receiver: account.address,
    amount: 0,
    assetIndex: BigInt(network.usdcAsset),
    suggestedParams: await algod.getTransactionParams().do(),
  })
  await algod.sendRawTransaction(await signTxn(account, txn)).do()
  try {
    await algosdk.waitForConfirmation(algod, txn.txID(), 4)
  } catch (error) {
    throw new Error(
      `The opt-in was sent but is not confirmed yet: ${failureReason(error)}. ` +
        'Run `aupm donor status` in a minute to check it.',
    )
  }
  return txn.txID()
}

async function runOptin(io: DonorIo, network: Network): Promise<number> {
  const account = await accountOf(loadDonorMnemonic())
  const snapshot = await readSnapshot(account.address, network.usdcAsset)
  emit(io, [...testnetNote(network), ...addressLines(snapshot.address, network), ''])
  if (snapshot.optedIn) {
    emit(io, [
      `The wallet is already opted in to USDC (ASA ${network.usdcAsset}).`,
      'Run `aupm donor status` for the next step.',
    ])
    return 0
  }
  if (snapshot.algo < snapshot.required) {
    const short = formatMicro(snapshot.required - snapshot.algo)
    io.err(`Cannot opt in to USDC yet. The wallet needs ${short} more ALGO. Nothing was sent.`)
    emit(io, [
      ...shortfallLines(snapshot, network),
      'Run `aupm donor optin` again when the ALGO arrives.',
    ])
    return 1
  }
  const txid = await sendOptIn(account, network)
  emit(io, optedInLines(txid, snapshot.address, network))
  return 0
}

async function runStatus(io: DonorIo, network: Network): Promise<number> {
  const file = donorKeyFilePath()
  const address = (await accountOf(loadDonorMnemonic())).address
  const snapshot = await readSnapshot(address, network.usdcAsset)
  const fileLine = process.env[AUPM_DONOR_MNEMONIC_ENV] ? [] : [`Key file: ${file}`]
  emit(io, [
    paint('bold', 'Donor wallet'),
    ...testnetNote(network),
    ...fileLine,
    ...(await envNotice()),
    '',
  ])
  emit(io, statusLines(snapshot, network))
  if (process.platform === 'win32') {
    io.out('')
    io.out('On Windows, the permissions of the key file are not protected.')
  }
  return 0
}

type Ask = () => Promise<string | null>

interface Session {
  io: DonorIo
  ask: Ask
  network: Network
}

/** Reads one line at a time. A closed input or Ctrl-C ends the questions: `ask` returns null. */
async function withAnswers(input: Readable, run: (ask: Ask) => Promise<number>): Promise<number> {
  const reader = readline.createInterface({ input, terminal: false })
  const lines = reader[Symbol.asyncIterator]()
  const stop = () => reader.close()
  process.on('SIGINT', stop)
  const ask: Ask = async () => {
    const next = await lines.next()
    return next.done ? null : next.value
  }
  try {
    return await run(ask)
  } finally {
    process.off('SIGINT', stop)
    reader.close()
  }
}

function stopped(io: DonorIo): number {
  io.out(STOPPED_LINE)
  return 0
}

async function waitForEnter({ io, ask }: Session): Promise<boolean> {
  io.out(PROMPT_ENTER_ALGO)
  return (await ask()) !== null
}

async function waitForYes({ io, ask }: Session): Promise<boolean> {
  io.out(PROMPT_YES)
  for (;;) {
    const answer = await ask()
    if (answer === null) return false
    if (answer.trim().toLowerCase() === 'yes') return true
    io.out(PROMPT_RETRY_YES)
  }
}

/** Checks the wallet once per Enter, sends the opt-in when the ALGO is there, then stops. */
async function guideFromState(
  session: Session,
  account: KeyAccount,
  afterEnter: boolean,
): Promise<number> {
  const { io, network } = session
  for (let pressedEnter = afterEnter; ; pressedEnter = true) {
    const snapshot = await readSnapshot(account.address, network.usdcAsset)
    if (snapshot.optedIn) {
      emit(io, ['', ...afterOptInStep(snapshot, network)])
      return 0
    }
    if (snapshot.algo >= snapshot.required) {
      const txid = await sendOptIn(account, network)
      emit(io, ['', ...optedInLines(txid, snapshot.address, network)])
      return 0
    }
    emit(io, [
      '',
      ...(pressedEnter ? [ALGO_PENDING_LINE] : []),
      ...shortfallLines(snapshot, network),
    ])
    if (!(await waitForEnter(session))) return stopped(io)
  }
}

async function guideNewWallet(
  session: Session,
  file: string,
  account: KeyAccount,
): Promise<number> {
  const { io, network } = session
  const { address } = account
  emit(io, [
    'Created the donor wallet.',
    ...testnetNote(network),
    ...warningBlock(file, process.platform === 'win32'),
    '',
    ...addressLines(address, network),
    ...(await envNotice()),
    '',
    ...backupLines(file),
  ])
  if (!(await waitForYes(session))) return stopped(io)
  emit(io, ['', ...algoStep('Step 1.', address, network, ALGO_SUGGESTED_MICRO, true)])
  if (!(await waitForEnter(session))) return stopped(io)
  return await guideFromState(session, account, true)
}

async function guideExistingWallet(session: Session, file: string): Promise<number> {
  const account = await accountOf(loadDonorMnemonic())
  emit(session.io, [
    ...continueLines(file, account.address, session.network),
    ...(await envNotice()),
  ])
  return await guideFromState(session, account, false)
}

async function createWallet(): Promise<KeyAccount> {
  const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk)
  writeDonorKeyFile(mnemonic)
  return await accountOf(mnemonic)
}

async function printHeadlessInit(io: DonorIo, network: Network, account: KeyAccount) {
  const file = donorKeyFilePath()
  const { address } = account
  emit(io, [
    'Created the donor wallet.',
    ...testnetNote(network),
    ...warningBlock(file, process.platform === 'win32'),
    '',
    ...addressLines(address, network),
    ...(await envNotice()),
    ...initNextSteps(address, network, process.platform === 'win32', file),
  ])
}

async function runInit(io: DonorIo, network: Network, options: InitOptions): Promise<number> {
  const file = donorKeyFilePath()
  const exists = readDonorKeyFile() !== null
  if (!options.interactive) {
    if (exists) return await runStatus(io, network)
    await printHeadlessInit(io, network, await createWallet())
    return 0
  }
  return await withAnswers(options.input, async (ask) => {
    const session: Session = { io, ask, network }
    if (exists) return await guideExistingWallet(session, file)
    return await guideNewWallet(session, file, await createWallet())
  })
}

interface InitOptions {
  input: Readable
  interactive: boolean
}

function isInteractive(options: DonorOptions, yes: boolean): boolean {
  if (yes) return false
  return options.interactive ?? (process.stdin.isTTY === true && process.stdout.isTTY === true)
}

function validArguments(subcommand: string, rest: string[]): boolean {
  if (!['init', 'optin', 'status'].includes(subcommand)) return false
  if (subcommand === 'init') return rest.length === 0 || (rest.length === 1 && rest[0] === '--yes')
  return rest.length === 0
}

/** A fetch failure means the Algorand node was unreachable. Other errors keep their message. */
function describeFailure(error: unknown): string {
  if (error instanceof TypeError) {
    return (
      `Cannot reach the Algorand node (${donorAlgodUrl()}): ${failureReason(error)}. ` +
      'Check your network and run the command again. Nothing was sent.'
    )
  }
  return error instanceof Error ? error.message : String(error)
}

/** Runs `aupm donor <init|optin|status>`. Returns the process exit code. */
export async function runDonor(argv: string[], options: DonorOptions = {}): Promise<number> {
  const [subcommand = 'status', ...rest] = argv
  const io = options.io ?? consoleIo
  if (!validArguments(subcommand, rest)) {
    io.err(USAGE.join('\n'))
    return 1
  }
  const network = currentNetwork()
  try {
    if (subcommand === 'init') {
      const interactive = isInteractive(options, rest.includes('--yes'))
      return await runInit(io, network, { interactive, input: options.input ?? process.stdin })
    }
    if (subcommand === 'optin') return await runOptin(io, network)
    return await runStatus(io, network)
  } catch (error) {
    io.err(describeFailure(error))
    return 1
  }
}
