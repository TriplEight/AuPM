import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, test, vi } from 'vitest'
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
describe('parseYamlInWorker: server faults', () => {
  const missingWorker = new URL('./fixtures/no-such-worker.mjs', import.meta.url)
  const throwWorker = new URL('./fixtures/throw-worker.mjs', import.meta.url)
  const exitWorker = new URL('./fixtures/exit-worker.mjs', import.meta.url)
  const body = 'secret-body-text: 1\n'

  function silenceLog() {
    return vi.spyOn(console, 'error').mockImplementation(() => undefined)
  }

  test.each([
    ['a worker script that does not exist', missingWorker],
    ['a worker script that throws at load', throwWorker],
    ['a worker that exits without a message', exitWorker],
  ])('%s is an error outcome, logged once without the body', async (_label, workerUrl) => {
    const logged = silenceLog()
    try {
      const outcome = await parseYamlInWorker(body, { workerUrl })
      expect(outcome).toMatchObject({ kind: 'error', code: expect.any(String) })
      expect(logged).toHaveBeenCalledTimes(1)
      expect(String(logged.mock.calls[0]?.[0])).not.toContain('secret-body-text')
    } finally {
      logged.mockRestore()
    }
  })

  test('the slot is free again after a server fault', async () => {
    const logged = silenceLog()
    try {
      await parseYamlInWorker(body, { workerUrl: throwWorker })
    } finally {
      logged.mockRestore()
    }
    expect((await parseYamlInWorker('a: 1\n')).kind).toBe('ok')
  })

  test('a normal parse logs nothing', async () => {
    const logged = silenceLog()
    try {
      await parseYamlInWorker('a: 1\n')
      expect(logged).not.toHaveBeenCalled()
    } finally {
      logged.mockRestore()
    }
  })
})
