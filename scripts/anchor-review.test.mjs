import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseAnchorArgs, readKeyFile } from './anchor-review.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(__dirname, 'anchor-review.mjs')

test('parseAnchorArgs reads positional and flag arguments in order', () => {
  const args = parseAnchorArgs([
    'ms',
    '2.1.3',
    '--reviewer',
    'alice',
    '--scope',
    'source read',
    '--key-file',
    '/tmp/key',
  ])
  assert.deepEqual(args, {
    name: 'ms',
    version: '2.1.3',
    reviewer: 'alice',
    scope: 'source read',
    keyFile: '/tmp/key',
  })
})

test('parseAnchorArgs works with flags before the positional arguments', () => {
  const args = parseAnchorArgs([
    '--key-file',
    '/tmp/key',
    '--reviewer',
    'alice',
    'ms',
    '2.1.3',
    '--scope',
    'source read',
  ])
  assert.equal(args.name, 'ms')
  assert.equal(args.version, '2.1.3')
})

test('parseAnchorArgs throws when a required flag is missing', () => {
  assert.throws(() => parseAnchorArgs(['ms', '2.1.3', '--reviewer', 'alice']), /missing required/)
})

test('parseAnchorArgs throws when a positional argument is missing', () => {
  assert.throws(
    () => parseAnchorArgs(['ms', '--reviewer', 'alice', '--scope', 's', '--key-file', 'k']),
    /missing required/,
  )
})

test('readKeyFile throws when the file does not exist', () => {
  assert.throws(() => readKeyFile(path.join(os.tmpdir(), 'spm-no-such-key-file')), /does not exist/)
})

test('readKeyFile throws when the file is group- or world-readable', () => {
  const p = path.join(os.tmpdir(), `spm-anchor-key-${process.pid}-loose`)
  fs.writeFileSync(p, 'word '.repeat(25).trim(), { mode: 0o644 })
  try {
    assert.throws(() => readKeyFile(p), /must not be readable by group or other/)
  } finally {
    fs.rmSync(p)
  }
})

test('readKeyFile reads and trims a properly-permissioned file', () => {
  const p = path.join(os.tmpdir(), `spm-anchor-key-${process.pid}-tight`)
  const mnemonic = Array.from({ length: 25 }, (_, i) => `word${i}`).join(' ')
  fs.writeFileSync(p, `${mnemonic}\n`, { mode: 0o600 })
  try {
    assert.equal(readKeyFile(p), mnemonic)
  } finally {
    fs.rmSync(p)
  }
})

// -- no TTY: the real script must refuse before any file, network or chain
// access. Spawned with stdio piped (never a TTY), no valid arguments, and
// no network reachable — a hang or a network attempt would fail this test.
test('anchor-review.mjs refuses immediately with no TTY on stdin', () => {
  const result = spawnSync(process.execPath, [SCRIPT], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires an interactive TTY/)
})
