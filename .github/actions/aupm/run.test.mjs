import assert from 'node:assert/strict'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import {
  buildCliArgs,
  formatUsdc,
  parseSummaryFromStdout,
  reportCounts,
  reportDonation,
  resolveOptions,
  run,
} from './run.mjs'

const CANARY_MNEMONIC = 'canary abandon abandon abandon abandon abandon abandon do-not-leak-4f9c'
// A well-formed Algorand txid: 52 base32 characters.
const DONATED_TXID = 'TXIDDONATEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'

/**
 * Writes a fake `npm` executable to a temp bin directory and returns its
 * path plus the path of the JSON file it records each invocation to.
 * `mode` selects the fake CLI's exit behaviour — see the switch below.
 */
function makeFakeCli(dir, mode) {
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const recordPath = join(dir, 'record.json')
  const script = `#!/usr/bin/env node
import fs from 'node:fs'
const args = process.argv.slice(2)
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({
  args,
  hasMnemonicEnv: 'AUPM_DONOR_MNEMONIC' in process.env,
  mnemonicValue: process.env.AUPM_DONOR_MNEMONIC ?? null,
  proxyUrl: process.env.AUPM_PROXY_URL ?? null,
}))
const mode = ${JSON.stringify(mode)}
if (mode === 'error') {
  process.stderr.write('boom: cli error\\n')
  process.exit(1)
} else if (mode === 'mismatch') {
  process.stdout.write('attestation written to out.json\\n')
  process.stdout.write(JSON.stringify({ total: 3, reviewed: 2, unreviewed: 1, integrityMismatch: 1 }) + '\\n')
  process.exit(0)
} else if (mode === 'donated') {
  process.stdout.write('attestation written to out.json\\n')
  process.stdout.write('donated $0.03 (30000 microUSDC), settlement txid TXIDDONATEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA\\n')
  process.stdout.write(JSON.stringify({ total: 30, reviewed: 30, unreviewed: 0, integrityMismatch: 0, donatedMicro: 30000, settlementTxid: 'TXIDDONATEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }) + '\\n')
  process.exit(0)
} else if (mode === 'withheld') {
  process.stdout.write('attestation written to out.json\\n')
  process.stdout.write('withheld 3 reviewed entries (3000 microUSDC) — retry with --donate to include them\\n')
  process.stdout.write(JSON.stringify({ total: 3, reviewed: 3, unreviewed: 0, integrityMismatch: 0, withheld: 3 }) + '\\n')
  process.exit(0)
} else {
  process.stdout.write('attestation written to out.json\\n')
  process.stdout.write(JSON.stringify({ total: 0, reviewed: 0, unreviewed: 0, integrityMismatch: 0 }) + '\\n')
  process.exit(0)
}
`
  const npmPath = join(binDir, 'npm')
  writeFileSync(npmPath, script)
  chmodSync(npmPath, 0o755)
  return { binDir, recordPath }
}

/** Runs fn with a fake `npm` prepended to PATH, then restores PATH. */
function withFakeCliOnPath(binDir, fn) {
  const originalPath = process.env.PATH
  process.env.PATH = `${binDir}${delimiter}${originalPath}`
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      process.env.PATH = originalPath
    })
}

function baseOptions(overrides) {
  return {
    endpoint: 'https://aupm.example.com',
    lockfile: 'package-lock.json',
    failOnMismatch: false,
    output: 'aupm-receipt.json',
    donate: false,
    donorSecret: '',
    cwd: process.cwd(),
    ...overrides,
  }
}

test('no endpoint configured warns and exits 0 without spawning', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir, recordPath } = makeFakeCli(dir, 'ok')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions({ endpoint: '' })))

  assert.equal(code, 0)
  assert.throws(() => readFileSync(recordPath))
})

test('a withheld count (no donate opt-in) warns with the count and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'withheld')

  const logCalls = t.mock.method(console, 'log')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions()))

  assert.equal(code, 0)
  const logged = logCalls.mock.calls.map((call) => String(call.arguments[0])).join('\n')
  assert.match(logged, /::warning::/)
  assert.match(logged, /3 reviewed package\(s\) withheld/)
})

test('a donation reports the amount and txid as a notice and in the job summary', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'donated')
  const summaryPath = join(dir, 'step-summary.md')
  const outputPath = join(dir, 'output.txt')
  const saved = {
    GITHUB_STEP_SUMMARY: process.env.GITHUB_STEP_SUMMARY,
    GITHUB_OUTPUT: process.env.GITHUB_OUTPUT,
    NETWORK: process.env.NETWORK,
  }
  process.env.GITHUB_STEP_SUMMARY = summaryPath
  process.env.GITHUB_OUTPUT = outputPath
  delete process.env.NETWORK
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })
  const logCalls = t.mock.method(console, 'log')

  const code = await withFakeCliOnPath(binDir, () =>
    run(baseOptions({ donate: true, donorSecret: CANARY_MNEMONIC })),
  )

  assert.equal(code, 0)
  const logged = logCalls.mock.calls.map((call) => String(call.arguments[0])).join('\n')
  assert.match(
    logged,
    new RegExp(
      `::notice::AuPM donation: 30000 microUSDC, settlement txid ${DONATED_TXID} ` +
        `https://lora\\.algokit\\.io/mainnet/transaction/${DONATED_TXID}`,
    ),
  )
  assert.doesNotMatch(logged, /::warning::/)
  const jobSummary = readFileSync(summaryPath, 'utf8')
  assert.match(jobSummary, /### AuPM donation/)
  assert.match(jobSummary, /\| 0\.030000 USDC \(30000 microUSDC\) \|/)
  assert.match(
    jobSummary,
    new RegExp(
      `\\[${DONATED_TXID}\\]\\(https://lora\\.algokit\\.io/mainnet/transaction/${DONATED_TXID}\\)`,
    ),
  )
  assert.equal(
    readFileSync(outputPath, 'utf8'),
    `settlement-txid=${DONATED_TXID}\ndonated-micro-usdc=30000\n`,
  )
})

test('reportDonation prints nothing for a free check', (t) => {
  const logCalls = t.mock.method(console, 'log')
  reportDonation({ total: 2, reviewed: 0 }, {})
  reportDonation({ donatedMicro: 1.5, settlementTxid: DONATED_TXID }, {})
  reportDonation(null, {})
  assert.equal(logCalls.mock.callCount(), 0)
})

test('reportDonation links the TestNet explorer when NETWORK is testnet', (t) => {
  const logCalls = t.mock.method(console, 'log')
  reportDonation({ donatedMicro: 1000, settlementTxid: DONATED_TXID }, { NETWORK: 'testnet' })
  const logged = String(logCalls.mock.calls[0].arguments[0])
  assert.match(logged, /https:\/\/lora\.algokit\.io\/testnet\/transaction\//)
})

test('reportDonation rejects a malformed txid and writes no output', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const outputPath = join(dir, 'output.txt')
  const logCalls = t.mock.method(console, 'log')
  reportDonation(
    { donatedMicro: 1000, settlementTxid: `${DONATED_TXID}\nother-output=injected` },
    { GITHUB_OUTPUT: outputPath },
  )
  const logged = logCalls.mock.calls.map((call) => String(call.arguments[0])).join('\n')
  assert.match(logged, /::warning::.*malformed settlement txid/)
  assert.doesNotMatch(logged, /::notice::/)
  assert.equal(existsSync(outputPath), false)
})

test('formatUsdc formats integer microUSDC without floats', () => {
  assert.equal(formatUsdc(0), '0.000000')
  assert.equal(formatUsdc(1000), '0.001000')
  assert.equal(formatUsdc(30000), '0.030000')
  assert.equal(formatUsdc(1_234_567), '1.234567')
})

test('donate set without a donor-secret warns, exits 0, and never starts the CLI', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir, recordPath } = makeFakeCli(dir, 'ok')

  const code = await withFakeCliOnPath(binDir, () =>
    run(baseOptions({ donate: true, donorSecret: '' })),
  )

  assert.equal(code, 0)
  assert.throws(() => readFileSync(recordPath), 'the CLI must never be invoked in this case')
})

test('a CLI error (non-zero, non-2 exit) warns and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'error')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions()))

  assert.equal(code, 0)
})

test('fail-on-mismatch true with integrityMismatch above zero exits 1', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'mismatch')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions({ failOnMismatch: true })))

  assert.equal(code, 1)
})

test('fail-on-mismatch false with integrityMismatch above zero exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'mismatch')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions({ failOnMismatch: false })))

  assert.equal(code, 0)
})

test('donate true passes --donate, and the mnemonic reaches the CLI only via env', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir, recordPath } = makeFakeCli(dir, 'ok')

  const code = await withFakeCliOnPath(binDir, () =>
    run(baseOptions({ donate: true, donorSecret: CANARY_MNEMONIC })),
  )

  assert.equal(code, 0)
  const record = JSON.parse(readFileSync(recordPath, 'utf8'))
  assert.ok(record.args.includes('--donate'), 'CLI must be started with --donate')
  assert.equal(record.hasMnemonicEnv, true)
  assert.equal(record.mnemonicValue, CANARY_MNEMONIC)
  assert.ok(
    !record.args.some((arg) => arg.includes(CANARY_MNEMONIC)),
    'the mnemonic must never appear in argv',
  )
})

test('lockfile and output are resolved to absolute paths against cwd', () => {
  const args = buildCliArgs({
    lockfile: 'package-lock.json',
    donate: false,
    output: 'out.json',
    cwd: '/workspace',
  })

  assert.deepEqual(args, [
    'exec',
    '--yes',
    '--package=aupm-cli@0.3.1',
    '--',
    'aupm',
    'attest',
    '/workspace/package-lock.json',
    '--out',
    '/workspace/out.json',
  ])
})

test('parseSummaryFromStdout extracts the trailing JSON object', () => {
  const stdout = 'attestation written to out.json\n{\n  "integrityMismatch": 2\n}\n'
  assert.deepEqual(parseSummaryFromStdout(stdout), { integrityMismatch: 2 })
  assert.equal(parseSummaryFromStdout('no json here'), null)
})

test('resolveOptions reads the donor mnemonic only from DONOR_SECRET / INPUT_DONOR_SECRET', () => {
  const options = resolveOptions([], { DONOR_SECRET: CANARY_MNEMONIC })
  assert.equal(options.donorSecret, CANARY_MNEMONIC)
  assert.ok(
    !Object.entries(options).some(
      ([key, value]) =>
        key !== 'donorSecret' && typeof value === 'string' && value.includes(CANARY_MNEMONIC),
    ),
    'no other resolved option should ever contain the mnemonic value',
  )
})

test('resolveOptions has no --donor-secret argv flag', () => {
  const options = resolveOptions(['--donor-secret', CANARY_MNEMONIC], {})
  assert.equal(options.donorSecret, '')
})

test('reportCounts writes the four counts and the offer without donate', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const summaryPath = join(dir, 'summary.md')
  reportCounts({ reviewed: 2, unreviewed: 3, integrityMismatch: 1, unresolvable: 4 }, false, {
    GITHUB_STEP_SUMMARY: summaryPath,
  })
  const text = readFileSync(summaryPath, 'utf8')
  assert.match(text, /\| 2 \| 3 \| 1 \| 4 \|/)
  assert.match(text, /A donation would be 0\.002000 USDC for 2 audited packages/)
  assert.match(text, /whole lockfile/)
})

test('reportCounts writes the same counts with donate and no offer', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-run-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const summaryPath = join(dir, 'summary.md')
  reportCounts({ reviewed: 2, unreviewed: 3, integrityMismatch: 1, unresolvable: 4 }, true, {
    GITHUB_STEP_SUMMARY: summaryPath,
  })
  const text = readFileSync(summaryPath, 'utf8')
  assert.match(text, /\| 2 \| 3 \| 1 \| 4 \|/)
  assert.doesNotMatch(text, /A donation would be/)
})

test('reportCounts writes nothing without a step summary file or a summary', () => {
  reportCounts({ reviewed: 1 }, false, {})
  reportCounts(null, false, { GITHUB_STEP_SUMMARY: '/nonexistent/never-written' })
})
