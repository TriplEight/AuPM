import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test } from 'vitest'
import { parseYamlInWorker } from './yaml-parse.js'

const fixtureDir = path.join(import.meta.dirname, 'fixtures')
const fixtureText = readFileSync(path.join(fixtureDir, 'pnpm-lock.v9.yaml'), 'utf8')
const hangWorker = new URL('./fixtures/hang-worker.mjs', import.meta.url)

describe('parseYamlInWorker', () => {
  test('parses the pnpm fixture to the same value as the yaml package', async () => {
    const { parse } = await import('yaml')
    const outcome = await parseYamlInWorker(fixtureText)
    expect(outcome).toEqual({ kind: 'ok', value: parse(fixtureText) })
  })

  test.each([
    ['a syntax error', 'lockfileVersion: [unclosed\n'],
    ['a duplicate root key', "lockfileVersion: '9.0'\nlockfileVersion: '9.0'\n"],
    ['a duplicate package key', 'packages:\n  x@1.0.0: {}\n  x@1.0.0: {}\n'],
  ])('%s is invalid', async (_label, text) => {
    expect(await parseYamlInWorker(text)).toEqual({ kind: 'invalid' })
  })

  test('a parse that passes the time limit is terminated as too_complex', async () => {
    const outcome = await parseYamlInWorker('a: 1\n', { timeoutMs: 50, workerUrl: hangWorker })
    expect(outcome).toEqual({ kind: 'too_complex' })
  })

  test('the slot is free again after a timeout', async () => {
    await parseYamlInWorker('a: 1\n', { timeoutMs: 50, workerUrl: hangWorker })
    expect((await parseYamlInWorker('a: 1\n')).kind).toBe('ok')
  })

  test('a second parse while one runs is busy', async () => {
    const first = parseYamlInWorker('a: 1\n', { timeoutMs: 200, workerUrl: hangWorker })
    const second = await parseYamlInWorker(fixtureText)
    expect(second).toEqual({ kind: 'busy' })
    expect(await first).toEqual({ kind: 'too_complex' })
  })
})
