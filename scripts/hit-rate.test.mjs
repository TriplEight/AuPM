import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { lockfileNames, measure, median, parseCandidates } from './hit-rate.mjs'

/** Creates a fresh temp directory for one test and returns its path. */
function makeTempDir() {
  return mkdtempSync(join(tmpdir(), 'spm-hit-rate-'))
}

/** Writes `content` (already stringified or an object) to `path` as JSON. */
function writeJson(path, content) {
  const text = typeof content === 'string' ? content : JSON.stringify(content)
  writeFileSync(path, text)
}

test('parseCandidates ignores blanks and comments, dedups', () => {
  const text = '\nms\n# a comment\n@babel/core\nms\n   \n@babel/core\n'
  assert.deepEqual(parseCandidates(text), ['ms', '@babel/core'])
})

test('parseCandidates on an empty file returns an empty list', () => {
  assert.deepEqual(parseCandidates(''), [])
  assert.deepEqual(parseCandidates('\n\n# only comments\n\n'), [])
})

test('lockfileNames v3 reads nested scoped keys and skips the root', () => {
  const doc = {
    lockfileVersion: 3,
    packages: {
      '': { name: 'root-app' },
      'node_modules/a': { version: '1.0.0' },
      'node_modules/a/node_modules/@scope/b': { version: '2.0.0' },
    },
  }
  const names = lockfileNames(doc, 'test.json')
  assert.deepEqual([...names].sort(), ['@scope/b', 'a'])
})

test('lockfileNames v3 skips link entries', () => {
  const doc = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0' },
      'node_modules/linked-pkg': { resolved: 'packages/linked-pkg', link: true },
    },
  }
  const names = lockfileNames(doc, 'test.json')
  assert.deepEqual([...names].sort(), ['a'])
})

test('lockfileNames v3 counts a name once across duplicate nesting', () => {
  const doc = {
    lockfileVersion: 3,
    packages: {
      '': {},
      'node_modules/a': { version: '1.0.0' },
      'node_modules/dup': { version: '1.0.0' },
      'node_modules/a/node_modules/dup': { version: '2.0.0' },
    },
  }
  const names = lockfileNames(doc, 'test.json')
  assert.equal(names.size, 2)
  assert.ok(names.has('dup'))
  assert.ok(names.has('a'))
})

test('lockfileNames v1 walks the recursive dependencies map', () => {
  const doc = {
    lockfileVersion: 1,
    dependencies: {
      a: {
        version: '1.0.0',
        dependencies: {
          dup: { version: '1.0.0' },
        },
      },
      dup: { version: '2.0.0' },
    },
  }
  const names = lockfileNames(doc, 'test.json')
  assert.deepEqual([...names].sort(), ['a', 'dup'])
})

test('lockfileNames rejects a v3 doc missing the packages map', () => {
  assert.throws(() => lockfileNames({ lockfileVersion: 3 }, 'bad.json'), /bad\.json.*packages/)
})

test('lockfileNames rejects an unsupported lockfileVersion', () => {
  assert.throws(
    () => lockfileNames({ lockfileVersion: 99 }, 'weird.json'),
    /weird\.json.*lockfileVersion/,
  )
})

test('lockfileNames rejects a non-object document', () => {
  assert.throws(() => lockfileNames(null, 'null.json'), /null\.json/)
})

test('median of an odd-length array is the middle value', () => {
  assert.equal(median([5, 1, 3]), 3)
})

test('median of an even-length array averages the two middle values', () => {
  assert.equal(median([1, 2, 3, 4]), 2.5)
})

test('median of an empty array is NaN', () => {
  assert.ok(Number.isNaN(median([])))
})

test('measure counts distinct candidate hits per lockfile and tallies frequency', () => {
  const dir = makeTempDir()
  try {
    const lockA = join(dir, 'a-lock.json')
    const lockB = join(dir, 'b-lock.json')
    writeJson(lockA, {
      lockfileVersion: 3,
      packages: {
        '': {},
        'node_modules/ms': { version: '2.1.3' },
        'node_modules/inherits': { version: '2.0.4' },
        'node_modules/a/node_modules/ms': { version: '2.1.3' },
      },
    })
    writeJson(lockB, {
      lockfileVersion: 1,
      dependencies: {
        wrappy: { version: '1.0.2' },
      },
    })
    const candidates = parseCandidates('ms\ninherits\nwrappy\nonce\n')
    const { rows, hitsCounts, frequency } = measure(candidates, [lockA, lockB])

    const rowA = rows.find((r) => r.file === lockA)
    const rowB = rows.find((r) => r.file === lockB)
    assert.equal(rowA.total, 2)
    assert.equal(rowA.hits, 2)
    assert.equal(rowB.total, 1)
    assert.equal(rowB.hits, 1)
    assert.deepEqual(hitsCounts, [2, 1])
    assert.equal(frequency.get('ms'), 1)
    assert.equal(frequency.get('inherits'), 1)
    assert.equal(frequency.get('wrappy'), 1)
    assert.equal(frequency.get('once'), 0)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('measure fails naming the file when a lockfile is malformed JSON', () => {
  const dir = makeTempDir()
  try {
    const badLock = join(dir, 'broken-lock.json')
    writeJson(badLock, '{ not valid json')
    assert.throws(
      () => measure(['ms'], [badLock]),
      (err) => {
        return err.message.includes(badLock) && /malformed JSON/.test(err.message)
      },
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
