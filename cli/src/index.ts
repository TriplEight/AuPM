#!/usr/bin/env node
const argv = process.argv.slice(2)
const [command] = argv

const USAGE_LINES = [
  'Usage:',
  '  aupm <npm args>                     runs npm against the AuPM registry',
  '  aupm install ms@2.1.3 [--donate|--no-donate] [--attest-out <path>]',
  '  aupm pnpm <pnpm args> [--donate|--no-donate] [--attest-out <path>]   runs pnpm against the AuPM registry',
  '  aupm yarn <yarn args> [--donate|--no-donate] [--attest-out <path>]   runs yarn classic (v1) against the AuPM registry',
  '  aupm npx <npx args>                 runs npx against the AuPM registry (no --donate)',
  '  aupm attest <lockfile> [--donate|--no-donate] [--out <path>]',
  '  aupm verify <attestation.json> [--lockfile <path>] [--key <keyid>:<base64pubkey>]... [--keys <aupm-keys.json>]',
  '  aupm auditor review <name>@<version> [--login <login>] [--derivation <n>|--address <addr>]',
  '                                       anchor a review (key on a hidden prompt)',
  '  aupm auditor balance <login>         credited balance, MIN_CLAIM, opt-in (read-only)',
  '  aupm auditor claim [--login <login>] [--derivation <n>|--address <addr>]',
  '                                       claim the credited balance (key on a hidden prompt)',
  '  aupm auditor status <login>          reviews of one auditor (read-only)',
  '  aupm donor init [--yes]  create a donor key; on a terminal, guide the steps (--yes: print them)',
  '  aupm donor optin     opt the donor in to USDC (one check, no waiting)',
  '  aupm donor [status]  show the balances and the next step',
  '  aupm config set donate <true|false>   always donate (or never) without the flag',
  '  aupm config get donate               show the effective value and where it comes from',
  '  aupm config set multiplier <x>       donation per reviewed package, x0.1 to x100 (default $0.01 = x1, minimum $0.001)',
  '  aupm config get multiplier           show the effective multiplier and where it comes from',
  '',
  'Every first argument other than attest, verify, auditor, donor, config, pnpm, yarn and npx goes to npm unchanged.',
  'AuPM adds only --donate, --no-donate and --attest-out <path>; all are removed before npm, pnpm or yarn runs.',
  'Donation setting, highest first: --donate or --no-donate, env AUPM_DONATE=true|false,',
  'config file $XDG_CONFIG_HOME/aupm/config.toml (donate = true), off.',
  'Multiplier setting, highest first: env AUPM_MULTIPLIER=<x>, config file (multiplier = "<x>"), x1.',
  'A donation per reviewed package is the multiplier times 10,000 microUSDC: x1 is $0.01 (the default) and x0.1 is $0.001.',
  'attest and verify accept package-lock.json, pnpm-lock.yaml (lockfileVersion 9.0) and yarn.lock (yarn classic v1).',
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

  if (command === 'auditor') {
    const { runAuditor } = await import('./auditor.js')
    process.exit(await runAuditor(argv.slice(1)))
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
  if (command === 'pnpm' || command === 'yarn' || command === 'npx') {
    process.exit(await runWrapper(command, argv.slice(1)))
  }
  process.exit(await runWrapper('npm', argv))
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : String(e))
  process.exit(1)
})
