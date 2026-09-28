const argv = process.argv.slice(2)
const [command] = argv

const USAGE_LINES = [
  'Usage:',
  '  aupm <npm args>                     runs npm against the AuPM registry',
  '  aupm install ms@2.1.3 [--donate] [--attest-out <path>]',
  '  aupm attest <lockfile> [--donate] [--out <path>]',
  '  aupm verify <attestation.json> [--lockfile <path>] [--key <keyid>:<base64pubkey>]... [--keys <aupm-keys.json>]',
  '',
  'Every first argument other than attest and verify goes to npm unchanged.',
  'AuPM adds only --donate and --attest-out <path>; both are removed before npm runs.',
]

async function main(): Promise<void> {
  if (command === 'verify') {
    const { runVerify } = await import('./verify.js')
    const exitCode = await runVerify(argv.slice(1))
    process.exit(exitCode)
  }

  if (command === 'attest') {
    const { runAttest } = await import('./attest.js')
    const exitCode = await runAttest(argv.slice(1))
    process.exit(exitCode)
  }

  if (!command) {
    for (const line of USAGE_LINES) console.log(line)
    process.exit(1)
  }

  const { runNpmWrapper } = await import('./npm-wrapper.js')
  process.exit(await runNpmWrapper(argv))
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
