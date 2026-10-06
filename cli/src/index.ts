#!/usr/bin/env node
const argv = process.argv.slice(2)
const [command] = argv

const USAGE_LINES = [
  'Usage:',
  '  aupm <npm args>                     runs npm against the AuPM registry',
  '  aupm install ms@2.1.3 [--donate|--no-donate] [--attest-out <path>]',
  '  aupm pnpm <pnpm args> [--donate|--no-donate] [--attest-out <path>]   runs pnpm against the AuPM registry',
  '  aupm npx <npx args>                 runs npx against the AuPM registry (no --donate)',
  '  aupm attest <lockfile> [--donate|--no-donate] [--out <path>]',
  '  aupm verify <attestation.json> [--lockfile <path>] [--key <keyid>:<base64pubkey>]... [--keys <aupm-keys.json>]',
  '  aupm donor init      create a donor key and show the next steps',
  '  aupm donor optin     opt the donor in to USDC (one check, no waiting)',
  '  aupm donor [status]  show the balances and the next step',
  '  aupm config set donate <true|false>   always donate (or never) without the flag',
  '  aupm config get donate               show the effective value and where it comes from',
  '',
  'Every first argument other than attest, verify, donor, config, pnpm and npx goes to npm unchanged.',
  'AuPM adds only --donate, --no-donate and --attest-out <path>; all are removed before npm or pnpm runs.',
  'Donation setting, highest first: --donate or --no-donate, env AUPM_DONATE=true|false,',
  'config file $XDG_CONFIG_HOME/aupm/config.toml (donate = true), off.',
  'attest and verify accept package-lock.json and pnpm-lock.yaml (lockfileVersion 9.0).',
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

  if (command === 'config') {
    const { runConfig } = await import('./config.js')
    process.exit(runConfig(argv.slice(1)))
  }

  if (command === 'donor') {
    const { runDonor } = await import('./donor.js')
    process.exit(await runDonor(argv.slice(1)))
  }

  if (!command) {
    for (const line of USAGE_LINES) console.log(line)
    process.exit(1)
  }

  const { runWrapper } = await import('./npm-wrapper.js')
  if (command === 'pnpm' || command === 'npx') {
    process.exit(await runWrapper(command, argv.slice(1)))
  }
  process.exit(await runWrapper('npm', argv))
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
