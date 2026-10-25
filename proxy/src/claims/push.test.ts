// proxy/src/claims/push.test.ts
//
// Runs pushStatus against a real node:http stub on 127.0.0.1, so the request
// that leaves the process is the request under test.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, describe, expect, test, vi } from 'vitest'
import { buildNightlyPush, PUSH_MSG_MAX_CHARS, pushStatus } from './push.js'

const TOKEN = 'SECRET-TOKEN-123'

let server: http.Server | null = null
afterEach(async () => {
  if (!server) return
  server.closeAllConnections()
  await new Promise((resolve) => server?.close(resolve))
  server = null
})

async function startStub(
  handler: http.RequestListener,
): Promise<{ url: string; requests: http.IncomingMessage[] }> {
  const requests: http.IncomingMessage[] = []
  server = http.createServer((req, res) => {
    requests.push(req)
    handler(req, res)
  })
  await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return { url: `http://127.0.0.1:${port}/api/push/${TOKEN}`, requests }
}

const ok: http.RequestListener = (_req, res) => {
  res.end('{"ok":true}')
}

describe('pushStatus', () => {
  test('sends one GET with status=down and the alert text in msg', async () => {
    const { url, requests } = await startStub(ok)
    const alert =
      'mainnet ALERT matured unpaid payee total grew 7 nights in a row, now 5 micro-USDC'

    await pushStatus(url, 'down', alert)

    expect(requests).toHaveLength(1)
    expect(requests[0]?.method).toBe('GET')
    const sent = new URL(requests[0]?.url ?? '', 'http://x')
    expect(sent.pathname).toBe(`/api/push/${TOKEN}`)
    expect(sent.searchParams.get('status')).toBe('down')
    expect(sent.searchParams.get('msg')).toBe(alert)
  })

  test('replaces status and msg and drops ping from the URL', async () => {
    const { url, requests } = await startStub(ok)

    await pushStatus(`${url}?status=up&msg=OK&ping=&keep=1`, 'down', 'real message')

    const sent = new URL(requests[0]?.url ?? '', 'http://x')
    expect(sent.searchParams.getAll('status')).toEqual(['down'])
    expect(sent.searchParams.getAll('msg')).toEqual(['real message'])
    expect(sent.searchParams.has('ping')).toBe(false)
    expect(sent.searchParams.get('keep')).toBe('1')
  })

  test('truncates a long msg', async () => {
    const { url, requests } = await startStub(ok)

    await pushStatus(url, 'up', 'x'.repeat(PUSH_MSG_MAX_CHARS + 100))

    const sent = new URL(requests[0]?.url ?? '', 'http://x')
    expect(sent.searchParams.get('msg')).toHaveLength(PUSH_MSG_MAX_CHARS)
  })

  test('a 500 answer logs the status, not the token, and resolves', async () => {
    const { url } = await startStub((_req, res) => {
      res.statusCode = 500
      res.end('boom')
    })
    const log = vi.fn()

    await expect(pushStatus(url, 'up', 'ok', { log })).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledWith('aupm-nightly: push failed — HTTP 500')
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })

  test('a hanging server past the timeout logs the error name, not the token', async () => {
    const { url } = await startStub(() => {})
    const log = vi.fn()

    await expect(pushStatus(url, 'up', 'ok', { log, timeoutMs: 100 })).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledWith('aupm-nightly: push failed — TimeoutError')
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })

  test('an unreachable host logs without the token and resolves', async () => {
    const { url } = await startStub(ok)
    await new Promise((resolve) => server?.close(resolve))
    server = null
    const log = vi.fn()

    await expect(pushStatus(url, 'up', 'ok', { log })).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })

  test('an invalid URL logs without the URL text and resolves', async () => {
    const log = vi.fn()

    await expect(pushStatus(`not a url ${TOKEN}`, 'up', 'ok', { log })).resolves.toBeUndefined()

    expect(log).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(log.mock.calls)).not.toContain(TOKEN)
  })
})

describe('buildNightlyPush', () => {
  test('returns undefined when the variable is unset or empty', () => {
    expect(buildNightlyPush({})).toBeUndefined()
    expect(buildNightlyPush({ AUPM_NIGHTLY_PUSH_URL: '' })).toBeUndefined()
  })

  test('returns a push function when the variable is set', () => {
    const push = buildNightlyPush({ AUPM_NIGHTLY_PUSH_URL: 'http://127.0.0.1:1/x' })
    expect(push).toBeTypeOf('function')
  })
})
