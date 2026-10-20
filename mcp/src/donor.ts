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
  DEFAULT_ALGOD_MAINNET,
  DEFAULT_ALGOD_TESTNET,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from '@x402-avm/avm'
import { registerExactAvmScheme } from '@x402-avm/avm/exact/client'
import { x402Client } from '@x402-avm/core/client'
import { decodePaymentRequiredHeader, decodePaymentResponseHeader } from '@x402-avm/core/http'
import type { PaymentRequirements } from '@x402-avm/core/types'
import { wrapFetchWithPayment } from '@x402-avm/fetch'
import { DEFAULT_MULTIPLIER_TENTHS, describeMultiplier, type MultiplierSetting } from './config.js'
import { AUPM_DONOR_MNEMONIC_ENV, loadDonorMnemonic } from './donor-key.js'
import { signerFromMnemonic } from './signer.js'

// NETWORK selects Algorand MainNet (default) or TestNet rehearsal.
const NETWORK = (process.env.NETWORK ?? 'mainnet').toLowerCase()
export const IS_TESTNET = NETWORK === 'testnet'
export const CAIP2_NETWORK = IS_TESTNET ? ALGORAND_TESTNET_CAIP2 : ALGORAND_MAINNET_CAIP2
export const USDC_ASSET_ID = IS_TESTNET ? USDC_TESTNET_ASA_ID : USDC_MAINNET_ASA_ID
export const EXPLORER_NETWORK = IS_TESTNET ? 'testnet' : 'mainnet'

// The exact scheme falls back to the TestNet algod when no algod is set, whatever the payment's
// network is (@x402-avm/avm 2.6.1). A MainNet payment built from TestNet params carries the
// TestNet genesis hash, and the facilitator rejects it. The library reads ALGOD_MAINNET_URL
// and ALGOD_TESTNET_URL for these defaults.
const DONOR_ALGOD_URL = IS_TESTNET ? DEFAULT_ALGOD_TESTNET : DEFAULT_ALGOD_MAINNET

/** Algod URL for the selected network; ALGOD_MAINNET_URL or ALGOD_TESTNET_URL overrides it. */
export function donorAlgodUrl(): string {
  const override = IS_TESTNET ? process.env.ALGOD_TESTNET_URL : process.env.ALGOD_MAINNET_URL
  return override || DONOR_ALGOD_URL
}

/** Base donation for one reviewed entry, in microUSDC ($0.01). It is the price at x1. */
export const BASE_DONATION_MICRO = 10_000

/** Price of one tenth of the multiplier, in microUSDC. The minimum, x0.1, is one tenth. */
export const MICRO_PER_TENTH = BASE_DONATION_MICRO / 10

/** Price of one reviewed entry at a multiplier of `tenths` tenths, in microUSDC. */
export function entryPriceMicro(tenths: number): number {
  if (!Number.isInteger(tenths) || tenths < 1 || tenths > 1000) {
    throw new Error(`multiplier must be an integer from 1 to 1000 tenths, got ${tenths}`)
  }
  return MICRO_PER_TENTH * tenths
}

/**
 * A donation never signs above `MICRO_PER_TENTH * tenths * entryCount`
 * microUSDC: one entry for a tarball or a single attestation,
 * or the number of entries in a lockfile. The only other limit is the donor account
 * balance.
 */
export function donationCapMicro(entryCount: number, tenths = DEFAULT_MULTIPLIER_TENTHS): bigint {
  if (!Number.isInteger(entryCount) || entryCount < 0) {
    throw new Error(`entryCount must be a non-negative integer, got ${entryCount}`)
  }
  return BigInt(entryPriceMicro(tenths)) * BigInt(entryCount)
}

/** What a donation costs: the base price, the multiplier text and the total, in microUSDC. */
export type DonationReceipt = {
  baseMicro: number
  multiplier: string
  totalMicro: number
}

export function donationReceipt(setting: MultiplierSetting, totalMicro: number): DonationReceipt {
  return {
    baseMicro: BASE_DONATION_MICRO,
    multiplier: describeMultiplier(setting),
    totalMicro,
  }
}

/** A decoded PAYMENT-REQUIRED requirement, used to report a price without paying it. */
export type DonationRequirement = {
  priceMicro: number
  resourceUrl: string
  asset: string
}

/** Thrown when every 402 requirement fails the spend cap or the asset check. Never signs. */
export class DonationRefusedError extends Error {}

/** Why a donation did not happen. Each code has its own reason text. */
export type DonationFailureCode =
  | 'network_mismatch'
  | 'no_donor_key'
  | 'donor_key_invalid'
  | 'cap_refused'
  | 'insufficient_usdc'
  | 'payment_rejected'
  | 'facilitator_error'
  | 'network_error'
  | 'other'

/** One line that tells the user why no donation was paid. `reason` is the full text. */
export type DonationFailureReport = { code: DonationFailureCode; reason: string }

/** A donation attempt that failed. `message` is the one-line reason for the user. */
export class DonationFailure extends DonationRefusedError {
  constructor(
    readonly code: DonationFailureCode,
    message: string,
  ) {
    super(message)
  }

  report(): DonationFailureReport {
    return { code: this.code, reason: this.message }
  }
}

const NOT_PAID = 'No donation was paid:'
const MAX_DETAIL_CHARS = 200

function detail(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > MAX_DETAIL_CHARS ? `${flat.slice(0, MAX_DETAIL_CHARS)}...` : flat
}

function networkName(caip2: string): string {
  if (caip2 === ALGORAND_MAINNET_CAIP2) return 'MainNet'
  if (caip2 === ALGORAND_TESTNET_CAIP2) return 'TestNet'
  return caip2
}

function networkMismatchFailure(serverNetwork: string, origin: string): DonationFailure {
  const server = networkName(serverNetwork)
  const client = networkName(CAIP2_NETWORK)
  const knownServer =
    serverNetwork === ALGORAND_MAINNET_CAIP2 || serverNetwork === ALGORAND_TESTNET_CAIP2
  const setNetwork = knownServer ? `set NETWORK=${server.toLowerCase()}` : 'change NETWORK'
  return new DonationFailure(
    'network_mismatch',
    `${NOT_PAID} the server ${origin} takes payment on ${server}, but this client uses ${client}. ` +
      `AuPM signed nothing. Fix: set AUPM_PROXY_URL to a ${client} server, or ${setNetwork}.`,
  )
}

function failureFromPaymentError(status: number, error: string | undefined): DonationFailure {
  if (status >= 500) {
    return new DonationFailure(
      'facilitator_error',
      `${NOT_PAID} the payment service answered ${status}. This can pass. Try again later.`,
    )
  }
  if (error && /insufficient|balance|underflow|overspend/i.test(error)) {
    return new DonationFailure(
      'insufficient_usdc',
      `${NOT_PAID} the donor account has too little USDC. ` +
        'Add USDC, then run the command again. Run `aupm donor status` to check the account.',
    )
  }
  const why = error ? ` (${detail(error)})` : ''
  return new DonationFailure(
    'payment_rejected',
    `${NOT_PAID} the server rejected the payment${why}. ` +
      'Run `aupm donor status` to check the donor account.',
  )
}

function failureFromThrown(error: unknown): DonationFailure {
  if (error instanceof DonationFailure) return error
  const message = error instanceof Error ? error.message : String(error)
  if (error instanceof TypeError || /fetch failed|ECONN|ETIMEDOUT|ENOTFOUND/.test(message)) {
    return new DonationFailure(
      'network_error',
      `${NOT_PAID} AuPM could not reach the server or the payment service. Try again later.`,
    )
  }
  return new DonationFailure('other', `${NOT_PAID} ${detail(message)}.`)
}

function failureFromKeyError(error: unknown): DonationFailure {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith('No donor key found')) {
    return new DonationFailure(
      'no_donor_key',
      `${NOT_PAID} no donor key found. Run \`aupm donor init\` once, or set ${AUPM_DONOR_MNEMONIC_ENV}, then run the command again.`,
    )
  }
  return new DonationFailure('donor_key_invalid', `${NOT_PAID} ${detail(message)}`)
}

/** Remembers the first typed failure, because the x402 client can wrap the error it gets. */
type FailureTrace = { failure?: DonationFailure }

function recorded(trace: FailureTrace, failure: DonationFailure): DonationFailure {
  trace.failure ??= failure
  return trace.failure
}

function requirementAsset(requirement: PaymentRequirements): unknown {
  const extra = requirement.extra
  return extra && typeof extra === 'object' ? (extra as { asset?: unknown }).asset : undefined
}

// A requirement is fine to donate only when both the top-level asset and
// extra.asset name the selected network's USDC ASA, and the amount is at or
// under the spend cap. extra.asset is always explicit; an
// omitted asset may resolve to ALGO instead of USDC.
function isDonationCompliant(requirement: PaymentRequirements, capMicro: bigint): boolean {
  if (requirement.asset !== USDC_ASSET_ID) return false
  if (requirementAsset(requirement) !== USDC_ASSET_ID) return false
  return BigInt(requirement.amount) <= capMicro
}

// Filters out any requirement above the spend cap or on a non-USDC asset.
// Registered as an x402Client policy, so the cap runs inside the normal
// wrapFetchWithPayment flow and enforces before a signature is ever created.
// It passes on only the first compliant requirement, so the requirement it
// reports through onApproved is the one the client signs.
function donationCapPolicy(
  capMicro: bigint,
  onApproved: (amountMicro: number) => void,
  trace: FailureTrace,
) {
  return (_version: number, requirements: PaymentRequirements[]): PaymentRequirements[] => {
    const compliant = requirements.filter((requirement) =>
      isDonationCompliant(requirement, capMicro),
    )
    if (compliant.length === 0) {
      const first = requirements[0]
      const amount = first ? first.amount : 'unknown'
      const asset = first ? first.asset : 'unknown'
      const network = IS_TESTNET ? 'TestNet' : 'MainNet'
      throw recorded(
        trace,
        new DonationFailure(
          'cap_refused',
          `${NOT_PAID} refusing to donate ${amount} microUSDC of asset ${asset}: exceeds the ` +
            `${capMicro} microUSDC cap, or is not the ${network} USDC asset ${USDC_ASSET_ID}. ` +
            'AuPM signed nothing.',
        ),
      )
    }
    const [approved] = compliant as [PaymentRequirements]
    onApproved(Number(approved.amount))
    return [approved]
  }
}

// Derives the donor signer only when a payment is about to be created -- that only happens once
// a real 402 passed the cap policy. A free (200) response never touches AUPM_DONOR_MNEMONIC.
// The key derivation is async, so the before-creation hook loads the signer before the scheme
// reads `address`.
function lazyDonorSigner(trace: FailureTrace): {
  signer: ClientAvmSigner
  load: () => Promise<void>
} {
  let cached: ClientAvmSigner | undefined
  function loaded(): ClientAvmSigner {
    if (!cached) throw new Error('donor signer used before it was loaded')
    return cached
  }
  return {
    load: async () => {
      if (cached) return
      try {
        cached = await signerFromMnemonic(loadDonorMnemonic())
      } catch (error) {
        throw recorded(trace, failureFromKeyError(error))
      }
    },
    signer: {
      get address() {
        return loaded().address
      },
      signTransactions: (txns, indexesToSign) => loaded().signTransactions(txns, indexesToSign),
    },
  }
}

function buildDonationClient(
  capMicro: bigint,
  onApproved: (amountMicro: number) => void,
  trace: FailureTrace,
): x402Client {
  const client = new x402Client()
  const { signer, load } = lazyDonorSigner(trace)
  registerExactAvmScheme(client, {
    signer,
    algodConfig: { algodUrl: DONOR_ALGOD_URL },
    networks: [CAIP2_NETWORK],
    policies: [donationCapPolicy(capMicro, onApproved, trace)],
  })
  client.onBeforePaymentCreation(load)
  return client
}

/** A settled donation: the facilitator's transaction id and the amount signed. */
export type Settlement = {
  txid: string
  amountMicro: number
}

type DecodedSettleResponse = {
  success: boolean
  transaction: string
}

function isDecodedSettleResponse(value: unknown): value is DecodedSettleResponse {
  return (
    typeof value === 'object' &&
    value !== null &&
    'success' in value &&
    typeof (value as { success: unknown }).success === 'boolean' &&
    'transaction' in value &&
    typeof (value as { transaction: unknown }).transaction === 'string'
  )
}

/**
 * Reads the settlement txid from the PAYMENT-RESPONSE header the server's
 * @x402-avm/hono middleware sets on a paid response (legacy name
 * X-PAYMENT-RESPONSE also accepted by @x402-avm/core). A missing header
 * means no payment was made. A present but malformed or unsuccessful header
 * means settlement is unproven, which must never be reported as free.
 */
export function readSettlementTxid(res: Response): string | null {
  const header = res.headers.get('PAYMENT-RESPONSE') ?? res.headers.get('X-PAYMENT-RESPONSE')
  if (!header) return null

  let decoded: unknown
  try {
    decoded = decodePaymentResponseHeader(header)
  } catch {
    throw new Error('malformed PAYMENT-RESPONSE header')
  }

  if (!isDecodedSettleResponse(decoded) || !decoded.success || !decoded.transaction) {
    throw new Error('unsettled PAYMENT-RESPONSE header')
  }
  return decoded.transaction
}

/** Header name AuPM clients send on every request. */
export const DONATE_HEADER = 'X-AuPM-Donate'
export const MULTIPLIER_HEADER = 'X-AuPM-Multiplier'

// Attaches X-AuPM-Donate: 1 (opt-in) or X-AuPM-Donate: 0 (opt-out) to init,
// plus X-AuPM-Multiplier: <tenths> with the opt-in,
// preserving any headers the caller already set. wrapFetchWithPayment
// clones the same Request for its paid retry, so this header carries
// through to both the initial request and the retry unchanged.
function withDonateHeader(
  init: RequestInit | undefined,
  allowDonation: boolean,
  tenths: number,
): RequestInit {
  const headers = new Headers(init?.headers)
  headers.set(DONATE_HEADER, allowDonation ? '1' : '0')
  if (allowDonation) headers.set(MULTIPLIER_HEADER, String(tenths))
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

// Compares the network in a 402 with CAIP2_NETWORK before any payload is built. A mismatch
// throws, so the x402 client never runs and nothing is signed.
function networkGuardedFetch(url: string, trace: FailureTrace): typeof fetch {
  return async (input, init) => {
    const res = await fetch(input, init)
    if (res.status !== 402) return res
    const header = res.headers.get('PAYMENT-REQUIRED')
    if (!header) return res
    let accepts: PaymentRequirements[]
    try {
      accepts = decodePaymentRequiredHeader(header).accepts
    } catch {
      return res
    }
    const [first] = accepts
    if (!first || accepts.some((accepted) => accepted.network === CAIP2_NETWORK)) return res
    throw recorded(trace, networkMismatchFailure(first.network, new URL(url).origin))
  }
}

// The reason text of a failed paid retry: the PAYMENT-REQUIRED `error` field, else a JSON body.
async function paymentErrorText(res: Response): Promise<string | undefined> {
  try {
    const header = res.headers.get('PAYMENT-REQUIRED')
    const fromHeader = header ? decodePaymentRequiredHeader(header).error : undefined
    if (fromHeader) return fromHeader
    const body: unknown = await res.clone().json()
    const error = (body as { error?: unknown } | null)?.error
    return typeof error === 'string' ? error : undefined
  } catch {
    return undefined
  }
}

export type DonationFetchResult =
  | { kind: 'response'; response: Response; settlement: Settlement | null }
  | { kind: 'donation_required'; requirement: DonationRequirement }

/**
 * Fetches url, paying a 402 only when allowDonation is true. Sends
 * X-AuPM-Donate: 1 with the opt-in and X-AuPM-Donate: 0 without it. Uses wrapFetchWithPayment for the whole pay-and-retry flow. The
 * spend cap and asset check run as an x402Client policy, so a refused
 * requirement never signs and never retries.
 *
 * `entryCount` is the number of lockfile entries the caller is sending (1
 * for a tarball or a single attestation). `tenths` is the donor multiplier, 1 to 1000.
 * Both set the spend cap: `MICRO_PER_TENTH * tenths * entryCount` microUSDC.
 * The request carries `X-AuPM-Multiplier: <tenths>` with the opt-in.
 *
 * A paid response carries `settlement`: the settlement txid from
 * PAYMENT-RESPONSE and the amount of the requirement the donor signed.
 * A free response carries `settlement: null`.
 */
export async function fetchWithDonation(
  url: string,
  init: RequestInit | undefined,
  allowDonation: boolean,
  entryCount = 1,
  tenths = DEFAULT_MULTIPLIER_TENTHS,
): Promise<DonationFetchResult> {
  const requestInit = withDonateHeader(init, allowDonation, tenths)

  if (!allowDonation) {
    const res = await fetch(url, requestInit)
    if (res.status !== 402) return { kind: 'response', response: res, settlement: null }
    return { kind: 'donation_required', requirement: decodeDonationRequirement(res) }
  }

  const approved: { micro: number | null } = { micro: null }
  const trace: FailureTrace = {}
  const client = buildDonationClient(
    donationCapMicro(entryCount, tenths),
    (amountMicro) => {
      approved.micro = amountMicro
    },
    trace,
  )
  const payFetch = wrapFetchWithPayment(networkGuardedFetch(url, trace), client)
  let res: Response
  try {
    res = await payFetch(url, requestInit)
  } catch (error) {
    throw trace.failure ?? failureFromThrown(error)
  }
  const txid = readSettlementTxid(res)
  if (txid === null) {
    if (approved.micro !== null && (res.status === 402 || res.status >= 500)) {
      throw failureFromPaymentError(res.status, await paymentErrorText(res))
    }
    return { kind: 'response', response: res, settlement: null }
  }
  if (approved.micro === null) {
    throw new Error(`settlement ${txid} arrived for a request no donation requirement approved`)
  }
  return { kind: 'response', response: res, settlement: { txid, amountMicro: approved.micro } }
}
