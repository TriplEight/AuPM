// cli/src/donor.ts
//
// `aupm donor init [--timeout <minutes>]` and `aupm donor optin [--timeout <minutes>]`
// (SPEC.md §11.4, ADR 0016). `init` creates a donor account, stores its key in the donor env
// file and then runs `optin`. `optin` waits for the ALGO that the opt-in needs and sends one
// 0-amount USDC transfer to self straight to algod. That transaction is not an x402 payment.
//
// WARNING: never print or log the mnemonic or the secret key.
import algosdk from 'algosdk'
import { donorAlgodUrl, IS_TESTNET, USDC_ASSET_ID } from 'aupm-mcp/donor'
import { loadDonorMnemonic, writeDonorEnvFile } from 'aupm-mcp/donor-key'
import { renderUnicodeCompact } from 'uqr'

const USAGE = 'Usage: aupm donor init|optin [--timeout <minutes>]'
const DEFAULT_TIMEOUT_MINUTES = 15
const DEFAULT_POLL_MS = 5_000
const ASA_MIN_BALANCE_INCREASE = 100_000n
const OPT_IN_FEE = 1_000n

export interface DonorIo {
  out(line: string): void
  err(line: string): void
}

export interface DonorOptions {
  io?: DonorIo
  pollIntervalMs?: number
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

const consoleIo: DonorIo = {
  out: (line) => console.log(line),
  err: (line) => console.error(line),
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms)
    signal.addEventListener('abort', done, { once: true })
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
  })
}

/** Formats integer microALGO as an ALGO decimal string, with no floats. */
function formatAlgo(micro: bigint): string {
  const whole = micro / 1_000_000n
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0')
  return `${whole}.${fraction}`
}

function parseTimeoutMinutes(args: string[]): number {
  const index = args.indexOf('--timeout')
  if (index === -1) return DEFAULT_TIMEOUT_MINUTES
  const value = args[index + 1] ?? ''
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`--timeout needs a positive whole number of minutes. ${USAGE}`)
  }
  return Number(value)
}

interface OptInContext {
  algod: algosdk.Algodv2
  address: string
  secretKey: Uint8Array
  io: DonorIo
  signal: AbortSignal
  deadline: number
  pollIntervalMs: number
  now: () => number
  sleep: (ms: number, signal: AbortSignal) => Promise<void>
}

function fundingLines(address: string, neededMicro: bigint): string[] {
  const network = IS_TESTNET ? 'TestNet' : 'MainNet'
  return [
    `Fund ${address} on Algorand ${network}:`,
    `  - at least ${formatAlgo(neededMicro)} ALGO (minimum balance with one asset plus the opt-in fee)`,
    `  - then USDC (ASA ${USDC_ASSET_ID}) for donations`,
  ]
}

async function submitOptIn(context: OptInContext): Promise<void> {
  const { algod, address, secretKey } = context
  const suggestedParams = await algod.getTransactionParams().do()
  const txn = algosdk.makeAssetTransferTxnWithSuggestedParamsFromObject({
    sender: address,
    receiver: address,
    amount: 0,
    assetIndex: BigInt(USDC_ASSET_ID),
    suggestedParams,
  })
  await algod.sendRawTransaction(txn.signTxn(secretKey)).do()
  await algosdk.waitForConfirmation(algod, txn.txID(), 4)
  context.io.out(`Opted in to USDC (ASA ${USDC_ASSET_ID}). Transaction ${txn.txID()}.`)
}

// Returns the exit code, or null to keep polling.
async function pollOnce(
  context: OptInContext,
  announced: { value: boolean },
): Promise<number | null> {
  const info = await context.algod.accountInformation(context.address).do()
  const optedIn = (info.assets ?? []).some((asset) => asset.assetId === BigInt(USDC_ASSET_ID))
  if (optedIn) {
    context.io.out(`Donor is already opted in to USDC (ASA ${USDC_ASSET_ID}).`)
    return 0
  }
  const needed = info.minBalance + ASA_MIN_BALANCE_INCREASE + OPT_IN_FEE
  if (info.amount >= needed) {
    await submitOptIn(context)
    return 0
  }
  if (context.now() >= context.deadline) {
    context.io.err('Timed out while waiting for ALGO.')
    for (const line of fundingLines(context.address, needed)) context.io.err(line)
    return 1
  }
  if (!announced.value) {
    announced.value = true
    context.io.out(`Waiting for ${formatAlgo(needed)} ALGO on ${context.address} ...`)
  }
  return null
}

async function waitAndOptIn(context: OptInContext): Promise<number> {
  const announced = { value: false }
  while (!context.signal.aborted) {
    const exitCode = await pollOnce(context, announced)
    if (exitCode !== null) return exitCode
    await context.sleep(context.pollIntervalMs, context.signal)
  }
  context.io.out('Stopped. Run `aupm donor optin` to continue.')
  return 0
}

async function optInWithMnemonic(
  mnemonic: string,
  timeoutMinutes: number,
  options: DonorOptions,
): Promise<number> {
  const io = options.io ?? consoleIo
  const now = options.now ?? Date.now
  const { addr, sk } = algosdk.mnemonicToSecretKey(mnemonic)
  const controller = new AbortController()
  const onSigint = (): void => controller.abort()
  process.once('SIGINT', onSigint)
  try {
    return await waitAndOptIn({
      algod: new algosdk.Algodv2('', donorAlgodUrl(), ''),
      address: addr.toString(),
      secretKey: sk,
      io,
      signal: controller.signal,
      deadline: now() + timeoutMinutes * 60_000,
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_POLL_MS,
      now,
      sleep: options.sleep ?? defaultSleep,
    })
  } finally {
    process.removeListener('SIGINT', onSigint)
  }
}

function runInit(io: DonorIo): { mnemonic: string } {
  const account = algosdk.generateAccount()
  const mnemonic = algosdk.secretKeyToMnemonic(account.sk)
  const file = writeDonorEnvFile(mnemonic)
  const address = account.addr.toString()
  const uri = `algorand://${address}`
  io.out(`Donor address: ${address}`)
  io.out(`Key file (0600): ${file}`)
  io.out(`Payment URI (ARC-26): ${uri}`)
  io.out(renderUnicodeCompact(uri))
  for (const line of fundingLines(address, ASA_MIN_BALANCE_INCREASE * 2n + OPT_IN_FEE)) {
    io.out(line)
  }
  return { mnemonic }
}

/** Runs `aupm donor <init|optin>`. Returns the process exit code. */
export async function runDonor(argv: string[], options: DonorOptions = {}): Promise<number> {
  const [subcommand, ...rest] = argv
  const io = options.io ?? consoleIo
  if (subcommand !== 'init' && subcommand !== 'optin') {
    io.err(USAGE)
    return 1
  }
  try {
    const timeoutMinutes = parseTimeoutMinutes(rest)
    if (subcommand === 'init') {
      const { mnemonic } = runInit(io)
      return await optInWithMnemonic(mnemonic, timeoutMinutes, options)
    }
    return await optInWithMnemonic(loadDonorMnemonic(), timeoutMinutes, options)
  } catch (error) {
    io.err(error instanceof Error ? error.message : String(error))
    return 1
  }
}
