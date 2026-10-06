// cli/src/donor-text.test.ts
import { describe, expect, it } from 'vitest'
import {
  algoStep,
  arc26Uri,
  ciStep,
  formatMicro,
  networkFor,
  optInRequiredMicro,
  packagesCovered,
  usdcStep,
} from './donor-text.js'

const ADDRESS = 'A'.repeat(58)
const testnet = networkFor(true, '10458941', 'testnet')
const mainnet = networkFor(false, '31566704', 'mainnet')

describe('amounts', () => {
  it('formats integer micro-units without floats', () => {
    expect(formatMicro(0n)).toBe('0.000000')
    expect(formatMicro(201_000n)).toBe('0.201000')
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

  it('points TestNet at the dispenser and the Circle faucet with the TestNet asset', () => {
    const algo = algoStep('1.', ADDRESS, testnet, 300_000n).join('\n')
    const usdc = usdcStep('3.', ADDRESS, testnet).join('\n')
    expect(algo).toContain('https://lora.algokit.io/testnet/fund')
    expect(usdc).toContain('https://faucet.circle.com/')
    expect(usdc).toContain('Algorand Testnet')
    expect(usdc).toContain('ASA 10458941')
    expect(usdc).toContain(`algorand://${ADDRESS}?amount=1000000&asset=10458941`)
  })

  it('names the CI secret of the network', () => {
    expect(ciStep('4.', '/k/donor.env', mainnet).join('\n')).toContain(
      'gh secret set AUPM_DONOR_MNEMONIC_MAINNET',
    )
    expect(ciStep('4.', '/k/donor.env', testnet).join('\n')).toContain(
      'gh secret set AUPM_DONOR_MNEMONIC_TESTNET',
    )
  })
})
