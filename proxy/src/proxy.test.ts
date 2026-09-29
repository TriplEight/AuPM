// proxy/src/proxy.test.ts
//
// Drives proxyToNpm through a minimal Hono app — app.request(), not a raw
// Context — with a stubbed fetch (never the real registry). deps.timeoutMs
// is set small in the timeout test so the test runs fast without fake
// timers; a real AbortSignal.timeout still fires, proving the wiring works.
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import zlib from 'node:zlib'
import { Hono } from 'hono'
import { describe, expect, test, vi } from 'vitest'
import { type ProxyToNpmDeps, proxyToNpm } from './proxy.js'

function appWith(deps: ProxyToNpmDeps) {
  const app = new Hono()
  app.all('*', (c) => proxyToNpm(c, deps))
  return app
}

describe('proxyToNpm', () => {
  test('passes through a normal upstream response unchanged', async () => {
    const body = JSON.stringify({ name: 'left-pad' })
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        new Response(body, { status: 200, headers: { 'content-type': 'application/json' } }),
      )
    const app = appWith({ fetch: fetchMock, timeoutMs: 30_000 })

    const res = await app.request('/left-pad')

    expect(res.status).toBe(200)
    expect(await res.text()).toBe(body)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [upstreamUrl] = fetchMock.mock.calls[0] as [string]
    expect(upstreamUrl).toBe('https://registry.npmjs.org/left-pad')
  })

  test('returns 504 when the upstream stalls past the timeout', async () => {
    // Mirrors what a real hung fetch does under AbortSignal.timeout: it
    // never settles on its own, and rejects only once the signal aborts.
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted.', 'TimeoutError'))
          })
        }),
    )
    const app = appWith({ fetch: fetchMock, timeoutMs: 5 })

    const res = await app.request('/left-pad')

    expect(res.status).toBe(504)
    expect(await res.json()).toEqual({ error: 'npm registry timeout' })
  })

  test('does not mask a non-timeout fetch error as a 504', async () => {
    // proxyToNpm rethrows; Hono's default error handler turns that into a
    // 500, not the 504 reserved for an upstream timeout.
    const fetchMock = vi.fn().mockRejectedValue(new Error('network unreachable'))
    const app = appWith({ fetch: fetchMock, timeoutMs: 30_000 })
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const res = await app.request('/left-pad')

    expect(res.status).toBe(500)
    consoleError.mockRestore()
  })

  test('drops content-encoding and content-length after fetch decodes a gzip body', async () => {
    // A real fetch against a real gzip server: fetch decodes the body but
    // keeps the upstream headers. Forwarding them makes npm gunzip plain
    // JSON and fail with Z_DATA_ERROR.
    const body = JSON.stringify({ name: 'ms', padding: 'x'.repeat(2048) })
    const server = http.createServer((_req, res) => {
      const gz = zlib.gzipSync(body)
      res.writeHead(200, {
        'content-type': 'application/json',
        'content-encoding': 'gzip',
        'content-length': String(gz.length),
      })
      res.end(gz)
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const { port } = server.address() as AddressInfo
    const localFetch: typeof fetch = (input, init) =>
      fetch(String(input).replace('https://registry.npmjs.org', `http://127.0.0.1:${port}`), init)

    try {
      const app = appWith({ fetch: localFetch, timeoutMs: 30_000 })
      const res = await app.request('/ms', { headers: { 'accept-encoding': 'gzip' } })

      expect(res.status).toBe(200)
      expect(res.headers.get('content-encoding')).toBeNull()
      expect(res.headers.get('content-length')).toBeNull()
      expect(res.headers.get('content-type')).toBe('application/json')
      expect(await res.text()).toBe(body)
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})
