// cli/src/donor-text.ts
//
// The words that `aupm donor` prints (SPEC.md §11.4, ADR 0016). Every function returns lines.
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
    '- Hot wallet by design: any program running as this user can spend the funds.',
    '- Keep only small amounts here. 1 USDC pays for 1,000 reviewed packages.',
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
    'TestNet is for development. Put NETWORK=testnet before every aupm command,',
    'and set AUPM_PROXY_URL to the TestNet server.',
    '',
  ]
}

export function addressLines(address: string, network: Network): string[] {
  return [`Address: ${address}`, `Network: Algorand ${network.name}`]
}

export function envNoticeLines(address: string | null): string[] {
  const lead = 'AUPM_DONOR_MNEMONIC is set in the environment. It wins over the key file.'
  if (address === null) return [lead, 'The value is not a valid 25-word mnemonic.']
  return [lead, `Address in use: ${address}`]
}

export function existingFileLines(file: string, address: string): string[] {
  return [
    'A donor key file exists already:',
    `  ${file}`,
    `It holds the address: ${address}`,
    'Run `aupm donor status` to see the state of this wallet.',
    'Do not delete the file. Deleting it loses the funds in this wallet.',
    'Back up the file before you change anything.',
  ]
}

const PERA_FIRST = 'Pera Wallet (recommended)'

export function algoStep(
  label: string,
  address: string,
  network: Network,
  micro: bigint,
  detail = false,
): string[] {
  const minimum = `The minimum is ${formatMicro(ALGO_MINIMUM_MICRO)} ALGO (0.1 account, 0.1 USDC opt-in, 0.001 fee).`
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
  return step(label, 'Run `aupm donor optin`.', 'It lets the wallet hold USDC.', [])
}

export function usdcStep(
  label: string,
  address: string,
  network: Network,
  options: { withQr?: boolean; peraKnown?: boolean } = {},
): string[] {
  const { withQr = true, peraKnown = false } = options
  const only = `Only USDC on Algorand (ASA ${network.usdcAsset}).`
  const lost = 'USDC from other chains is lost.'
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

export function donateStep(label: string): string[] {
  const price = formatMicro(BigInt(PRICE_PER_ENTRY_MICRO))
  const intro = 'Add --donate to an install or attest command:'
  return step(label, 'Donate.', intro, [
    `${COMMAND_INDENT}aupm install --donate   or   aupm attest package-lock.json --donate`,
    ...wrap(
      `It pays ${price} USDC for each reviewed package in the lockfile. ` +
        'Without --donate, every install is free, reviewed packages included.',
    ),
    ...wrap('Always donate: `aupm config set donate true` or AUPM_DONATE=true.'),
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
    const short = required - algo
    lines.push(...algoStep('Next step.', address, network, short))
  } else if (!optedIn) {
    lines.push(...optinStep('Next step.'))
  } else if (usdc === 0n) {
    lines.push(...usdcStep('Next step.', address, network))
  } else {
    lines.push(...donateStep('Next step.'))
  }
  return lines
}
