#!/usr/bin/env node
// spm-attest: spawns the workspace `spm attest` CLI to post a lockfile to
// the SPM attestation server and write the signed envelope. Dependency-free
// itself — it only shells out to a CLI that the action installed first.
// Fails open on every error except an explicit integrity-mismatch failure
// (see run()).

import { spawn } from 'node:child_process'
import { resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const DEFAULT_LOCKFILE = 'package-lock.json'
const DEFAULT_OUTPUT = 'spm-attestation.json'

// cli/ lives three levels above this file: .github/actions/spm-attest/ -> repo root -> cli.
const DEFAULT_CLI_DIR = fileURLToPath(new URL('../../../cli', import.meta.url))

/** Print a GitHub Actions warning annotation. */
export function warn(message) {
  console.log(`::warning::${message}`)
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
 * CAUTION: donorMnemonic is read here but must only ever be forwarded to
 * the spawned CLI's environment, never to its argv, a file, or a log line.
 * There is no --donor-mnemonic flag on purpose — a secret does not belong
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
    donorMnemonic: env.DONOR_MNEMONIC ?? env.INPUT_DONOR_MNEMONIC ?? '',
    cliDir: cli['cli-dir'] ?? env.CLI_DIR ?? DEFAULT_CLI_DIR,
    setupOk: normalizeBool(cli['setup-ok'] ?? env.SETUP_OK ?? 'true'),
    cwd: cli.cwd ?? env.CWD ?? process.cwd(),
  }
}

/** Build the argv for `pnpm -C <cliDir> exec tsx src/index.ts attest ...`. */
export function buildPnpmArgs({ cliDir, lockfile, donate, output, cwd }) {
  const args = ['-C', cliDir, 'exec', 'tsx', 'src/index.ts', 'attest', resolvePath(cwd, lockfile)]
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
 * Run the full attest flow. Returns an exit code — never calls
 * process.exit itself, so callers (including tests) can inspect the result.
 * Fails open: every caught error, non-zero CLI exit, and infra setup
 * failure returns 0. Without donate: true, the CLI still exits 0 with a
 * partial attestation (SPEC.md §11.4); this only warns and reports the
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
    donorMnemonic = '',
    cliDir = DEFAULT_CLI_DIR,
    setupOk = true,
    cwd = process.cwd(),
  } = options

  try {
    if (!endpoint) {
      warn('no endpoint configured; skipping attestation')
      return 0
    }

    if (!setupOk) {
      warn('pnpm/dependency setup for the spm CLI failed; skipping attestation')
      return 0
    }

    if (donate && !donorMnemonic) {
      warn('donate is enabled but donor-mnemonic is not set; skipping attestation')
      return 0
    }

    const args = buildPnpmArgs({ cliDir, lockfile, donate, output, cwd })
    const env = { ...process.env, SPM_PROXY_URL: endpoint }
    delete env.SPM_DONOR_MNEMONIC
    if (donate) env.SPM_DONOR_MNEMONIC = donorMnemonic

    let result
    try {
      result = await runProcess('pnpm', args, { cwd, env }, spawnFn)
    } catch (err) {
      warn(`could not start spm attest: ${err.message}`)
      return 0
    }

    if (result.code !== 0) {
      warn(`spm attest exited with code ${result.code}: ${(result.stderr || result.stdout).trim()}`)
      return 0
    }

    const summary = parseSummaryFromStdout(result.stdout)

    // Without donate: true, the CLI still writes a partial attestation and
    // reports how many reviewed entries it withheld (SPEC.md §11.4) — this
    // is a normal, passing outcome, not an error. Report the count and
    // keep going.
    const withheldCount = summary?.withheld ?? 0
    if (withheldCount > 0) {
      warn(
        `${withheldCount} reviewed package(s) withheld from this attestation. ` +
          "Set donate: 'true' and a donor-mnemonic secret to include them.",
      )
    }

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
