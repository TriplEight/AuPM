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

const TESTNET_ALGO_DISPENSER = 'https://lora.algokit.io/testnet/fund'
const TESTNET_USDC_FAUCET = 'https://faucet.circle.com/'
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
    `This file holds the secret key of your donor wallet: ${file}`,
    'The secret key is the 25-word mnemonic.',
    '',
    '- This is a hot wallet by design. The key is not encrypted on this disk.',
    '- Any program that runs as this user can read the key and spend the funds.',
    '- Keep only small amounts here. 1 USDC pays for 1,000 reviewed packages.',
    '- This file is the only backup. If you lose it, you lose the funds.',
    '  Copy the file to a password manager.',
    '- Never paste the mnemonic into a chat, an issue or a log.',
  ]
  if (windows) lines.push('- On Windows, the permissions of this file are not protected.')
  lines.push(paint(['bold', 'yellow'], rule))
  return lines
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
  ]
}

export function algoStep(label: string, address: string, network: Network, micro: bigint) {
  const lines = [
    paint('bold', `${label} Send ALGO to this address.`),
    `   Send ${formatMicro(micro)} ALGO. The minimum is ${formatMicro(ALGO_MINIMUM_MICRO)} ALGO:`,
    '   0.1 for the account, 0.1 for the USDC opt-in and 0.001 for the fee.',
    '   Scan this QR code with your wallet. It fills in the address and the amount.',
    ...qrLines(arc26Uri(address, micro)).map((line) => `   ${line}`),
  ]
  if (network.testnet) {
    lines.push(
      `   Get free TestNet ALGO from the dispenser: ${TESTNET_ALGO_DISPENSER}`,
      '   Enter the address above on that page.',
    )
  } else {
    lines.push(
      '   With Pera Wallet: buy ALGO in the app. Then scan the QR code to send it here.',
      '   With an exchange: withdraw ALGO on the "Algorand" network. No other network works.',
    )
  }
  return lines
}

export function optinStep(label: string): string[] {
  return [
    paint('bold', `${label} Run \`aupm donor optin\`.`),
    '   This lets the wallet hold USDC. It sends one transaction. It needs the ALGO in the wallet.',
  ]
}

export function usdcStep(
  label: string,
  address: string,
  network: Network,
  withQr = true,
): string[] {
  const lines = [
    paint('bold', `${label} Send 1 to 5 USDC to this address.`),
    `   Send only USDC on Algorand (ASA ${network.usdcAsset}).`,
    '   USDC from another chain is lost when you send it here.',
  ]
  if (withQr) {
    lines.push(
      '   This QR code asks for 1 USDC. You can change the amount in your wallet.',
      ...qrLines(arc26Uri(address, USDC_SUGGESTED_MICRO, network.usdcAsset)).map(
        (line) => `   ${line}`,
      ),
    )
  } else {
    lines.push('   `aupm donor optin` shows a QR code for this step.')
  }
  if (network.testnet) {
    lines.push(
      `   Get free TestNet USDC from the Circle faucet: ${TESTNET_USDC_FAUCET}`,
      '   Choose "Algorand Testnet" on that page. Enter the address above.',
    )
  } else {
    lines.push(
      '   With Pera Wallet: buy USDC in the app, or swap ALGO to USDC. Then send it here.',
      '   With an exchange: withdraw USDC on the Algorand network.',
    )
  }
  return lines
}

export const CI_CONFIG_HOME = '$HOME/.config/aupm-ci'
export const CI_KEY_FILE = `${CI_CONFIG_HOME}/aupm/donor.env`

export function ciStep(label: string, network: Network): string[] {
  const networkEnv = network.testnet ? 'NETWORK=testnet ' : ''
  return [
    paint('bold', `${label} Optional. Store a key as a secret for CI.`),
    '   Use a separate wallet for CI. A separate wallet limits the loss.',
    '   Create it with this command. It writes a second key file:',
    `     ${networkEnv}XDG_CONFIG_HOME="${CI_CONFIG_HOME}" aupm donor init`,
    '   Fund that wallet as in steps 1 to 3. Put the same prefix before each command:',
    `     ${networkEnv}XDG_CONFIG_HOME="${CI_CONFIG_HOME}" aupm donor optin`,
    '   Then run this command.',
    '   The mnemonic goes through stdin only:',
    `     sed -n 's/^AUPM_DONOR_MNEMONIC=//p' "${CI_KEY_FILE}" | gh secret set ${network.ciSecret}`,
    `   Or use the web page of your repository: ${GITHUB_SECRETS_PATH}.`,
    '   Everyone who can change the workflows of the repository can read the secret.',
  ]
}

export function donateStep(label: string): string[] {
  const price = formatMicro(BigInt(PRICE_PER_ENTRY_MICRO))
  return [
    paint('bold', `${label} Make the first donation.`),
    `   It pays ${price} USDC for each reviewed package in the lockfile.`,
    '   Unreviewed packages are free. It works with package-lock.json and pnpm-lock.yaml.',
    '   Run: aupm attest package-lock.json --donate',
    '   A plain install stays free.',
  ]
}

export function initNextSteps(address: string, network: Network): string[] {
  return [
    paint(['bold', 'cyan'], 'Next steps. Nothing here has a deadline.'),
    'Run `aupm donor status` at any time to see the next step.',
    '',
    ...algoStep('1.', address, network, ALGO_SUGGESTED_MICRO),
    '',
    ...optinStep('2.'),
    '',
    ...usdcStep('3.', address, network, false),
    '',
    ...ciStep('4.', network),
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
    lines.push(
      `The wallet needs ${formatMicro(short)} more ALGO to opt in to USDC.`,
      ...algoStep('Next step.', address, network, short),
    )
  } else if (!optedIn) {
    lines.push(...optinStep('Next step.'))
  } else if (usdc === 0n) {
    lines.push(...usdcStep('Next step.', address, network))
  } else {
    lines.push(...donateStep('Next step.'))
  }
  return lines
}
