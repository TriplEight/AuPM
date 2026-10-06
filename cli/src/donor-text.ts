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

function qrLines(uri: string): string[] {
  return [...renderUnicodeCompact(uri).split('\n'), uri]
}

export function warningBlock(file: string, windows: boolean): string[] {
  const rule = '='.repeat(64)
  const lines = [
    paint(['bold', 'yellow'], rule),
    paint(['bold', 'yellow'], 'PLEASE READ. THIS PROTECTS YOUR FUNDS.'),
    paint(['bold', 'yellow'], rule),
    `The file ${file} holds the secret key of your donor wallet: 25 words.`,
    '- This is a hot wallet by design. Any program that runs as this user can read the key',
    '  and spend the funds. Keep only small amounts here. 1 USDC pays for 1,000 reviewed packages.',
    '- This file is the only copy. Back up the 25 words offline: on paper, or on an external drive.',
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
  return [lead, `The address in use is: ${address}`]
}

export function existingFileLines(file: string, address: string): string[] {
  return [
    `A donor key file exists already: ${file}`,
    `It holds the address: ${address}`,
    'Run `aupm donor status` to see the state of this wallet.',
    'Do not delete the file. Deleting it loses the funds in this wallet.',
    'Back up the file before you change anything.',
  ]
}

const PERA_FIRST = 'Pera Wallet (formerly the official Algorand Wallet)'

export function algoStep(
  label: string,
  address: string,
  network: Network,
  micro: bigint,
  detail = false,
): string[] {
  const lines = [
    paint('bold', `${label} Send ${formatMicro(micro)} ALGO to this address.`) +
      (detail
        ? ` The minimum is ${formatMicro(ALGO_MINIMUM_MICRO)} ALGO (0.1 account, 0.1 USDC opt-in, 0.001 fee).`
        : ''),
    '   Scan the QR code with your wallet.',
    ...qrLines(arc26Uri(address, micro)).map((line) => `   ${line}`),
  ]
  if (!network.testnet) {
    lines.push(
      `   With ${PERA_FIRST}: buy ALGO in the app, then scan the QR code.`,
      '   With an exchange: withdraw ALGO on the "Algorand" network only.',
    )
  }
  return lines
}

export function optinStep(label: string): string[] {
  const heading = paint('bold', `${label} Run \`aupm donor optin\`.`)
  return [`${heading} It lets the wallet hold USDC.`]
}

export function usdcStep(
  label: string,
  address: string,
  network: Network,
  options: { withQr?: boolean; peraKnown?: boolean } = {},
): string[] {
  const { withQr = true, peraKnown = false } = options
  const lines = [
    paint('bold', `${label} Send 1 to 5 USDC to this address.`) +
      ` Only USDC on Algorand (ASA ${network.usdcAsset}). USDC from other chains is lost.`,
  ]
  if (withQr) {
    lines.push(
      '   The QR code asks for 1 USDC. You can change the amount in your wallet.',
      ...qrLines(arc26Uri(address, USDC_SUGGESTED_MICRO, network.usdcAsset)).map(
        (line) => `   ${line}`,
      ),
    )
  } else {
    lines.push('   `aupm donor optin` shows a QR code for this step.')
  }
  if (!network.testnet) {
    const pera = peraKnown ? 'Pera Wallet' : PERA_FIRST
    lines.push(
      `   With ${pera}: buy USDC, or swap ALGO to USDC. With an exchange: withdraw USDC on the Algorand network.`,
    )
  }
  return lines
}

export const CI_CONFIG_HOME = '$HOME/.config/aupm-ci'

function separateWalletLine(windows: boolean): string {
  if (windows) {
    return `   You may use a separate wallet: run \`$env:XDG_CONFIG_HOME = "${CI_CONFIG_HOME}"\` first, then the same onboarding commands. Close the window afterwards.`
  }
  return `   You may use a separate wallet: put XDG_CONFIG_HOME="${CI_CONFIG_HOME}" before the same onboarding commands.`
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
  return [
    paint('bold', `${label} Optional, for CI. Store the key as a GitHub secret.`),
    separateWalletLine(windows),
    `     ${secretCommand(network, windows, keyFile)}`,
    `   Workflow line: donor-secret: \${{ secrets.${network.ciSecret} }}`,
    `   Or use the web page of your repository: ${GITHUB_SECRETS_PATH}.`,
    '   Everyone who can change the workflows of the repository can read the secret.',
  ]
}

export function donateStep(label: string): string[] {
  const price = formatMicro(BigInt(PRICE_PER_ENTRY_MICRO))
  return [
    paint('bold', `${label} Donate.`) +
      ' Add --donate to an install or attest command, for example `aupm install --donate`',
    '   or `aupm attest package-lock.json --donate`.' +
      ` It pays ${price} USDC for each reviewed package in the lockfile.`,
    '   Without --donate, every install is free, reviewed packages included.',
  ]
}

export function initNextSteps(
  address: string,
  network: Network,
  windows: boolean,
  keyFile: string,
): string[] {
  return [
    paint(['bold', 'cyan'], 'Next steps.') +
      ' Run `aupm donor status` at any time to see the next step.',
    '',
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
