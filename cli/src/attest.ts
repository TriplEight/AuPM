// cli/src/attest.ts
//
// `spm attest <lockfile> [--donate] [--out <path>]` — requests a signed
// lockfile attestation via the MCP attest_lockfile handler and writes the
// envelope to disk. Donation is opt-in: without --donate, a 402 reports the
// price and exits 2, and nothing is signed.
import fs from 'node:fs'
import { attestLockfileTool } from '../../mcp/src/tools/attest.js'

const DEFAULT_OUT_PATH = 'spm-attestation.json'
const USAGE = 'Usage: spm attest <lockfile> [--donate] [--out <path>]'

interface ParsedAttestArgs {
  lockfilePath?: string
  allowDonation: boolean
  outPath: string
}

/**
 * Thrown by parseAttestArgv when --out is the final argv element and has no
 * value. A usage error, not a skip: the caller must reject the run.
 */
export class AttestArgvUsageError extends Error {}

function parseAttestArgv(argv: string[]): ParsedAttestArgs {
  const result: ParsedAttestArgs = { allowDonation: false, outPath: DEFAULT_OUT_PATH }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--donate') {
      result.allowDonation = true
      index += 1
    } else if (arg === '--out') {
      const value = argv[index + 1]
      if (value === undefined) {
        throw new AttestArgvUsageError('--out requires a value: <path>')
      }
      result.outPath = value
      index += 2
    } else if (result.lockfilePath === undefined && arg !== undefined && !arg.startsWith('--')) {
      result.lockfilePath = arg
      index += 1
    } else {
      index += 1
    }
  }
  return result
}

/**
 * Runs `spm attest` end to end: parses argv, requests the attestation,
 * writes it to disk, and returns the process exit code. A donation_required
 * result (402 without --donate) exits 2 and writes nothing.
 */
export async function runAttest(argv: string[]): Promise<number> {
  let args: ParsedAttestArgs
  try {
    args = parseAttestArgv(argv)
  } catch (error) {
    if (error instanceof AttestArgvUsageError) {
      console.log(`usage error: ${error.message}`)
      console.log(USAGE)
      return 1
    }
    throw error
  }

  if (!args.lockfilePath) {
    console.log(USAGE)
    return 1
  }

  const result = await attestLockfileTool.handler({
    lockfilePath: args.lockfilePath,
    allowDonation: args.allowDonation,
  })

  if (result.status === 'donation_required') {
    console.log(`donation required: ${result.priceMicro} microUSDC for ${result.resourceUrl}`)
    console.log('retry with --donate to opt in')
    return 2
  }

  fs.writeFileSync(args.outPath, JSON.stringify(result.attestation, null, 2))
  console.log(`attestation written to ${args.outPath}`)
  console.log(JSON.stringify(result.summary, null, 2))
  return 0
}
