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

/**
 * Price of one reviewed entry, in microUSDC (SPEC.md §11.2, §11.4). The
 * spend cap and the withheld-entry price are both multiples of this value.
 * No config knob.
 */
export const PRICE_PER_ENTRY_MICRO = 1_000

/**
 * A donation never signs above `PRICE_PER_ENTRY_MICRO * entryCount`
 * microUSDC (SPEC.md §11.4): 1,000 for a tarball or a single attestation,
 * or 1,000 times the number of entries in a lockfile. No fixed cap and no
 * config knob — the only limit is this formula and the donor account
 * balance.
 */
export function donationCapMicro(entryCount: number): bigint {
  if (!Number.isInteger(entryCount) || entryCount < 0) {
    throw new Error(`entryCount must be a non-negative integer, got ${entryCount}`)
  }
  return BigInt(PRICE_PER_ENTRY_MICRO) * BigInt(entryCount)
}

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
function isDonationCompliant(requirement: PaymentRequirements, capMicro: bigint): boolean {
  if (requirement.asset !== USDC_ASSET_ID) return false
  if (requirementAsset(requirement) !== USDC_ASSET_ID) return false
  return BigInt(requirement.amount) <= capMicro
}

// Filters out any requirement above the spend cap or on a non-USDC asset.
// Registered as an x402Client policy, so the cap runs inside the normal
// wrapFetchWithPayment flow and enforces before a signature is ever created.
function donationCapPolicy(capMicro: bigint) {
  return (_version: number, requirements: PaymentRequirements[]): PaymentRequirements[] => {
    const compliant = requirements.filter((requirement) =>
      isDonationCompliant(requirement, capMicro),
    )
    if (compliant.length === 0) {
      const first = requirements[0]
      const amount = first ? first.amount : 'unknown'
      const asset = first ? first.asset : 'unknown'
      const network = IS_TESTNET ? 'TestNet' : 'MainNet'
      throw new DonationRefusedError(
        `refusing to donate ${amount} microUSDC of asset ${asset}: exceeds the ` +
          `${capMicro} microUSDC cap, or is not the ${network} USDC asset ${USDC_ASSET_ID}`,
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

function buildDonationClient(capMicro: bigint): x402Client {
  const client = new x402Client()
  registerExactAvmScheme(client, {
    signer: lazyDonorSigner(),
    networks: [CAIP2_NETWORK],
    policies: [donationCapPolicy(capMicro)],
  })
  return client
}

/** Header name SPM clients send on every request (SPEC.md §11.4, ADR 0006). */
export const DONATE_HEADER = 'X-SPM-Donate'

// Attaches X-SPM-Donate: 1 (opt-in) or X-SPM-Donate: 0 (opt-out) to init,
// preserving any headers the caller already set. wrapFetchWithPayment
// clones the same Request for its paid retry, so this header carries
// through to both the initial request and the retry unchanged.
function withDonateHeader(init: RequestInit | undefined, allowDonation: boolean): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set(DONATE_HEADER, allowDonation ? '1' : '0')
  return { ...init, headers }
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
 * Fetches url, paying a 402 only when allowDonation is true. Sends
 * X-SPM-Donate: 1 with the opt-in and X-SPM-Donate: 0 without it (SPEC.md
 * §11.4). Uses wrapFetchWithPayment for the whole pay-and-retry flow. The
 * spend cap and asset check run as an x402Client policy, so a refused
 * requirement never signs and never retries.
 *
 * `entryCount` is the number of lockfile entries the caller is sending (1
 * for a tarball or a single attestation). It sets the spend cap:
 * `PRICE_PER_ENTRY_MICRO * entryCount` microUSDC — never a fixed cap.
 */
export async function fetchWithDonation(
  url: string,
  init: RequestInit | undefined,
  allowDonation: boolean,
  entryCount = 1,
): Promise<DonationFetchResult> {
  const requestInit = withDonateHeader(init, allowDonation)

  if (!allowDonation) {
    const res = await fetch(url, requestInit)
    if (res.status !== 402) return { kind: 'response', response: res }
    return { kind: 'donation_required', requirement: decodeDonationRequirement(res) }
  }

  const client = buildDonationClient(donationCapMicro(entryCount))
  const payFetch = wrapFetchWithPayment(fetch, client)
  try {
    const res = await payFetch(url, requestInit)
    return { kind: 'response', response: res }
  } catch (error) {
    throw new DonationRefusedError(error instanceof Error ? error.message : String(error))
  }
}
