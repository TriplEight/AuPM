# The install summary points to the package manager audit

Status: accepted (2026-10-12). Ends when the ADR 0026 autoscan flags ship (Phase 2).

After the counts line, `aupm install`, `aupm pnpm` and `aupm yarn` print this line every time:

`Known advisories: run \`<tool> audit\` (source: npm, GitHub Advisory Database). AuPM does not check advisories yet.`

`<tool>` is `npm`, `pnpm` or `yarn`. The wrapper adds its `aupm: ` prefix.

Rules:

- The line is a fixed pointer. AuPM reads no audit data, runs no audit and makes no extra
  network call.
- AuPM makes no claim about advisories. The line names npm and the GitHub Advisory Database as
  the source.
- The line never says "safe" or "clean". Every security claim names who made it and what it
  covers (SPEC rule). ADR 0026 applies the same rule.
- The line does not refer to the audit output of npm. `--no-audit` makes npm skip that output.
- `aupm attest`, the MCP server and the Action job summary do not print the line.
- AuPM removes the line when the ADR 0026 autoscan flags ship (Phase 2). The flags then carry
  their own source and date.

SPEC §15 does not change. Nothing in AuPM parses or summarizes advisories.
