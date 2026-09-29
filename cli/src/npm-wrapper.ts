// cli/src/npm-wrapper.ts
//
// `aupm <npm args>` is a drop-in for `npm <npm args>`: it runs the real npm
// against the AuPM registry, passes every npm argument and npm's own exit
// code through unchanged, and inherits stdio (docs/TASK.md P2). AuPM adds
// only its own flags (`--donate`, `--attest-out <path>`), stripped before
// npm ever sees argv, and — after a successful install-like command — one
// free lockfile summary line, using the same `attest_lockfile` MCP handler
// as `aupm attest`.
import { type ChildProcess, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PRICE_PER_ENTRY_MICRO } from 'aupm-mcp/donor'
import { formatMicroUsd } from 'aupm-mcp/money'
import { proxyUrl } from 'aupm-mcp/proxy-url'
import { type AttestLockfileOutcome, attestLockfileTool } from 'aupm-mcp/tools/attest'

const LOCKFILE_NAME = 'package-lock.json'

// npm subcommands that can add or change a reviewed package in
// package-lock.json, so a post-run donation summary is worth showing.
// pnpm and npx are planned (SPEC.md §11, docs/TASK.md "After the MVP"):
// the attestation server does not parse pnpm-lock.yaml yet.
const INSTALL_LIKE_COMMANDS = new Set(['install', 'i', 'ci', 'add'])

export interface ParsedNpmArgv {
  npmArgs: string[]
  allowDonation: boolean
  attestOutPath?: string
}

/**
 * Splits AuPM's own flags (`--donate`, `--attest-out <path>`) out of an npm
 * argv, wherever they appear. A literal `--` ends AuPM's own parsing: npm
 * treats everything after it as the target script's argv, so AuPM never
 * inspects those tokens either.
 */
export function parseNpmArgv(argv: string[]): ParsedNpmArgv {
  const npmArgs: string[] = []
  let allowDonation = false
  let attestOutPath: string | undefined
  let sawDoubleDash = false
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (sawDoubleDash) {
      npmArgs.push(arg)
      index += 1
      continue
    }
    if (arg === '--') {
      sawDoubleDash = true
      npmArgs.push(arg)
      index += 1
    } else if (arg === '--donate') {
      allowDonation = true
      index += 1
    } else if (arg === '--attest-out') {
      attestOutPath = argv[index + 1]
      index += 2
    } else {
      npmArgs.push(arg)
      index += 1
    }
  }
  return { npmArgs, allowDonation, attestOutPath }
}

export function isInstallLike(npmArgs: string[]): boolean {
  const [subcommand] = npmArgs
  return subcommand !== undefined && INSTALL_LIKE_COMMANDS.has(subcommand)
}

function exitCodeForSignal(signal: NodeJS.Signals): number {
  const signalNumber = os.constants.signals[signal]
  return 128 + (signalNumber ?? 0)
}

/**
 * Runs real npm with the user's argv passed through exactly as given —
 * never with an appended `--registry`, which would land after a literal
 * `--` and reach the target script instead of npm. The AuPM registry goes
 * through `npm_config_registry` in the child's env instead; npm's own
 * `--registry` flag, if the user passes one, wins over the env var.
 */
export function runNpmProcess(npmArgs: string[]): Promise<number> {
  return new Promise((resolve, reject) => {
    const child: ChildProcess = spawn('npm', npmArgs, {
      stdio: 'inherit',
      env: { ...process.env, npm_config_registry: proxyUrl() },
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      resolve(signal ? exitCodeForSignal(signal) : (code ?? 1))
    })
  })
}

/** Reads `predicate`-shaped `summary.reviewed` back out of an attest_lockfile outcome. */
function reviewedCount(outcome: AttestLockfileOutcome): number {
  const summary = 'summary' in outcome ? outcome.summary : undefined
  const value = (summary as { reviewed?: unknown } | undefined)?.reviewed
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return value
  if (outcome.status === 'donation_required' && typeof outcome.withheld === 'number') {
    return outcome.withheld
  }
  return 0
}

/**
 * Requests a lockfile attestation after a successful install-like npm
 * command and prints one summary line: how many entries are
 * COMMUNITY_REVIEWED and the donation amount in dollars. Without
 * `allowDonation`, adds one hint line on how to donate; with zero reviewed
 * entries, no hint line (docs/TASK.md P2). Never throws: a failed donation
 * or a failed summary request logs one line here and lets the caller keep
 * npm's own exit code.
 */
export async function printPostInstallSummary(
  allowDonation: boolean,
  attestOutPath?: string,
): Promise<void> {
  const lockfilePath = path.resolve(LOCKFILE_NAME)
  if (!fs.existsSync(lockfilePath)) {
    console.log('aupm: no package-lock.json found; skipping the donation summary.')
    return
  }

  let outcome: AttestLockfileOutcome
  try {
    outcome = await attestLockfileTool.handler({ lockfilePath, allowDonation })
  } catch (error) {
    console.log(
      `aupm: donation summary failed: ${error instanceof Error ? error.message : String(error)}`,
    )
    return
  }

  const reviewed = reviewedCount(outcome)

  if (reviewed === 0) {
    console.log('aupm: 0 packages in package-lock.json are audited (COMMUNITY_REVIEWED).')
    return
  }

  const amount = formatMicroUsd(reviewed * PRICE_PER_ENTRY_MICRO)
  const plural = reviewed === 1 ? 'package is' : 'packages are'
  const settlement = outcome.status === 'attested' ? outcome.settlement : null
  if (allowDonation && settlement) {
    console.log(
      `aupm: ${reviewed} ${plural} audited (COMMUNITY_REVIEWED). ` +
        `Donated ${formatMicroUsd(settlement.amountMicro)} ` +
        `(${settlement.amountMicro} microUSDC), settlement txid ${settlement.txid}.`,
    )
  } else if (allowDonation) {
    console.log(`aupm: ${reviewed} ${plural} audited (COMMUNITY_REVIEWED). No donation settled.`)
  } else {
    console.log(
      `aupm: ${reviewed} ${plural} audited (COMMUNITY_REVIEWED). ${amount} available to donate.`,
    )
    console.log('aupm: run the install again with --donate to send this to the auditors.')
  }

  if (attestOutPath && 'attestation' in outcome && outcome.attestation !== undefined) {
    fs.writeFileSync(attestOutPath, JSON.stringify(outcome.attestation, null, 2))
    console.log(`aupm: attestation written to ${attestOutPath}`)
  }
}

/**
 * Runs `aupm <npm args>` end to end: strips AuPM's own flags, runs npm
 * against the AuPM registry with npm's argv and exit code passed through
 * unchanged, and — only after a successful install-like command — prints
 * the donation summary.
 */
export async function runNpmWrapper(argv: string[]): Promise<number> {
  const { npmArgs, allowDonation, attestOutPath } = parseNpmArgv(argv)
  const exitCode = await runNpmProcess(npmArgs)
  if (exitCode === 0 && isInstallLike(npmArgs)) {
    await printPostInstallSummary(allowDonation, attestOutPath)
  }
  return exitCode
}
