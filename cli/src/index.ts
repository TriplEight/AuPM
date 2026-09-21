const argv = process.argv.slice(2)
const [command] = argv

const USAGE_LINES = [
  'Usage:',
  '  spm status <pkg> <version>',
  '  spm install <pkg> <version> [--donate]',
  '  spm verify <attestation.json> [--lockfile <path>] [--key <keyid>:<base64pubkey>]... [--keys <spm-keys.json>]',
]

/** Splits --donate out of the remaining positional args, wherever it appears. */
function extractDonateFlag(args: string[]): { allowDonation: boolean; rest: string[] } {
  const rest = args.filter((arg) => arg !== '--donate')
  return { allowDonation: rest.length !== args.length, rest }
}

async function main(): Promise<void> {
  if (command === 'verify') {
    const { runVerify } = await import('./verify.js')
    const exitCode = await runVerify(argv.slice(1))
    process.exit(exitCode)
  }

  const { allowDonation, rest } = extractDonateFlag(argv.slice(1))
  const [pkg, version] = rest

  if (!command || !pkg || !version) {
    for (const line of USAGE_LINES) console.log(line)
    process.exit(1)
  }

  if (command === 'status') {
    const { checkTool } = await import('../../mcp/src/tools/check.js')
    const result = await checkTool.handler({ pkg, version })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'install') {
    const { installTool } = await import('../../mcp/src/tools/install.js')
    const result = await installTool.handler({ pkg, version, allowDonation })
    console.log(JSON.stringify(result, null, 2))
    if (result.status === 'donation_required') {
      process.exit(2)
    }
    if (result.loraUrl) console.log('\nLora:', result.loraUrl)
  } else {
    console.error('Unknown command:', command)
    process.exit(1)
  }
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
