import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import { buildPnpmArgs, parseSummaryFromStdout, resolveOptions, run } from './attest.mjs'

const CANARY_MNEMONIC = 'canary abandon abandon abandon abandon abandon abandon do-not-leak-4f9c'

/**
 * Writes a fake `pnpm` executable to a temp bin directory and returns its
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
  hasMnemonicEnv: 'SPM_DONOR_MNEMONIC' in process.env,
  mnemonicValue: process.env.SPM_DONOR_MNEMONIC ?? null,
  proxyUrl: process.env.SPM_PROXY_URL ?? null,
}))
const mode = ${JSON.stringify(mode)}
if (mode === 'donation-required') {
  process.exit(2)
} else if (mode === 'error') {
  process.stderr.write('boom: cli error\\n')
  process.exit(1)
} else if (mode === 'mismatch') {
  process.stdout.write('attestation written to out.json\\n')
  process.stdout.write(JSON.stringify({ total: 3, reviewed: 2, unreviewed: 1, integrityMismatch: 1 }) + '\\n')
  process.exit(0)
} else {
  process.stdout.write('attestation written to out.json\\n')
  process.stdout.write(JSON.stringify({ total: 0, reviewed: 0, unreviewed: 0, integrityMismatch: 0 }) + '\\n')
  process.exit(0)
}
`
  const pnpmPath = join(binDir, 'pnpm')
  writeFileSync(pnpmPath, script)
  chmodSync(pnpmPath, 0o755)
  return { binDir, recordPath }
}

/** Runs fn with a fake `pnpm` prepended to PATH, then restores PATH. */
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
    endpoint: 'https://spm.example.com',
    lockfile: 'package-lock.json',
    failOnMismatch: false,
    output: 'spm-attestation.json',
    donate: false,
    donorMnemonic: '',
    cliDir: '/nonexistent/cli',
    setupOk: true,
    cwd: process.cwd(),
    ...overrides,
  }
}

test('no endpoint configured warns and exits 0 without spawning', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir, recordPath } = makeFakeCli(dir, 'ok')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions({ endpoint: '' })))

  assert.equal(code, 0)
  assert.throws(() => readFileSync(recordPath))
})

test('CLI exit 2 (donation required) warns and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'donation-required')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions()))

  assert.equal(code, 0)
})

test('donate set without a donor-mnemonic warns, exits 0, and never starts the CLI', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir, recordPath } = makeFakeCli(dir, 'ok')

  const code = await withFakeCliOnPath(binDir, () =>
    run(baseOptions({ donate: true, donorMnemonic: '' })),
  )

  assert.equal(code, 0)
  assert.throws(() => readFileSync(recordPath), 'the CLI must never be invoked in this case')
})

test('a CLI error (non-zero, non-2 exit) warns and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'error')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions()))

  assert.equal(code, 0)
})

test('fail-on-mismatch true with integrityMismatch above zero exits 1', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'mismatch')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions({ failOnMismatch: true })))

  assert.equal(code, 1)
})

test('fail-on-mismatch false with integrityMismatch above zero exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir } = makeFakeCli(dir, 'mismatch')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions({ failOnMismatch: false })))

  assert.equal(code, 0)
})

test('donate true passes --donate, and the mnemonic reaches the CLI only via env', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir, recordPath } = makeFakeCli(dir, 'ok')

  const code = await withFakeCliOnPath(binDir, () =>
    run(baseOptions({ donate: true, donorMnemonic: CANARY_MNEMONIC })),
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

test('setupOk false warns and exits 0 without spawning', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  const { binDir, recordPath } = makeFakeCli(dir, 'ok')

  const code = await withFakeCliOnPath(binDir, () => run(baseOptions({ setupOk: false })))

  assert.equal(code, 0)
  assert.throws(() => readFileSync(recordPath))
})

test('lockfile and output are resolved to absolute paths against cwd', () => {
  const args = buildPnpmArgs({
    cliDir: '/repo/cli',
    lockfile: 'package-lock.json',
    donate: false,
    output: 'out.json',
    cwd: '/workspace',
  })

  assert.deepEqual(args, [
    '-C',
    '/repo/cli',
    'exec',
    'tsx',
    'src/index.ts',
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

test('resolveOptions reads the donor mnemonic only from DONOR_MNEMONIC / INPUT_DONOR_MNEMONIC', () => {
  const options = resolveOptions([], { DONOR_MNEMONIC: CANARY_MNEMONIC })
  assert.equal(options.donorMnemonic, CANARY_MNEMONIC)
  assert.ok(
    !Object.entries(options).some(
      ([key, value]) =>
        key !== 'donorMnemonic' && typeof value === 'string' && value.includes(CANARY_MNEMONIC),
    ),
    'no other resolved option should ever contain the mnemonic value',
  )
})

test('resolveOptions has no --donor-mnemonic argv flag', () => {
  const options = resolveOptions(['--donor-mnemonic', CANARY_MNEMONIC], {})
  assert.equal(options.donorMnemonic, '')
})
