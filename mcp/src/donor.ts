// mcp/src/donor.ts
//
// Shared donation client for the MCP server and the CLI. Donation is
// opt-in everywhere: a 402 never signs unless the caller explicitly agrees
// to donate. Builds on wrapFetchWithPayment from @x402-avm/fetch -- never a
// hand-built payment group.
//
// WARNING: never print or expose the donor mnemonic or the derived private key.
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  type ClientAvmSigner,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from '@x402-avm/avm'
import { registerExactAvmScheme } from '@x402-avm/avm/exact/client'
import { x402Client } from '@x402-avm/core/client'
import { decodePaymentRequiredHeader } from '@x402-avm/core/http'
import type { PaymentRequirements } from '@x402-avm/core/types'
import { wrapFetchWithPayment } from '@x402-avm/fetch'
import { signerFromMnemonic } from './signer.js'

// NETWORK selects Algorand MainNet (default) or TestNet rehearsal.
const NETWORK = (process.env.NETWORK ?? 'mainnet').toLowerCase()
export const IS_TESTNET = NETWORK === 'testnet'
export const CAIP2_NETWORK = IS_TESTNET ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2
export const USDC_ASSET_ID = IS_TESTNET ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID
export const EXPLORER_NETWORK = IS_TESTNET ? 'testnet' : 'mainnet'

/** Env var holding the donor's 25-word Algorand mnemonic. */
export const SPM_DONOR_MNEMONIC_ENV = 'SPM_DONOR_MNEMONIC'

/** A donation never signs above this amount, in microUSDC. No config knob. */
export const DONATION_CAP_MICRO = 20_000

function readDonorMnemonic(): string {
  const value = process.env[SPM_DONOR_MNEMONIC_ENV]
  if (!value) throw new Error(`${SPM_DONOR_MNEMONIC_ENV} env var not set`)
  return value
}

/** A decoded PAYMENT-REQUIRED requirement, used to report a price without paying it. */
export type DonationRequirement = {
  priceMicro: number
  resourceUrl: string
  asset: string
}

/** Thrown when every 402 requirement fails the spend cap or the asset check. Never signs. */
export class DonationRefusedError extends Error {}

function requirementAsset(requirement: PaymentRequirements): unknown {
  const extra = requirement.extra
  return extra && typeof extra === 'object' ? (extra as { asset?: unknown }).asset : undefined
}

// A requirement is fine to donate only when both the top-level asset and
// extra.asset name the selected network's USDC ASA, and the amount is at or
// under the spend cap. CLAUDE.md: extra.asset is always explicit; an
// omitted asset may resolve to ALGO instead of USDC.
function isDonationCompliant(requirement: PaymentRequirements): boolean {
  if (requirement.asset !== USDC_ASSET_ID) return false
  if (requirementAsset(requirement) !== USDC_ASSET_ID) return false
  return BigInt(requirement.amount) <= BigInt(DONATION_CAP_MICRO)
}

// Filters out any requirement above the spend cap or on a non-USDC asset.
// Registered as an x402Client policy, so the cap runs inside the normal
// wrapFetchWithPayment flow and enforces before a signature is ever created.
function donationCapPolicy() {
  return (_version: number, requirements: PaymentRequirements[]): PaymentRequirements[] => {
    const compliant = requirements.filter(isDonationCompliant)
    if (compliant.length === 0) {
      const first = requirements[0]
      const amount = first ? first.amount : 'unknown'
      const asset = first ? first.asset : 'unknown'
      const network = IS_TESTNET ? 'TestNet' : 'MainNet'
      throw new DonationRefusedError(
        `refusing to donate ${amount} microUSDC of asset ${asset}: exceeds the ` +
          `${DONATION_CAP_MICRO} microUSDC cap, or is not the ${network} USDC asset ${USDC_ASSET_ID}`,
      )
    }
    return compliant
  }
}

// Derives the donor signer only when the scheme actually reads address or
// signTransactions -- that only happens once a real 402 is being paid. A
// free (200) response never touches SPM_DONOR_MNEMONIC.
function lazyDonorSigner(): ClientAvmSigner {
  let cached: ClientAvmSigner | undefined
  function resolve(): ClientAvmSigner {
    if (!cached) cached = signerFromMnemonic(readDonorMnemonic())
    return cached
  }
  return {
    get address() {
      return resolve().address
    },
    signTransactions: (txns, indexesToSign) => resolve().signTransactions(txns, indexesToSign),
  }
}

function buildDonationClient(): x402Client {
  const client = new x402Client()
  registerExactAvmScheme(client, {
    signer: lazyDonorSigner(),
    networks: [CAIP2_NETWORK],
    policies: [donationCapPolicy()],
  })
  return client
}

function decodeDonationRequirement(res: Response): DonationRequirement {
  const header = res.headers.get('PAYMENT-REQUIRED')
  if (!header) throw new Error('402 response carries no PAYMENT-REQUIRED header')
  const paymentRequired = decodePaymentRequiredHeader(header)
  const requirement = paymentRequired.accepts[0]
  if (!requirement) throw new Error('PAYMENT-REQUIRED header lists no accepted requirements')
  return {
    priceMicro: Number(requirement.amount),
    resourceUrl: paymentRequired.resource.url,
    asset: requirement.asset,
  }
}

export type DonationFetchResult =
  | { kind: 'response'; response: Response }
  | { kind: 'donation_required'; requirement: DonationRequirement }

/**
 * Fetches url, paying a 402 only when allowDonation is true. Uses
 * wrapFetchWithPayment for the whole pay-and-retry flow. The spend cap and
 * asset check run as an x402Client policy, so a refused requirement never
 * signs and never retries.
 */
export async function fetchWithDonation(
  url: string,
  init: RequestInit | undefined,
  allowDonation: boolean,
): Promise<DonationFetchResult> {
  if (!allowDonation) {
    const res = await fetch(url, init)
    if (res.status !== 402) return { kind: 'response', response: res }
    return { kind: 'donation_required', requirement: decodeDonationRequirement(res) }
  }

  const client = buildDonationClient()
  const payFetch = wrapFetchWithPayment(fetch, client)
  try {
    const res = await payFetch(url, init)
    return { kind: 'response', response: res }
  } catch (error) {
    throw new DonationRefusedError(error instanceof Error ? error.message : String(error))
  }
}
