// cli/src/donor-text.test.ts
import os from 'node:os'
import { donorKeyFilePath } from 'aupm-mcp/donor-key'
import { describe, expect, it } from 'vitest'
import {
  algoStep,
  arc26Uri,
  CI_CONFIG_HOME,
  ciStep,
  donateStep,
  formatMicro,
  networkFor,
  optInRequiredMicro,
  packagesCovered,
  usdcStep,
} from './donor-text.js'

const KEY = '/home/u/.config/aupm/donor.key'
const ADDRESS = 'A'.repeat(58)
const testnet = networkFor(true, '10458941', 'testnet')
const mainnet = networkFor(false, '31566704', 'mainnet')

describe('amounts', () => {
  it('formats integer micro-units without floats', () => {
    expect(formatMicro(0n)).toBe('0')
    expect(formatMicro(201_000n)).toBe('0.201')
    expect(formatMicro(12_345_678n)).toBe('12.345678')
  })

  it('requires the larger of the algod minimum and 0.1 ALGO, plus the opt-in', () => {
    expect(optInRequiredMicro(0n)).toBe(201_000n)
    expect(optInRequiredMicro(100_000n)).toBe(201_000n)
    expect(optInRequiredMicro(200_000n)).toBe(301_000n)
  })

  it('rounds the covered packages down', () => {
    expect(packagesCovered(999n)).toBe(0n)
    expect(packagesCovered(1_000_000n)).toBe(1000n)
    expect(packagesCovered(1_999_999n)).toBe(1999n)
  })
})

describe('ARC-26 URI', () => {
  it('carries the amount for ALGO and amount plus asset for USDC', () => {
    expect(arc26Uri(ADDRESS, 300_000n)).toBe(`algorand://${ADDRESS}?amount=300000`)
    expect(arc26Uri(ADDRESS, 1_000_000n, '31566704')).toBe(
      `algorand://${ADDRESS}?amount=1000000&asset=31566704`,
    )
  })
})

describe('network text', () => {
  it('points MainNet at Pera and names no dispenser', () => {
    const text = [
      ...algoStep('1.', ADDRESS, mainnet, 300_000n),
      ...usdcStep('3.', ADDRESS, mainnet),
    ].join('\n')
    expect(text).toContain('Pera Wallet')
    expect(text).toContain('ASA 31566704')
    expect(text).not.toContain('faucet')
    expect(text).not.toContain('dispenser')
  })

  it('gives TestNet the TestNet asset and no dispenser, faucet or link', () => {
    const algo = algoStep('1.', ADDRESS, testnet, 300_000n).join('\n')
    const usdc = usdcStep('3.', ADDRESS, testnet).join('\n')
    expect(`${algo}\n${usdc}`).not.toMatch(/https?:|dispenser|faucet|Pera/i)
    expect(usdc).toContain('ASA 10458941')
    expect(usdc).toContain(`algorand://${ADDRESS}?amount=1000000&asset=10458941`)
  })

  it('offers a separate wallet with one line, in the shell form of the platform', () => {
    const posix = ciStep('4.', mainnet, false, KEY).join('\n')
    expect(posix).toContain(
      'You may use a separate wallet: put XDG_CONFIG_HOME="$HOME/.config/aupm-ci" before the same onboarding commands.',
    )
    expect(posix).not.toContain('$env:')
    expect(posix).not.toContain('aupm donor init')
    const windows = ciStep('4.', mainnet, true, KEY).join('\n')
    expect(windows).toContain('$env:XDG_CONFIG_HOME = "$HOME/.config/aupm-ci"')
    expect(windows).toContain('Close the window afterwards.')
    expect(windows).not.toContain('XDG_CONFIG_HOME="')
  })

  it('reads the main key file through stdin on each platform and network', () => {
    const quoted = `"${KEY}"`
    for (const [network, name] of [
      [mainnet, 'AUPM_DONOR_MNEMONIC_MAINNET'],
      [testnet, 'AUPM_DONOR_MNEMONIC_TESTNET'],
    ] as const) {
      const posix = ciStep('4.', network, false, KEY).join('\n')
      const windows = ciStep('4.', network, true, KEY).join('\n')
      expect(posix).toContain(`gh secret set ${name} < ${quoted}`)
      expect(windows).toContain(`Get-Content ${quoted} | gh secret set ${name}`)
      for (const text of [posix, windows]) {
        expect(text).toContain(`secrets.${name} }}`)
        expect(text).toContain('Everyone who can change the workflows')
        expect(text).not.toContain('sed')
        expect(text).not.toContain('secret set -f')
        expect(text).not.toContain('AUPM_DONOR_MNEMONIC=')
        expect(text).not.toMatch(/rename|limits the loss/i)
      }
    }
  })

  it('prints a separate-wallet path that the key loader reads', () => {
    const home = os.homedir()
    const previous = process.env.XDG_CONFIG_HOME
    process.env.XDG_CONFIG_HOME = CI_CONFIG_HOME.replace('$HOME', home)
    try {
      expect(donorKeyFilePath()).toBe(`${CI_CONFIG_HOME.replace('$HOME', home)}/aupm/donor.key`)
    } finally {
      if (previous === undefined) delete process.env.XDG_CONFIG_HOME
      else process.env.XDG_CONFIG_HOME = previous
    }
  })

  it('shows the USDC QR only when asked', () => {
    const uri = `algorand://${ADDRESS}?amount=1000000&asset=31566704`
    expect(usdcStep('3.', ADDRESS, mainnet).join('\n')).toContain(uri)
    const short = usdcStep('3.', ADDRESS, mainnet, { withQr: false }).join('\n')
    expect(short).not.toContain('asset=')
    expect(short).toContain('Only USDC on Algorand (ASA 31566704)')
    expect(short).toContain('USDC from other chains is lost')
  })

  it('names Pera Wallet in full on the first mention only', () => {
    const first = algoStep('1.', ADDRESS, mainnet, 300_000n).join('\n')
    expect(first).toContain('Pera Wallet (formerly the official Algorand Wallet)')
    const later = usdcStep('3.', ADDRESS, mainnet, { peraKnown: true }).join('\n')
    expect(later).toContain('With Pera Wallet:')
    expect(later).not.toContain('formerly')
  })

  it('names the price of one reviewed package from the price constant', () => {
    expect(donateStep('5.').join('\n')).toContain('It pays 0.001 USDC for each reviewed package')
    expect(donateStep('5.').join('\n')).toContain('Without --donate, every install is free')
    expect(donateStep('5.').join('\n')).not.toContain('plain install')
  })
})
