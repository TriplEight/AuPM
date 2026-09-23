// mcp/src/lockfile-entries.ts
//
// Counts the package entries in a lockfile body, so the CLI and the MCP
// server compute the same client-side spend cap (SPEC.md §11.4) from one
// place, instead of three separate copies.

/** Thrown when the body is not valid JSON, or not a lockfileVersion 2/3 shape. */
export class LockfileParseError extends Error {}

type PackagesMapLockfile = { packages: Record<string, unknown> }

function isPackagesMapLockfile(value: unknown): value is PackagesMapLockfile {
  if (typeof value !== 'object' || value === null) return false
  const packages = (value as { packages?: unknown }).packages
  return typeof packages === 'object' && packages !== null && !Array.isArray(packages)
}

/**
 * Counts the entries in a `package-lock.json` body: the keys of the
 * `lockfileVersion` 2/3 `packages` map, excluding the root `""` key
 * (SPEC.md §11.4). Never trusts `lockfileVersion` alone — only the
 * `packages` map shape matters here, the same thing the server's own
 * lockfile analysis keys on.
 */
export function countLockfileEntries(lockfileBytes: Uint8Array | Buffer | string): number {
  const text =
    typeof lockfileBytes === 'string' ? lockfileBytes : Buffer.from(lockfileBytes).toString('utf8')

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new LockfileParseError(
      `lockfile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  if (!isPackagesMapLockfile(parsed)) {
    throw new LockfileParseError('lockfile has no lockfileVersion 2/3 "packages" map')
  }

  return Object.keys(parsed.packages).filter((key) => key !== '').length
}
