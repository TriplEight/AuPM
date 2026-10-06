// cli/src/summary.ts
//
// The lockfile summary that `aupm install`, `aupm pnpm` and `aupm attest` print. It has the
// same shape with and without `--donate`. The counts come from the summary that the server
// returns. This module never withholds an integrity mismatch or an unresolvable entry
// (CLAUDE.md invariant 4). Amounts are integer micro-units; no float touches an amount.
import { EXPLORER_NETWORK, PRICE_PER_ENTRY_MICRO } from 'aupm-mcp/donor'
import { formatMicro } from './donor-text.js'

export interface LockfileCounts {
  reviewed: number
  unreviewed: number
  integrityMismatch: number
  unresolvable: number
}

export interface SummaryInput {
  counts: LockfileCounts
  donate: boolean
  settlement: { txid: string; amountMicro: number } | null
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 0
}

/** Reads the four counts out of the server summary. A missing or malformed count is 0. */
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
  return `${n} audited ${n === 1 ? 'package' : 'packages'}`
}

/** Returns the summary lines. The caller adds its own prefix. */
export function summaryLines({ counts, donate, settlement }: SummaryInput): string[] {
  const lines = [
    `Audited: ${counts.reviewed}. Not audited: ${counts.unreviewed}. ` +
      `Integrity mismatch: ${counts.integrityMismatch}. Unresolvable: ${counts.unresolvable}.`,
  ]
  if (counts.reviewed === 0) return lines
  if (donate && settlement) {
    const amount = formatMicro(BigInt(settlement.amountMicro))
    lines.push(`Donated ${amount} USDC for ${packages(counts.reviewed)}.`)
    lines.push(
      `Settlement txid: ${settlement.txid} ` +
        `https://lora.algokit.io/${EXPLORER_NETWORK}/transaction/${settlement.txid}`,
    )
  } else if (donate) {
    lines.push('No donation settled.')
  } else {
    const amount = formatMicro(BigInt(counts.reviewed) * BigInt(PRICE_PER_ENTRY_MICRO))
    lines.push(
      `A donation would be ${amount} USDC for ${packages(counts.reviewed)}. ` +
        'Add --donate to send it.',
    )
  }
  lines.push(
    '--donate pays for every audited package in the whole lockfile, ' +
      'not only the package named on the command line.',
  )
  return lines
}
