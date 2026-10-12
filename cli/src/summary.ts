// cli/src/summary.ts
//
// The lockfile summary that `aupm install`, `aupm pnpm` and `aupm attest` print. It has the
// same shape with and without `--donate`. The counts come from the summary that the server
// returns. This module never withholds an integrity mismatch or an unresolvable entry
// (CLAUDE.md invariant 4). Amounts are integer micro-units; no float touches an amount.
import { EXPLORER_NETWORK, PRICE_PER_ENTRY_MICRO } from 'aupm-mcp/donor'
import { AUPM_DONOR_MNEMONIC_ENV, readDonorKeyFile } from 'aupm-mcp/donor-key'
import { formatMicro } from './donor-text.js'

/** A count is `unknown` when the server value is not a non-negative integer. */
export type Count = number | 'unknown'

export interface LockfileCounts {
  reviewed: Count
  unreviewed: Count
  integrityMismatch: Count
  unresolvable: Count
}

export interface SummaryInput {
  counts: LockfileCounts
  donate: boolean
  settlement: { txid: string; amountMicro: number } | null
  /** True when a donor key exists. The offer then skips the `aupm donor init` step. */
  hasDonorKey: boolean
}

/** True when the donor key comes from the environment or a key file exists. Reads no key. */
export function donorKeyExists(): boolean {
  if (process.env[AUPM_DONOR_MNEMONIC_ENV]) return true
  try {
    return readDonorKeyFile() !== null
  } catch {
    return true
  }
}

function count(value: unknown): Count {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 'unknown'
}

/** Reads the four counts out of the server summary. A missing or malformed count is `unknown`, never 0. */
export function countsFromSummary(summary: unknown): LockfileCounts {
  const fields = (summary ?? {}) as Record<string, unknown>
  return {
    reviewed: count(fields.reviewed),
    unreviewed: count(fields.unreviewed),
    integrityMismatch: count(fields.integrityMismatch),
    unresolvable: count(fields.unresolvable),
  }
}

function packages(n: number): string {
  return `${n} reviewed ${n === 1 ? 'package' : 'packages'}`
}

function isUnknown(counts: LockfileCounts): boolean {
  return Object.values(counts).includes('unknown')
}

function offerLines(reviewed: number, hasDonorKey: boolean): string[] {
  const amount = formatMicro(BigInt(reviewed) * BigInt(PRICE_PER_ENTRY_MICRO))
  const how = hasDonorKey
    ? 'To donate, add --donate.'
    : 'To donate, run `aupm donor init` once, then add --donate.'
  return [
    `You can donate ${amount} USDC for ${packages(reviewed)}. This is optional. ${how}`,
    '--donate pays for all reviewed packages in the lockfile, not only the package you named.',
  ]
}

/** Returns the summary lines. The caller adds its own prefix. */
export function summaryLines({ counts, donate, settlement, hasDonorKey }: SummaryInput): string[] {
  const lines = [
    `Reviewed: ${counts.reviewed}. Not reviewed: ${counts.unreviewed}. ` +
      `Integrity mismatch: ${counts.integrityMismatch}. Unresolvable: ${counts.unresolvable}.`,
  ]
  if (isUnknown(counts)) {
    lines.push(
      'AuPM could not read the counts from the server answer. ' +
        'The install is not affected. Try again later.',
    )
  }
  if (typeof counts.integrityMismatch === 'number' && counts.integrityMismatch > 0) {
    lines.push(
      'Do not use packages with an integrity mismatch. ' +
        'Run `aupm attest <lockfile>` and read the packages list in the file it writes.',
    )
  }
  const { reviewed } = counts
  if (reviewed === 'unknown' || reviewed === 0) return lines
  if (donate && settlement) {
    const amount = formatMicro(BigInt(settlement.amountMicro))
    lines.push(`Donated ${amount} USDC for ${packages(reviewed)}.`)
    lines.push(
      `Settlement txid: ${settlement.txid} ` +
        `https://lora.algokit.io/${EXPLORER_NETWORK}/transaction/${settlement.txid}`,
    )
  } else if (donate) {
    lines.push(
      'No donation was paid. The install is not affected. ' +
        'Run `aupm donor status` to check your donor wallet.',
    )
  } else {
    lines.push(...offerLines(reviewed, hasDonorKey))
  }
  return lines
}
