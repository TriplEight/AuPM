// cli/src/donor-text.ts
//
// The words that `aupm donor` prints. Every function returns lines.
// No function reads a key. No function prints the mnemonic.
import { styleText } from 'node:util'
import { EXPLORER_NETWORK, IS_TESTNET, PRICE_PER_ENTRY_MICRO, USDC_ASSET_ID } from 'aupm-mcp/donor'
import { renderUnicodeCompact } from 'uqr'

export const ALGO_MINIMUM_MICRO = 201_000n
export const ALGO_SUGGESTED_MICRO = 300_000n
export const USDC_SUGGESTED_MICRO = 1_000_000n
const ACCOUNT_MIN_BALANCE_MICRO = 100_000n
const ASA_MIN_BALANCE_INCREASE_MICRO = 100_000n
const OPT_IN_FEE_MICRO = 1_000n

const GITHUB_SECRETS_PATH = 'Settings > Secrets and variables > Actions > New repository secret'

export interface Network {
  testnet: boolean
  name: 'MainNet' | 'TestNet'
  usdcAsset: string
  explorer: string
  ciSecret: string
}

export function currentNetwork(): Network {
  return networkFor(IS_TESTNET, String(USDC_ASSET_ID), EXPLORER_NETWORK)
}

export function networkFor(testnet: boolean, usdcAsset: string, explorer: string): Network {
  return {
    testnet,
    name: testnet ? 'TestNet' : 'MainNet',
    usdcAsset,
    explorer,
    ciSecret: testnet ? 'AUPM_DONOR_MNEMONIC_TESTNET' : 'AUPM_DONOR_MNEMONIC_MAINNET',
  }
}

/** Formats integer micro-units (6 decimals), trailing zeros removed, with no floats. */
export function formatMicro(micro: bigint): string {
  const whole = micro / 1_000_000n
  const fraction = (micro % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '')
  return fraction === '' ? `${whole}` : `${whole}.${fraction}`
}

/** `Base 0.001 USDC (x0.1). Multiplier x1. Total 0.01 USDC.` The base is the price at x0.1. */
export function receiptLine(
  multiplierLabel: string,
  totalMicro: number,
  baseMicro: number = PRICE_PER_ENTRY_MICRO,
): string {
  return (
    `Base ${formatMicro(BigInt(baseMicro))} USDC (x0.1). ` +
    `Multiplier ${multiplierLabel}. Total ${formatMicro(BigInt(totalMicro))} USDC.`
  )
}

/** `100,000 microUSDC (0.1 USDC)`. Integer math only. */
export function describeMicroUsdc(micro: bigint): string {
  return `${micro.toLocaleString('en-US')} microUSDC (${formatMicro(micro)} USDC)`
}

/** ALGO the account needs before it can opt in to USDC, from algod's minimum balance. */
export function optInRequiredMicro(minBalance: bigint): bigint {
  const base = minBalance > ACCOUNT_MIN_BALANCE_MICRO ? minBalance : ACCOUNT_MIN_BALANCE_MICRO
  return base + ASA_MIN_BALANCE_INCREASE_MICRO + OPT_IN_FEE_MICRO
}

/** How many reviewed packages a USDC balance pays for. */
export function packagesCovered(usdcMicro: bigint): bigint {
  return usdcMicro / BigInt(PRICE_PER_ENTRY_MICRO)
}

/** ARC-26 payment URI. `amount` is in micro-units of ALGO, or of the asset when `asset` is set. */
export function arc26Uri(address: string, amount: bigint, asset?: string): string {
  const query = asset === undefined ? `amount=${amount}` : `amount=${amount}&asset=${asset}`
  return `algorand://${address}?${query}`
}

type Style = 'bold' | 'yellow' | 'green' | 'cyan'

/** Colors a line for stdout. `styleText` checks the stream, NO_COLOR and FORCE_COLOR. */
export function paint(style: Style | Style[], text: string): string {
  return styleText(style, text, { stream: process.stdout, validateStream: true })
}

const LINE_WIDTH = 80
const BODY_INDENT = '   '
const COMMAND_INDENT = '     '

/** Breaks prose at spaces so that no line is longer than 80 characters. */
export function wrap(text: string, indent = BODY_INDENT, firstIndent = indent): string[] {
  const lines: string[] = []
  let line = ''
  let prefix = firstIndent
  for (const word of text.split(' ')) {
    if (line !== '' && prefix.length + line.length + 1 + word.length > LINE_WIDTH) {
      lines.push(`${prefix}${line}`)
      prefix = indent
      line = word
    } else {
      line = line === '' ? word : `${line} ${word}`
    }
  }
  if (line !== '') lines.push(`${prefix}${line}`)
  return lines
}

/** A step: the bold heading and the intro on wrapped lines, then the body. */
function step(label: string, heading: string, intro: string, body: string[]): string[] {
  const title = `${label} ${heading}`
  const [first = '', ...rest] = wrap(`${title} ${intro}`.trim(), BODY_INDENT, '')
  return [first.replace(title, paint('bold', title)), ...rest, ...body]
}

function qrLines(uri: string): string[] {
  return [...renderUnicodeCompact(uri).split('\n'), uri]
}

export function warningBlock(file: string, windows: boolean): string[] {
  const rule = '='.repeat(64)
  const lines = [
    paint(['bold', 'yellow'], rule),
    paint(['bold', 'yellow'], 'PLEASE READ. THIS PROTECTS YOUR FUNDS.'),
    paint(['bold', 'yellow'], rule),
    'This file holds the secret key of your donor wallet (25 words):',
    `  ${file}`,
    '- The key is stored on this computer. Any program that runs as your user',
    '  can spend the funds.',
    '- Keep only small amounts here. 1 USDC pays for 1,000 reviewed packages at x0.1.',
    '- This file is the only copy. Back up the 25 words offline: on paper,',
    '  or on an external drive.',
    '- Never paste the key into a chat, an issue or a log.',
  ]
  if (windows) lines.push('- On Windows, the permissions of this file are not protected.')
  lines.push(paint(['bold', 'yellow'], rule))
  return lines
}

export function testnetNote(network: Network): string[] {
  if (!network.testnet) return []
  return [
    'TestNet is for development. Put NETWORK=testnet before every aupm command.',
    'Set AUPM_PROXY_URL to the TestNet server. Example:',
    '  NETWORK=testnet AUPM_PROXY_URL=<url> aupm donor status',
    '',
  ]
}

export function addressLines(address: string, network: Network): string[] {
  return [`Address: ${address}`, `Network: Algorand ${network.name}`]
}

export function envNoticeLines(address: string | null): string[] {
  const lead = 'AUPM_DONOR_MNEMONIC is set. AuPM uses it and ignores the key file.'
  if (address === null) {
    return [lead, 'The value is not a valid phrase. Remove it: `unset AUPM_DONOR_MNEMONIC`.']
  }
  return [lead, `Address in use: ${address}`]
}

const PERA_FIRST = 'Pera Wallet (recommended)'

export function algoStep(
  label: string,
  address: string,
  network: Network,
  micro: bigint,
  detail = false,
): string[] {
  const minimum =
    `The minimum is ${formatMicro(ALGO_MINIMUM_MICRO)} ALGO. 0.1 ALGO stays locked in the account. ` +
    '0.1 ALGO stays locked for the USDC opt-in. 0.001 ALGO pays the fee.'
  const body = [
    ...(detail ? wrap(minimum) : []),
    ...qrLines(arc26Uri(address, micro)).map((line) => `${BODY_INDENT}${line}`),
  ]
  if (!network.testnet) {
    body.push(
      ...wrap(`With ${PERA_FIRST}: buy ALGO.`),
      ...wrap('With an exchange: withdraw ALGO on the "Algorand" network only.'),
    )
  }
  const heading = `Send ${formatMicro(micro)} ALGO to this address.`
  return step(label, heading, 'Scan the QR code with your wallet.', body)
}

export function optinStep(label: string): string[] {
  return step(
    label,
    'Run `aupm donor optin`.',
    'An Algorand wallet must opt in before it can hold USDC.',
    [],
  )
}

export function usdcStep(
  label: string,
  address: string,
  network: Network,
  options: { withQr?: boolean; peraKnown?: boolean } = {},
): string[] {
  const { withQr = true, peraKnown = false } = options
  const only = `Send only USDC on the Algorand network (asset id ${network.usdcAsset}).`
  const lost = 'USDC sent on other networks is lost.'
  const body = wrap(
    withQr
      ? 'The QR code asks for 1 USDC. You can change the amount in your wallet.'
      : `${lost} \`aupm donor optin\` shows a QR code.`,
  )
  if (withQr) {
    const uri = arc26Uri(address, USDC_SUGGESTED_MICRO, network.usdcAsset)
    body.push(...qrLines(uri).map((line) => `${BODY_INDENT}${line}`))
  }
  if (!network.testnet) {
    const pera = peraKnown ? 'Pera Wallet' : PERA_FIRST
    body.push(...wrap(`With ${pera}: buy USDC. With an exchange: withdraw it on Algorand.`))
  }
  const intro = withQr ? `${only} ${lost}` : only
  return step(label, 'Send 1 to 5 USDC to this address.', intro, body)
}

export const CI_CONFIG_HOME = '$HOME/.config/aupm-ci'

function separateWalletLines(windows: boolean): string[] {
  if (windows) {
    return [
      ...wrap('You may use a separate wallet. Run this first, then the same onboarding commands.'),
      `${COMMAND_INDENT}$env:XDG_CONFIG_HOME = "${CI_CONFIG_HOME}"`,
      ...wrap('Close the window afterwards.'),
    ]
  }
  return [
    ...wrap('You may use a separate wallet. Put this before the same onboarding commands:'),
    `${COMMAND_INDENT}XDG_CONFIG_HOME="${CI_CONFIG_HOME}"`,
  ]
}

function secretCommand(network: Network, windows: boolean, keyFile: string): string {
  if (windows) return `Get-Content "${keyFile}" | gh secret set ${network.ciSecret}`
  return `gh secret set ${network.ciSecret} < "${keyFile}"`
}

export function ciStep(
  label: string,
  network: Network,
  windows: boolean,
  keyFile: string,
): string[] {
  // The separate-wallet lines come last, so their prefix is never read as part of the
  // secret command.
  return step(label, 'Optional, for CI. Store the key as a GitHub secret:', '', [
    `${COMMAND_INDENT}${secretCommand(network, windows, keyFile)}`,
    ...wrap('In the workflow:'),
    `${COMMAND_INDENT}donor-secret: \${{ secrets.${network.ciSecret} }}`,
    ...wrap(`Web page: ${GITHUB_SECRETS_PATH}.`),
    ...wrap('Everyone who can change the workflows of the repository can read the secret.'),
    ...separateWalletLines(windows),
  ])
}

const MIN_PRICE_TEXT = 'minimum $0.001 (x0.1), suggested $0.01 (x1)'
const FUNDING_TEXT =
  'A donation pays for each reviewed package in the lockfile. ' +
  'Without --donate, every install is free, reviewed packages included.'

export const PROMPT_MULTIPLIER = 'Multiplier (x0.1 to x100, for example 1):'
export const PROMPT_RETRY_MULTIPLIER = 'Type a multiplier from 0.1 to 100, for example 1.'

/** The text before the multiplier question. No default is selected. */
export function multiplierPromptLines(): string[] {
  return [
    paint(['bold', 'cyan'], 'Donation multiplier.'),
    ...wrap(`Price per reviewed package: ${MIN_PRICE_TEXT}.`),
    ...wrap(FUNDING_TEXT),
    ...wrap('Change it at any time with `aupm config set multiplier <x>`.'),
  ]
}

export function donateStep(label: string): string[] {
  const intro = 'Add --donate to an install or attest command:'
  return step(label, 'Donate.', intro, [
    `${COMMAND_INDENT}aupm install --donate   or   aupm attest package-lock.json --donate`,
    ...wrap(
      `Price per reviewed package: ${MIN_PRICE_TEXT}. ` +
        'Without --donate, every install is free, reviewed packages included.',
    ),
    ...wrap(
      'To donate on every install, run `aupm config set donate true`. ' +
        'Set the price with `aupm config set multiplier <x>`.',
    ),
  ])
}

export function initNextSteps(
  address: string,
  network: Network,
  windows: boolean,
  keyFile: string,
): string[] {
  return [
    `${paint(['bold', 'cyan'], 'Next steps.')} Run \`aupm donor status\` at any time to see the next step.`,
    ...algoStep('1.', address, network, ALGO_SUGGESTED_MICRO, true),
    '',
    ...optinStep('2.'),
    '',
    ...usdcStep('3.', address, network, { withQr: false, peraKnown: true }),
    '',
    ...ciStep('4.', network, windows, keyFile),
    '',
    ...donateStep('5.'),
  ]
}

export interface Snapshot {
  address: string
  algo: bigint
  required: bigint
  optedIn: boolean
  usdc: bigint
}

export function statusLines(snapshot: Snapshot, network: Network): string[] {
  const { address, algo, required, optedIn, usdc } = snapshot
  const need = optedIn ? 'the opt-in is done' : `needed: ${formatMicro(required)} ALGO`
  const lines = [
    ...addressLines(address, network),
    `ALGO balance: ${formatMicro(algo)} ALGO (${need})`,
    `USDC opt-in: ${optedIn ? 'done' : 'not done'}`,
    `USDC balance: ${formatMicro(usdc)} USDC (pays for ${packagesCovered(usdc)} reviewed packages)`,
    '',
  ]
  if (!optedIn && algo < required) {
    lines.push(...algoStep('Next step.', address, network, required - algo))
  } else if (!optedIn) {
    lines.push(...optinStep('Next step.'))
  } else {
    lines.push(...afterOptInStep(snapshot, network))
  }
  return lines
}

/** The next step of a wallet that has opted in: fund it with USDC, or donate. */
export function afterOptInStep(snapshot: Snapshot, network: Network): string[] {
  if (snapshot.usdc === 0n) return usdcStep('Next step.', snapshot.address, network)
  return donateStep('Next step.')
}

/** The ALGO balance, the shortfall and the ALGO step for a wallet that cannot opt in yet. */
export function shortfallLines(snapshot: Snapshot, network: Network): string[] {
  const short = snapshot.required - snapshot.algo
  return [
    `ALGO balance: ${formatMicro(snapshot.algo)} ALGO. Needed: ${formatMicro(snapshot.required)} ALGO. ` +
      `Shortfall: ${formatMicro(short)} ALGO.`,
    ...algoStep('Next step.', snapshot.address, network, short),
  ]
}

/** The result of a sent opt-in, then the USDC step. */
export function optedInLines(txid: string, address: string, network: Network): string[] {
  return [
    `Opted in to USDC (ASA ${network.usdcAsset}).`,
    `Transaction: ${txid}`,
    `Explorer: https://lora.algokit.io/${network.explorer}/transaction/${txid}`,
    '',
    ...usdcStep('Next step.', address, network),
  ]
}

export const PROMPT_ENTER_ALGO = 'Press Enter when you have sent the ALGO.'
export const PROMPT_ENTER_USDC = 'Press Enter when you have sent the USDC.'
export const PROMPT_YES = 'Type yes when the 25 words are on paper:'
export const PROMPT_RETRY_YES = 'Type yes to continue, or press Ctrl-C to stop.'
export const STOPPED_LINE = 'Stopped. Run `aupm donor init` again to continue where you stopped.'
export const STOPPED_UNSAVED_LINE =
  'Stopped. Nothing was saved. Run `aupm donor init` again to make a new wallet.'
export const ALGO_PENDING_LINE =
  'The ALGO has not arrived yet. Wait for the transfer, then press Enter.'
export const USDC_PENDING_LINE =
  'The USDC has not arrived yet. Wait for the transfer, then press Enter.'

/** The words per row on the backup screen. */
const WORDS_PER_ROW = 5

/** The numbered rows of the 25 words. Only the backup screen prints these rows. */
export function wordRows(mnemonic: string): string[] {
  const words = mnemonic.split(' ')
  const rows: string[] = []
  for (let start = 0; start < words.length; start += WORDS_PER_ROW) {
    const row = words
      .slice(start, start + WORDS_PER_ROW)
      .map((word, offset) => `${String(start + offset + 1).padStart(2)}. ${word.padEnd(10)}`)
    rows.push(`  ${row.join(' ').trimEnd()}`)
  }
  return rows
}

/** The text above the 25 words on the backup screen. */
export function backupIntroLines(): string[] {
  return [
    paint('bold', 'Back up the 25 words.'),
    '   They are shown once. They leave the screen after you type yes.',
    '   Nothing is saved yet.',
    '',
  ]
}

/** The text below the 25 words on the backup screen. */
export function backupOutroLines(): string[] {
  return [
    '',
    '   Write the words on paper, in this order. Keep the paper offline.',
    '   The key file is saved only after you type yes. The paper is the only other copy.',
  ]
}

/** The lines after the donor typed yes and the key file is saved. */
export function savedLines(file: string): string[] {
  return [
    `Saved the key file: ${file} (mode 0600).`,
    'Optional: import the wallet into Pera Wallet. Select Add account, then',
    'Import an account, and type the 25 words from your paper.',
  ]
}

/** The block for a rerun of `init` when the wallet can donate already. */
export function allSetLines(snapshot: Snapshot, network: Network, donate: string): string[] {
  const { address, algo, usdc } = snapshot
  const covered = packagesCovered(usdc)
  return [
    paint(['bold', 'green'], 'All set. The donor wallet is ready to donate.'),
    ...testnetNote(network),
    ...addressLines(address, network),
    `ALGO balance: ${formatMicro(algo)} ALGO`,
    `USDC balance: ${formatMicro(usdc)} USDC (pays for ${covered} reviewed packages)`,
    `Setting: ${donate}`,
    donate.startsWith('donate = true')
      ? 'Every install donates. Add --no-donate to skip one donation.'
      : 'To donate, add --donate to `aupm install`, or run `aupm config set donate true`.',
  ]
}

/** The line when the USDC has arrived during `init`. */
export function usdcArrivedLines(snapshot: Snapshot): string[] {
  const covered = packagesCovered(snapshot.usdc)
  const held = formatMicro(snapshot.usdc)
  return [`The wallet holds ${held} USDC (pays for ${covered} reviewed packages).`]
}

/** The first lines when `init` runs again and a key file exists. */
export function continueLines(file: string, address: string, network: Network): string[] {
  return [
    'The donor wallet exists already. This run continues from its state.',
    ...testnetNote(network),
    `Key file: ${file}`,
    ...addressLines(address, network),
    '',
  ]
}
