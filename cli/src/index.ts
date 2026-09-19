// cli/src/index.ts
const [, , command, pkg, version] = process.argv

async function main(): Promise<void> {
  if (command === 'verify') {
    const { runVerify } = await import('./verify.js')
    const exitCode = await runVerify(process.argv.slice(3))
    process.exit(exitCode)
  }

  if (!command || !pkg || !version) {
    console.log('Usage:')
    console.log('  spm status <pkg> <version>')
    console.log('  spm install <pkg> <version>')
    console.log(
      '  spm verify <attestation.json> [--lockfile <path>] [--key <keyid>:<base64pubkey>]... [--keys <spm-keys.json>]',
    )
    process.exit(1)
  }

  if (command === 'status') {
    const { checkTool } = await import('../../mcp/src/tools/check.js')
    const result = await checkTool.handler({ pkg, version })
    console.log(JSON.stringify(result, null, 2))
  } else if (command === 'install') {
    const { installTool } = await import('../../mcp/src/tools/install.js')
    const result = await installTool.handler({ pkg, version })
    console.log(JSON.stringify(result, null, 2))
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
