// mcp/src/proxy-url.ts
//
// The AuPM registry origin that the MCP tools and the aupm CLI call.
// AUPM_PROXY_URL overrides the MainNet origin. The value is read at call
// time, so a test or a caller can set the variable after import.

export const DEFAULT_PROXY_URL = 'https://aupm.fyi'

/** Returns the registry origin without a trailing slash. */
export function proxyUrl(): string {
  return (process.env.AUPM_PROXY_URL ?? DEFAULT_PROXY_URL).replace(/\/+$/, '')
}
