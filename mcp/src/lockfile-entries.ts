// mcp/src/lockfile-entries.ts
//
// Counts the package entries in a lockfile body, so the CLI and the MCP
// server compute the same client-side spend cap (SPEC.md §11.4) from one
// place, instead of three separate copies. It handles package-lock.json
// (JSON), pnpm-lock.yaml (lockfileVersion '9.0') and yarn.lock (yarn classic
// v1); the lockfile's file name picks the format.
import path from 'node:path'
import { isMap, isScalar, parseDocument } from 'yaml'

export const PNPM_LOCKFILE_NAME = 'pnpm-lock.yaml'
export const PNPM_LOCKFILE_VERSION = '9.0'
/** The server answers 413 above this size, before it parses (ADR 0015). */
export const PNPM_LOCKFILE_MAX_BYTES = 2 * 1024 * 1024

export const YARN_LOCKFILE_NAME = 'yarn.lock'
export const YARN_CLASSIC_HEADER = '# yarn lockfile v1'

/** Shown for a yarn berry (v2+) lockfile or install. AuPM attests only yarn classic. */
export const YARN_BERRY_MESSAGE =
  'AuPM attests only yarn classic (v1) lockfiles. For a free install without an AuPM ' +
  'attestation, set `npmRegistryServer: "<registry URL>"` in `.yarnrc.yml`. That install is ' +
  'not verified by AuPM. (Classic uses `registry` in `.yarnrc`; `aupm yarn` sets it for you.)'

/** Thrown when the body is not valid JSON or YAML, or not a supported lockfile shape. */
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

/** True when the file name selects the pnpm parser, as on the server. */
export function isPnpmLockfilePath(lockfilePath: string): boolean {
  return path.basename(lockfilePath) === PNPM_LOCKFILE_NAME
}

function hasDuplicateKey(node: unknown): boolean {
  if (!isMap(node)) return false
  const seen = new Set<unknown>()
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

/**
 * Counts the entries in a `pnpm-lock.yaml` body: the keys of the top-level
 * `packages` map of lockfileVersion '9.0' (`name@version`, scoped
 * `@scope/name@version`). A project with no dependencies has no `packages`
 * key and counts 0. The file is local and trusted, so it parses in-process;
 * `uniqueKeys: false` skips the library's quadratic duplicate check, and a
 * duplicate key in the root or in `packages` is rejected here in linear time.
 */
export function countPnpmLockfileEntries(lockfileBytes: Uint8Array | Buffer | string): number {
  const text =
    typeof lockfileBytes === 'string' ? lockfileBytes : Buffer.from(lockfileBytes).toString('utf8')

  const doc = parseDocument(text, { uniqueKeys: false })
  if (doc.errors.length > 0) {
    throw new LockfileParseError(`lockfile is not valid YAML: ${doc.errors[0].message}`)
  }
  if (hasDuplicateKey(doc.contents) || hasDuplicateKey(doc.get('packages', true))) {
    throw new LockfileParseError('lockfile has a duplicate key in the root or in "packages"')
  }

  const parsed: unknown = doc.toJS()
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new LockfileParseError('lockfile must be a YAML mapping')
  }
  const { lockfileVersion, packages = {} } = parsed as {
    lockfileVersion?: unknown
    packages?: unknown
  }
  if (lockfileVersion !== PNPM_LOCKFILE_VERSION) {
    throw new LockfileParseError(
      `pnpm lockfileVersion must be '${PNPM_LOCKFILE_VERSION}' (the only accepted version)`,
    )
  }
  if (typeof packages !== 'object' || packages === null || Array.isArray(packages)) {
    throw new LockfileParseError('lockfile "packages" must be a mapping')
  }
  return Object.keys(packages).length
}

/** True when the file name selects the yarn classic parser. */
export function isYarnLockfilePath(lockfilePath: string): boolean {
  return path.basename(lockfilePath) === YARN_LOCKFILE_NAME
}

function hasYarnClassicHeader(lines: string[]): boolean {
  for (const line of lines) {
    if (line === YARN_CLASSIC_HEADER) return true
    if (line !== '' && !line.startsWith('#')) return false
  }
  return false
}

/**
 * Counts the entries in a yarn classic `yarn.lock` body: one entry per block header
 * (a column-0 line that ends in `:`). Grouped selectors in one header are one entry.
 * A berry lockfile (`__metadata:` at column 0) is refused with the berry message.
 * The header rule matches the server: the exact line `# yarn lockfile v1` in the
 * initial comment block.
 */
export function countYarnLockfileEntries(lockfileBytes: Uint8Array | Buffer | string): number {
  const text =
    typeof lockfileBytes === 'string' ? lockfileBytes : Buffer.from(lockfileBytes).toString('utf8')
  const lines = text
    .replace(/^\uFEFF/, '')
    .split('\n')
    .map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))

  if (lines.some((line) => line.startsWith('__metadata:'))) {
    throw new LockfileParseError(YARN_BERRY_MESSAGE)
  }
  if (!hasYarnClassicHeader(lines)) {
    throw new LockfileParseError(
      `yarn.lock has no "${YARN_CLASSIC_HEADER}" header line; AuPM accepts only yarn classic (v1)`,
    )
  }
  return lines.filter((line) => line !== '' && !/^[#\s]/.test(line) && line.endsWith(':')).length
}

/** Counts the entries of a lockfile, choosing the parser by file name. */
export function countEntriesForFile(
  lockfilePath: string,
  lockfileBytes: Uint8Array | Buffer | string,
): number {
  if (isPnpmLockfilePath(lockfilePath)) return countPnpmLockfileEntries(lockfileBytes)
  if (isYarnLockfilePath(lockfilePath)) return countYarnLockfileEntries(lockfileBytes)
  return countLockfileEntries(lockfileBytes)
}
