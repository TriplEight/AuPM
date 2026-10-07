import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join, resolve } from 'node:path'
import { test } from 'node:test'

import { install, registryUrl, resolveOptions } from './install.mjs'
import { buildCliArgs, CLI_PACKAGE, resolveOptions as resolveRunOptions } from './run.mjs'

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
    install({ ...OPTIONS, install: 'bun', cwd: dir }),
  )
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  assert.ok(lines.some((l) => l.startsWith('::error::') && l.includes("'bun'")))
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

test('resolveOptions defaults install to auto and lockfile to empty', () => {
  const options = resolveOptions({ ENDPOINT: 'https://aupm.fyi' })
  assert.equal(options.install, 'auto')
  assert.equal(options.lockfile, '')
})

// Tests below inject a fake spawn. It records each call and answers from a script.

const ENDPOINT = 'https://aupm.example.com'
const REGISTRY = 'https://aupm.example.com/'

/** Build a fake spawn. `script(command, args)` returns { code, stdout } or { error }. */
function fakeSpawn(script) {
  const calls = []
  const spawnFn = (command, args, options) => {
    calls.push({ command, args, options })
    const child = new EventEmitter()
    child.stdout = new EventEmitter()
    const reply = script(command, args) ?? { code: 0 }
    setImmediate(() => {
      if (reply.error) {
        child.emit('error', new Error(reply.error))
        return
      }
      if (reply.stdout !== undefined) child.stdout.emit('data', reply.stdout)
      child.emit('close', reply.code ?? 0)
    })
    return child
  }
  return { spawnFn, calls }
}

/** Run install in a temp dir holding the named files. Capture console and outputs. */
async function runInstall(files, overrides, script = () => ({ code: 0 })) {
  const dir = mkdtempSync(join(tmpdir(), 'aupm-install-plan-'))
  for (const file of files) {
    mkdirSync(join(dir, file, '..'), { recursive: true })
    writeFileSync(join(dir, file), '')
  }
  const outputFile = join(dir, 'github-output')
  writeFileSync(outputFile, '')
  const { spawnFn, calls } = fakeSpawn(script)
  const originalLog = console.log
  const lines = []
  console.log = (...parts) => lines.push(parts.join(' '))
  try {
    const options = { install: 'auto', endpoint: ENDPOINT, lockfile: '', cwd: dir, ...overrides }
    const code = await install(options, { spawnFn, outputFile })
    const outputs = Object.fromEntries(
      readFileSync(outputFile, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split('=')),
    )
    return { code, calls, lines, outputs, dir }
  } finally {
    console.log = originalLog
    rmSync(dir, { recursive: true, force: true })
  }
}

const errors = (lines) => lines.filter((l) => l.startsWith('::error::'))

for (const [file, command, args] of [
  ['package-lock.json', 'npm', ['ci', '--registry', REGISTRY]],
  ['pnpm-lock.yaml', 'pnpm', ['install', '--frozen-lockfile']],
]) {
  test(`auto with only ${file} installs with ${command} through AuPM`, async () => {
    const { code, calls, outputs } = await runInstall([file], {})
    assert.equal(code, 0)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].command, command)
    assert.deepEqual(calls[0].args, args)
    assert.equal(outputs.lockfile, file)
  })
}

test('auto with only yarn.lock runs yarn --version, then the classic install', async () => {
  const { code, calls, outputs } = await runInstall(['yarn.lock'], {}, (_c, args) =>
    args[0] === '--version' ? { stdout: '1.22.22\n' } : { code: 0 },
  )
  assert.equal(code, 0)
  assert.deepEqual(
    calls.map((c) => [c.command, c.args]),
    [
      ['yarn', ['--version']],
      ['yarn', ['install', '--frozen-lockfile']],
    ],
  )
  assert.equal(outputs.lockfile, 'yarn.lock')
  assert.equal(outputs['skip-check'], undefined)
})

test('pnpm and yarn classic set npm_config_registry for the AuPM attempt only', async () => {
  for (const [file, failCommand] of [
    ['pnpm-lock.yaml', 'pnpm'],
    ['yarn.lock', 'yarn'],
  ]) {
    let installs = 0
    const { code, calls, lines } = await runInstall([file], {}, (command, args) => {
      if (args[0] === '--version') return { stdout: '1.22.22' }
      installs += 1
      return command === failCommand && installs === 1 ? { code: 1 } : { code: 0 }
    })
    assert.equal(code, 0)
    const runs = calls.filter((c) => c.args[0] === 'install')
    assert.equal(runs.length, 2)
    assert.equal(runs[0].options.env.npm_config_registry, REGISTRY)
    assert.equal(runs[1].options.env, undefined)
    assert.deepEqual(runs[0].args, runs[1].args)
    assert.ok(
      lines.includes(
        '::warning::AuPM registry install failed; installing from the npm registry instead.',
      ),
    )
  }
})

test('npm AuPM failure falls back to plain npm ci', async () => {
  let n = 0
  const { code, calls } = await runInstall(['package-lock.json'], {}, () => ({
    code: n++ === 0 ? 1 : 0,
  }))
  assert.equal(code, 0)
  assert.deepEqual(
    calls.map((c) => c.args),
    [['ci', '--registry', REGISTRY], ['ci']],
  )
})

test('a failing pnpm fallback fails the step with its code', async () => {
  let n = 0
  const { code } = await runInstall(['pnpm-lock.yaml'], {}, () => ({ code: n++ === 0 ? 1 : 4 }))
  assert.equal(code, 4)
})

test('auto with no lockfile fails and names the files it looked for', async () => {
  const { code, calls, lines } = await runInstall([], {})
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  const [error] = errors(lines)
  assert.match(error, /no lockfile found/)
  assert.match(error, /package-lock\.json, pnpm-lock\.yaml, yarn\.lock/)
})

test('auto with two lockfiles fails, names them and says what to set', async () => {
  const { code, calls, lines } = await runInstall(['package-lock.json', 'yarn.lock'], {})
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  const [error] = errors(lines)
  assert.match(error, /package-lock\.json, yarn\.lock/)
  assert.match(error, /set 'lockfile' or 'install'/)
})

test('an explicit lockfile picks the tool by file name, in the lockfile directory', async () => {
  for (const [name, command] of [
    ['package-lock.json', 'npm'],
    ['pnpm-lock.yaml', 'pnpm'],
  ]) {
    const { code, calls, outputs, dir } = await runInstall(
      [`app/${name}`, 'package-lock.json', 'yarn.lock'],
      { lockfile: `app/${name}` },
    )
    assert.equal(code, 0)
    assert.equal(calls[0].command, command)
    assert.equal(calls[0].options.cwd, resolve(dir, 'app'))
    assert.equal(outputs.lockfile, `app/${name}`)
  }
  const { calls, outputs } = await runInstall(
    ['web/yarn.lock'],
    { lockfile: 'web/yarn.lock' },
    (_c, args) => (args[0] === '--version' ? { stdout: '1.22.22' } : { code: 0 }),
  )
  assert.equal(calls[0].command, 'yarn')
  assert.ok(calls[0].options.cwd.endsWith('/web'))
  assert.equal(outputs.lockfile, 'web/yarn.lock')
})

test('an unknown lockfile name with auto fails with a message that names it', async () => {
  const { code, calls, lines } = await runInstall(['bun.lockb'], { lockfile: 'bun.lockb' })
  assert.equal(code, 1)
  assert.equal(calls.length, 0)
  assert.match(errors(lines)[0], /'bun\.lockb'/)
})

test('an explicit install with an empty lockfile uses that tool lockfile name', async () => {
  const pnpm = await runInstall(['package-lock.json', 'yarn.lock'], { install: 'pnpm' })
  assert.equal(pnpm.code, 0)
  assert.equal(pnpm.calls[0].command, 'pnpm')
  assert.equal(pnpm.outputs.lockfile, 'pnpm-lock.yaml')
  const npm = await runInstall([], { install: 'npm' })
  assert.equal(npm.outputs.lockfile, 'package-lock.json')
})

test('yarn 4.5.0 warns, installs with --immutable and no registry, and skips the check', async () => {
  const { code, calls, lines, outputs } = await runInstall(['yarn.lock'], {}, (_c, args) =>
    args[0] === '--version' ? { stdout: '4.5.0\n' } : { code: 0 },
  )
  assert.equal(code, 0)
  assert.deepEqual(
    calls.map((c) => c.args),
    [['--version'], ['install', '--immutable']],
  )
  assert.equal(calls[1].options.env, undefined)
  assert.ok(
    lines.includes(
      '::warning::AuPM does not support yarn berry yet; installing without AuPM and skipping the check.',
    ),
  )
  assert.equal(outputs['skip-check'], 'true')
})

test('a failing berry install fails the step', async () => {
  const { code } = await runInstall(['yarn.lock'], {}, (_c, args) =>
    args[0] === '--version' ? { stdout: '4.5.0' } : { code: 2 },
  )
  assert.equal(code, 2)
})

test('yarn --version with invalid output fails and installs nothing', async () => {
  const { code, calls, lines } = await runInstall(['yarn.lock'], {}, () => ({ stdout: 'hello' }))
  assert.equal(code, 1)
  assert.equal(calls.length, 1)
  assert.match(errors(lines)[0], /'hello'/)
})

test('a missing yarn fails the step with a message', async () => {
  const { code, calls, lines } = await runInstall(['yarn.lock'], {}, () => ({
    error: 'spawn yarn ENOENT',
  }))
  assert.equal(code, 1)
  assert.equal(calls.length, 1)
  assert.match(errors(lines)[0], /ENOENT/)
})

test('install none with auto lockfile rules installs nothing and outputs the lockfile', async () => {
  const one = await runInstall(['pnpm-lock.yaml'], { install: 'none' })
  assert.equal(one.code, 0)
  assert.equal(one.calls.length, 0)
  assert.equal(one.outputs.lockfile, 'pnpm-lock.yaml')
  const two = await runInstall(['yarn.lock', 'pnpm-lock.yaml'], { install: 'none' })
  assert.equal(two.code, 1)
  const none = await runInstall([], { install: 'none' })
  assert.equal(none.code, 1)
  const named = await runInstall([], { install: 'none', lockfile: 'custom.lock' })
  assert.equal(named.code, 0)
  assert.equal(named.outputs.lockfile, 'custom.lock')
})

test('the check step uses the lockfile the install step resolved', async () => {
  const { outputs, dir } = await runInstall(['sub/pnpm-lock.yaml'], {
    lockfile: 'sub/pnpm-lock.yaml',
  })
  const options = resolveRunOptions([], {
    ENDPOINT: ENDPOINT,
    LOCKFILE: outputs.lockfile,
    CWD: dir,
  })
  const args = buildCliArgs(options)
  assert.ok(args.includes(resolve(dir, 'sub/pnpm-lock.yaml')))
})

test('the check step pins aupm-cli 0.4.0', () => {
  assert.equal(CLI_PACKAGE, 'aupm-cli@0.4.0')
})

for (const tool of ['npm', 'pnpm', 'yarn']) {
  for (const other of ['npm', 'pnpm', 'yarn'].filter((name) => name !== tool)) {
    const file = { npm: 'package-lock.json', pnpm: 'pnpm-lock.yaml', yarn: 'yarn.lock' }[other]
    test(`install ${tool} with ${file} fails and names both`, async () => {
      const { code, calls, lines } = await runInstall([file], { install: tool, lockfile: file })
      assert.equal(code, 1)
      assert.equal(calls.length, 0)
      assert.match(errors(lines)[0], new RegExp(`'${tool}'.*'${file.replace('.', '\\.')}'`))
    })
  }
}

test('an explicit tool accepts a lockfile with an unknown name', async () => {
  const { code, calls, outputs } = await runInstall(['custom.lock'], {
    install: 'pnpm',
    lockfile: 'custom.lock',
  })
  assert.equal(code, 0)
  assert.equal(calls[0].command, 'pnpm')
  assert.equal(outputs.lockfile, 'custom.lock')
})
