#!/usr/bin/env node
// aupm check step: spawns the published `aupm-cli` package (pinned below) with
// `npm exec` to post a lockfile to the AuPM server and write the signed
// receipt. Dependency-free itself.
// Fails open on every error except an explicit integrity-mismatch failure
// (see run()).

import { spawn } from 'node:child_process'
import { appendFileSync } from 'node:fs'
import { resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

const DEFAULT_LOCKFILE = 'package-lock.json'
const DEFAULT_OUTPUT = 'aupm-receipt.json'

export const CLI_PACKAGE = 'aupm-cli@0.3.1'

/** Print a GitHub Actions warning annotation. */
export function warn(message) {
  console.log(`::warning::${message}`)
}

const ALGORAND_TXID = /^[A-Z2-7]{52}$/

/** Format integer microUSDC as a USDC decimal string, without floats. */
export function formatUsdc(micro) {
  return `${Math.trunc(micro / 1_000_000)}.${String(micro % 1_000_000).padStart(6, '0')}`
}

/** Lora explorer link for a transaction on the network that NETWORK selects. */
export function explorerUrl(txid, env = process.env) {
  const network = (env.NETWORK ?? '').toLowerCase() === 'testnet' ? 'testnet' : 'mainnet'
  return `https://lora.algokit.io/${network}/transaction/${txid}`
}

/**
 * Report a donation. Reads `donatedMicro` and `settlementTxid` from the CLI's
 * summary; prints nothing for a free check. On a runner, it also writes:
 * - a `::notice::` annotation with the amount, the txid and the explorer link,
 * - a table in the job summary,
 * - the step outputs `settlement-txid` and `donated-micro-usdc`.
 */
export function reportDonation(summary, env = process.env) {
  const micro = summary?.donatedMicro
  const txid = summary?.settlementTxid
  if (!Number.isInteger(micro) || typeof txid !== 'string') return
  // An Algorand txid is 52 base32 characters. Anything else could inject
  // lines into GITHUB_OUTPUT or the job summary.
  if (!ALGORAND_TXID.test(txid)) {
    warn(`the donation summary has a malformed settlement txid; ${micro} microUSDC reported`)
    return
  }
  const url = explorerUrl(txid, env)
  console.log(`::notice::AuPM donation: ${micro} microUSDC, settlement txid ${txid} ${url}`)
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(
      env.GITHUB_STEP_SUMMARY,
      [
        '### AuPM donation',
        '',
        '| Amount | Settlement txid |',
        '| --- | --- |',
        `| ${formatUsdc(micro)} USDC (${micro} microUSDC) | [${txid}](${url}) |`,
        '',
      ].join('\n'),
    )
  }
  if (env.GITHUB_OUTPUT) {
    appendFileSync(env.GITHUB_OUTPUT, `settlement-txid=${txid}\ndonated-micro-usdc=${micro}\n`)
  }
}

/** Convert an input value (string or boolean) to a strict boolean. */
export function normalizeBool(value) {
  if (typeof value === 'boolean') return value
  return (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

/** Parse `--flag value` pairs from an argv slice. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    out[key] = argv[i + 1]
    i += 1
  }
  return out
}

/**
 * Merge CLI args and environment variables into a single options object.
 *
 * CAUTION: donorSecret is read here but must only ever be forwarded to
 * the spawned CLI's environment, never to its argv, a file, or a log line.
 * There is no --donor-secret flag on purpose — a secret does not belong
 * in argv even for local development.
 */
export function resolveOptions(argv, env) {
  const cli = parseArgs(argv)
  return {
    endpoint: cli.endpoint ?? env.ENDPOINT ?? env.INPUT_ENDPOINT ?? '',
    lockfile: cli.lockfile ?? env.LOCKFILE ?? env.INPUT_LOCKFILE ?? DEFAULT_LOCKFILE,
    failOnMismatch:
      cli['fail-on-mismatch'] ?? env.FAIL_ON_MISMATCH ?? env.INPUT_FAIL_ON_MISMATCH ?? 'false',
    output: cli.output ?? env.OUTPUT ?? env.INPUT_OUTPUT ?? DEFAULT_OUTPUT,
    donate: normalizeBool(cli.donate ?? env.DONATE ?? env.INPUT_DONATE ?? 'false'),
    donorSecret: env.DONOR_SECRET ?? env.INPUT_DONOR_SECRET ?? '',
    cwd: cli.cwd ?? env.CWD ?? process.cwd(),
  }
}

/**
 * Build the argv for `npm exec --yes --package=aupm-cli@<pin> -- aupm attest ...`.
 * The Action needs no install step and changes no PATH.
 */
export function buildCliArgs({ lockfile, donate, output, cwd }) {
  const args = [
    'exec',
    '--yes',
    `--package=${CLI_PACKAGE}`,
    '--',
    'aupm',
    'attest',
    resolvePath(cwd, lockfile),
  ]
  if (donate) args.push('--donate')
  args.push('--out', resolvePath(cwd, output))
  return args
}

/** Extract the trailing JSON summary object the CLI prints to stdout. */
export function parseSummaryFromStdout(stdout) {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start === -1 || end === -1 || end < start) return null
  try {
    return JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
}

/**
 * Spawn one command and collect its stdout/stderr/exit code. Never rejects
 * on a non-zero exit code — that is a normal outcome the caller inspects.
 */
function runProcess(command, args, options, spawnFn) {
  return new Promise((resolveRun, reject) => {
    let child
    try {
      child = spawnFn(command, args, options)
    } catch (err) {
      reject(err)
      return
    }
    let stdout = ''
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.stderr?.on('data', (chunk) => {
      stderr += chunk
    })
    child.on('error', reject)
    child.on('close', (code) => resolveRun({ code: code ?? 1, stdout, stderr }))
  })
}

/**
 * Run the check and donate flow. Returns an exit code — never calls
 * process.exit itself, so callers (including tests) can inspect the result.
 * Fails open: every caught error, non-zero CLI exit, and spawn
 * failure returns 0. Without donate: true, the CLI still exits 0 with a
 * partial result (SPEC.md §11.4); this only warns and reports the
 * withheld count. The single exception is a reported integrityMismatch
 * above zero when failOnMismatch is true.
 */
export async function run(options, { spawnFn = spawn } = {}) {
  const {
    endpoint,
    lockfile = DEFAULT_LOCKFILE,
    failOnMismatch = false,
    output = DEFAULT_OUTPUT,
    donate = false,
    donorSecret = '',
    cwd = process.cwd(),
  } = options

  try {
    if (!endpoint) {
      warn('no endpoint configured; skipping the check')
      return 0
    }

    if (donate && !donorSecret) {
      warn('donate is enabled but donor-secret is not set; skipping the check')
      return 0
    }

    const args = buildCliArgs({ lockfile, donate, output, cwd })
    const env = { ...process.env, AUPM_PROXY_URL: endpoint }
    delete env.AUPM_DONOR_MNEMONIC
    if (donate) env.AUPM_DONOR_MNEMONIC = donorSecret

    let result
    try {
      result = await runProcess('npm', args, { cwd, env }, spawnFn)
    } catch (err) {
      warn(`could not start the aupm CLI: ${err.message}`)
      return 0
    }

    if (result.code !== 0) {
      warn(
        `the aupm CLI exited with code ${result.code}: ${(result.stderr || result.stdout).trim()}`,
      )
      return 0
    }

    const summary = parseSummaryFromStdout(result.stdout)

    // Without donate: true, the CLI still writes a partial signed receipt and
    // reports how many reviewed entries it withheld (SPEC.md §11.4) — this
    // is a normal, passing outcome, not an error. Report the count and
    // keep going.
    const withheldCount = summary?.withheld ?? 0
    if (withheldCount > 0) {
      warn(
        `${withheldCount} reviewed package(s) withheld from the signed receipt. ` +
          "Set donate: 'true' and a donor-secret to include them.",
      )
    }

    reportDonation(summary)

    const mismatchCount = summary?.integrityMismatch ?? 0
    if (normalizeBool(failOnMismatch) && mismatchCount > 0) {
      warn(`integrityMismatch is ${mismatchCount}; failing per fail-on-mismatch`)
      return 1
    }

    return 0
  } catch (err) {
    warn(`unexpected error: ${err?.message ?? err}`)
    return 0
  }
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  const options = resolveOptions(process.argv.slice(2), process.env)
  const code = await run(options)
  process.exitCode = code
}
