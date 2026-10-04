import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { test } from 'node:test'

import { install, registryUrl, resolveOptions } from './install.mjs'

/**
 * Write a fake `npm` to a temp bin directory. Each call appends one JSON line
 * (args and cwd) to a record file. The nth call exits with the nth code in
 * `codes`.
 */
function makeFakeNpm(dir, codes) {
  const binDir = join(dir, 'bin')
  mkdirSync(binDir, { recursive: true })
  const recordPath = join(dir, 'npm-record.jsonl')
  const script = `#!/usr/bin/env node
import fs from 'node:fs'
const codes = ${JSON.stringify(codes)}
const record = ${JSON.stringify(recordPath)}
fs.appendFileSync(record, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + '\\n')
const calls = fs.readFileSync(record, 'utf8').trim().split('\\n').length
process.exit(codes[calls - 1] ?? 0)
`
  const npmPath = join(binDir, 'npm')
  writeFileSync(npmPath, script)
  chmodSync(npmPath, 0o755)
  return { binDir, recordPath }
}

function readCalls(recordPath) {
  try {
    return readFileSync(recordPath, 'utf8').trim().split('\n').map(JSON.parse)
  } catch {
    return []
  }
}

/** Run fn with the fake `npm` first on PATH and capture console output. */
async function withFakeNpm(codes, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-install-test-'))
  const { binDir, recordPath } = makeFakeNpm(dir, codes)
  const originalPath = process.env.PATH
  const originalLog = console.log
  const lines = []
  process.env.PATH = `${binDir}${delimiter}${originalPath}`
  console.log = (...parts) => lines.push(parts.join(' '))
  try {
    const code = await fn(dir)
    return { code, calls: readCalls(recordPath), lines }
  } finally {
    console.log = originalLog
    process.env.PATH = originalPath
    rmSync(dir, { recursive: true, force: true })
  }
}

const OPTIONS = {
  install: 'npm',
  endpoint: 'https://aupm.example.com',
  lockfile: 'package-lock.json',
}

test('AuPM install passes: one npm ci with the registry, no fallback', async () => {
  const { code, calls, lines } = await withFakeNpm([0], (dir) => install({ ...OPTIONS, cwd: dir }))
  assert.equal(code, 0)
  assert.deepEqual(
    calls.map((c) => c.args),
    [['ci', '--registry', 'https://aupm.example.com/']],
  )
  assert.equal(lines.filter((l) => l.startsWith('::warning::')).length, 0)
})

test('AuPM install fails then npm passes: warning, plain npm ci, exit 0', async () => {
  const { code, calls, lines } = await withFakeNpm([1, 0], (dir) =>
    install({ ...OPTIONS, cwd: dir }),
  )
  assert.equal(code, 0)
  assert.deepEqual(
    calls.map((c) => c.args),
    [['ci', '--registry', 'https://aupm.example.com/'], ['ci']],
  )
  assert.ok(
    lines.includes(
      '::warning::AuPM registry install failed; installing from the npm registry instead.',
    ),
  )
})

test('both installs fail: the step fails with the plain npm failure', async () => {
  const { code, calls } = await withFakeNpm([1, 3], (dir) => install({ ...OPTIONS, cwd: dir }))
  assert.equal(code, 3)
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[1].args, ['ci'])
})

test('install none skips npm and exits 0', async () => {
  const { code, calls } = await withFakeNpm([1], (dir) =>
    install({ ...OPTIONS, install: 'none', cwd: dir }),
  )
  assert.equal(code, 0)
  assert.equal(calls.length, 0)
})

test('an unknown install value fails with an error and never runs npm', async () => {
  const { code, calls, lines } = await withFakeNpm([0], (dir) =>
    install({ ...OPTIONS, install: 'yarn', cwd: dir }),
  )
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  assert.ok(lines.some((l) => l.startsWith('::error::') && l.includes("'yarn'")))
})

test('npm runs in the directory of the lockfile', async () => {
  const { code, calls } = await withFakeNpm([0], (dir) => {
    mkdirSync(join(dir, 'app'), { recursive: true })
    return install({ ...OPTIONS, lockfile: 'app/package-lock.json', cwd: dir })
  })
  assert.equal(code, 0)
  assert.ok(calls[0].cwd.endsWith('/app'))
})

test('a missing endpoint warns and installs from npm', async () => {
  const { code, calls, lines } = await withFakeNpm([0], (dir) =>
    install({ ...OPTIONS, endpoint: '', cwd: dir }),
  )
  assert.equal(code, 0)
  assert.deepEqual(
    calls.map((c) => c.args),
    [['ci']],
  )
  assert.ok(lines.some((l) => l.startsWith('::warning::')))
})

test('registryUrl keeps exactly one trailing slash', () => {
  assert.equal(registryUrl('https://aupm.fyi'), 'https://aupm.fyi/')
  assert.equal(registryUrl('https://aupm.fyi//'), 'https://aupm.fyi/')
})

test('resolveOptions defaults install to npm and lockfile to package-lock.json', () => {
  const options = resolveOptions({ ENDPOINT: 'https://aupm.fyi' })
  assert.equal(options.install, 'npm')
  assert.equal(options.lockfile, 'package-lock.json')
})
