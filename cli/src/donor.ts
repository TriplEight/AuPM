// cli/src/donor.ts
//
// `aupm donor init|optin|status`. `init` creates a donor account. On a
// terminal it shows the 25 words once, saves the key file only after the donor types yes, then
// guides the donor one step at a time: it waits for Enter, checks the balance once, sends the
// opt-in, and waits for the USDC. Without a terminal, or with `--yes`, it saves the key file,
// prints the steps and exits. `optin` checks the balance once and sends one
// 0-amount USDC transfer to self straight to algod. `status` reads the state and names the
// next step. No command uses a timer or polls. The opt-in is not an x402 payment.
//
// The key file and the env var hold a 25-word or a 24-word phrase. `init` makes a
// 25-word key.
//
// WARNING: never print or log the mnemonic or the secret key. The one exception is the backup
// screen of a terminal `init`: it prints the words once through `io.secret`.
import readline from 'node:readline'
import type { Readable } from 'node:stream'
import algosdk from 'algosdk'
import {
  ConfigError,
  parseMultiplier,
  resolveMultiplier,
  writeConfigMultiplier,
} from 'aupm-mcp/config'
import { donorAlgodUrl } from 'aupm-mcp/donor'
import {
  AUPM_DONOR_MNEMONIC_ENV,
  donorKeyFilePath,
  loadDonorMnemonic,
  readDonorKeyFile,
  writeDonorKeyFile,
} from 'aupm-mcp/donor-key'
import { accountFromPhrase, type KeyAccount } from 'aupm-mcp/key-phrase'
import { donateSettingLine } from './config.js'
import {
  ALGO_PENDING_LINE,
  ALGO_SUGGESTED_MICRO,
  addressLines,
  algoStep,
  allSetLines,
  backupIntroLines,
  backupOutroLines,
  continueLines,
  currentNetwork,
  donateStep,
  envNoticeLines,
  formatMicro,
  initNextSteps,
  multiplierPromptLines,
  type Network,
  optedInLines,
  optInRequiredMicro,
  PROMPT_ENTER_ALGO,
  PROMPT_ENTER_USDC,
  PROMPT_MULTIPLIER,
  PROMPT_RETRY_MULTIPLIER,
  PROMPT_RETRY_YES,
  PROMPT_YES,
  paint,
  type Snapshot,
  STOPPED_LINE,
  STOPPED_UNSAVED_LINE,
  savedLines,
  shortfallLines,
  statusLines,
  testnetNote,
  USDC_PENDING_LINE,
  usdcArrivedLines,
  usdcStep,
  warningBlock,
  wordRows,
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
  /** Raw text for the backup screen only: the 25 words. The console io drops it without a TTY. */
  secret(text: string): void
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
  secret: (text) => {
    if (process.stdout.isTTY === true) process.stdout.write(text)
  },
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

function stopped(io: DonorIo, line = STOPPED_LINE): number {
  io.out(line)
  return 0
}

async function waitForEnter({ io, ask }: Session, prompt = PROMPT_ENTER_ALGO): Promise<boolean> {
  io.out(prompt)
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

/** Asks for the multiplier until the answer is valid, then writes it. An empty answer asks again. */
async function askMultiplier({ io, ask }: Session): Promise<boolean> {
  emit(io, [...multiplierPromptLines(), ''])
  io.out(PROMPT_MULTIPLIER)
  for (;;) {
    const answer = await ask()
    if (answer === null) return false
    try {
      const file = writeConfigMultiplier(parseMultiplier(answer))
      emit(io, [`Multiplier saved to ${file}.`, ''])
      return true
    } catch (error) {
      if (!(error instanceof ConfigError)) throw error
      if (answer.trim() !== '') io.out(error.message)
      io.out(PROMPT_RETRY_MULTIPLIER)
    }
  }
}

/** The line of the donate setting. A malformed config file gives its message instead. */
function donateSetting(): string {
  try {
    return donateSettingLine()
  } catch (error) {
    if (error instanceof ConfigError) return `donate cannot be read. ${error.message}`
    throw error
  }
}

/** Waits for the USDC after the opt-in. Returns an exit code, or null to check the balance. */
async function waitForUsdc(session: Session, snapshot: Snapshot, pressed: boolean) {
  const { io, network } = session
  const lines = pressed ? [USDC_PENDING_LINE] : usdcStep('Next step.', snapshot.address, network)
  emit(io, ['', ...lines])
  return (await waitForEnter(session, PROMPT_ENTER_USDC)) ? null : stopped(io)
}

/** One check of the wallet. Returns an exit code, or null when the donor must act and press Enter. */
async function guideStep(
  session: Session,
  account: KeyAccount,
  snapshot: Snapshot,
  pressed: boolean,
): Promise<number | null> {
  const { io, network } = session
  if (snapshot.optedIn && snapshot.usdc > 0n) {
    emit(io, ['', ...usdcArrivedLines(snapshot), '', ...donateStep('Next step.')])
    return 0
  }
  if (snapshot.optedIn) return await waitForUsdc(session, snapshot, pressed)
  if (snapshot.algo >= snapshot.required) {
    const txid = await sendOptIn(account, network)
    emit(io, ['', ...optedInLines(txid, snapshot.address, network)])
    return (await waitForEnter(session, PROMPT_ENTER_USDC)) ? null : stopped(io)
  }
  emit(io, ['', ...(pressed ? [ALGO_PENDING_LINE] : []), ...shortfallLines(snapshot, network)])
  return (await waitForEnter(session)) ? null : stopped(io)
}

/** Checks the wallet once per Enter. It sends the opt-in when the ALGO is there. */
async function guideFromState(
  session: Session,
  account: KeyAccount,
  afterEnter: boolean,
  first?: Snapshot,
): Promise<number> {
  let snapshot = first
  for (let pressed = afterEnter; ; pressed = true) {
    snapshot ??= await readSnapshot(account.address, session.network.usdcAsset)
    const code = await guideStep(session, account, snapshot, pressed)
    if (code !== null) return code
    snapshot = undefined
  }
}

const SCREEN_ON = '\u001b[?1049h'
const SCREEN_OFF = '\u001b[?1049l'

/** True when the terminal can show and then drop the backup screen. */
function canSwitchScreen(): boolean {
  return process.stdout.isTTY === true && process.env.TERM !== 'dumb'
}

/**
 * Shows the 25 words once and asks for yes. The words go to `io.secret` only, on the alternate
 * screen when the terminal has one. They leave the screen when the donor answers.
 */
async function showBackup(session: Session, mnemonic: string): Promise<boolean> {
  const { io } = session
  const switched = canSwitchScreen()
  if (switched) io.secret(SCREEN_ON)
  try {
    emit(io, backupIntroLines())
    for (const row of wordRows(mnemonic)) io.secret(`${row}\n`)
    emit(io, backupOutroLines())
    return await waitForYes(session)
  } finally {
    if (switched) io.secret(SCREEN_OFF)
  }
}

async function guideNewWallet(session: Session, file: string): Promise<number> {
  const { io, network } = session
  const mnemonic = algosdk.secretKeyToMnemonic(algosdk.generateAccount().sk)
  const account = await accountOf(mnemonic)
  emit(io, [
    'Making a new donor wallet. The key file is not saved yet.',
    ...testnetNote(network),
    ...warningBlock(file, process.platform === 'win32'),
    '',
    ...addressLines(account.address, network),
    ...(await envNotice()),
    '',
  ])
  if (!(await showBackup(session, mnemonic))) return stopped(io, STOPPED_UNSAVED_LINE)
  writeDonorKeyFile(mnemonic)
  emit(io, ['', ...savedLines(file), '', ...addressLines(account.address, network), ''])
  emit(io, algoStep('Step 1.', account.address, network, ALGO_SUGGESTED_MICRO, true))
  if (!(await waitForEnter(session))) return stopped(io)
  return await guideFromState(session, account, true)
}

async function guideExistingWallet(session: Session, file: string): Promise<number> {
  const { io, network } = session
  const account = await accountOf(loadDonorMnemonic())
  const snapshot = await readSnapshot(account.address, network.usdcAsset)
  if (snapshot.optedIn && snapshot.usdc > 0n) {
    emit(io, [...allSetLines(snapshot, network, donateSetting()), ...(await envNotice())])
    return 0
  }
  emit(io, [...continueLines(file, account.address, network), ...(await envNotice())])
  return await guideFromState(session, account, false, snapshot)
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
    if (resolveMultiplier().source === 'default' && !(await askMultiplier(session))) {
      return stopped(io)
    }
    if (exists) return await guideExistingWallet(session, file)
    return await guideNewWallet(session, file)
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
