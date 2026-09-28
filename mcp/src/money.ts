// mcp/src/money.ts
//
// Formats an integer microUSDC amount as a dollar string for user-facing
// text (CLI and MCP output, docs/TASK.md "P3"). Money math itself always
// stays in integer micro-units (CLAUDE.md invariant 7) — this only formats
// an already-computed amount for display, never the other way round.

const MICRO_PER_DOLLAR = 1_000_000

/**
 * Formats microUSDC as a dollar string, trimmed to the shortest exact
 * representation with at least two fraction digits, e.g. 0 -> "$0.00",
 * 1 -> "$0.000001", 1_000 -> "$0.001", 1_000_000 -> "$1.00".
 *
 * Uses integer arithmetic only — never a float division — so a value is
 * never rounded away.
 */
export function formatMicroUsd(microUsd: number): string {
  if (!Number.isInteger(microUsd) || microUsd < 0) {
    throw new Error(`microUsd must be a non-negative integer, got ${microUsd}`)
  }
  const dollars = Math.trunc(microUsd / MICRO_PER_DOLLAR)
  const remainderMicro = microUsd % MICRO_PER_DOLLAR
  const fraction = String(remainderMicro).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0')
  return `$${dollars}.${fraction}`
}
