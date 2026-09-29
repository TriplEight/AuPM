// proxy/src/proxy.ts
import type { Context } from 'hono'

const NPM_REGISTRY = 'https://registry.npmjs.org'

// NPM_UPSTREAM_TIMEOUT_MS bounds how long proxyToNpm waits on the upstream
// npm registry. Without it, a slow or hung registry holds the client's
// connection open indefinitely. The signal also aborts the response body, so
// the bound covers the whole upstream transfer. A timeout before the headers
// returns 504. A timeout after the headers ends the piped body with an error.
export const NPM_UPSTREAM_TIMEOUT_MS = 30_000

export interface ProxyToNpmDeps {
  fetch: typeof fetch
  timeoutMs: number
}

const defaultDeps: ProxyToNpmDeps = {
  fetch: (...args: Parameters<typeof fetch>) => fetch(...args),
  timeoutMs: NPM_UPSTREAM_TIMEOUT_MS,
}

export async function proxyToNpm(
  c: Context,
  deps: ProxyToNpmDeps = defaultDeps,
): Promise<Response> {
  const query = c.req.query() as Record<string, string>
  const queryStr = Object.keys(query).length > 0 ? `?${new URLSearchParams(query).toString()}` : ''
  const upstream = `${NPM_REGISTRY}${c.req.path}${queryStr}`

  const headers = new Headers(c.req.raw.headers)
  headers.delete('host')

  let response: Response
  try {
    response = await deps.fetch(upstream, {
      method: c.req.method,
      headers,
      body: c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
      signal: AbortSignal.timeout(deps.timeoutMs),
    })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      return c.json({ error: 'npm registry timeout' }, 504)
    }
    throw err
  }

  // fetch has already decoded the body, so the upstream encoding and length
  // no longer describe it. Forwarding them makes npm gunzip plain JSON.
  const responseHeaders = new Headers(response.headers)
  responseHeaders.delete('content-encoding')
  responseHeaders.delete('content-length')

  return new Response(response.body, {
    status: response.status,
    headers: responseHeaders,
  })
}
