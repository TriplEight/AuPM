// proxy/src/proxy.test.ts
//
// Drives proxyToNpm through a minimal Hono app — app.request(), not a raw
// Context — with a stubbed fetch (never the real registry). deps.timeoutMs
// is set small in the timeout test so the test runs fast without fake
// timers; a real AbortSignal.timeout still fires, proving the wiring works.
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
})
