// proxy/src/proxy.ts
import type { Context } from 'hono'

const NPM_REGISTRY = 'https://registry.npmjs.org'

export async function proxyToNpm(c: Context): Promise<Response> {
  const query = c.req.query() as Record<string, string>
  const queryStr =
    Object.keys(query).length > 0 ? '?' + new URLSearchParams(query).toString() : ''
  const upstream = `${NPM_REGISTRY}${c.req.path}${queryStr}`

  const headers = new Headers(c.req.raw.headers)
  headers.delete('host')

  const response = await fetch(upstream, {
    method: c.req.method,
    headers,
    body:
      c.req.method !== 'GET' && c.req.method !== 'HEAD' ? c.req.raw.body : undefined,
  })

  return new Response(response.body, {
    status: response.status,
    headers: response.headers,
  })
}
