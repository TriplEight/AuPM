// proxy/src/secret.ts
//
// One loader for server secrets. A secret NAME can come from the variable
// NAME or from the file that NAME_FILE names. The server deployment uses the
// file form: Docker secrets keep the value out of `docker compose config`,
// `docker inspect` and the redeploy UI. The variable form stays for local dev.
//
// Error messages name the variable and the path. They never hold the value.
import { readFileSync, statSync } from 'node:fs'

const GROUP_OR_OTHER_BITS = 0o077

function trimOneTrailingNewline(value: string): string {
  if (value.endsWith('\r\n')) return value.slice(0, -2)
  if (value.endsWith('\n')) return value.slice(0, -1)
  return value
}

function readSecretFile(name: string, path: string): string {
  let mode: number
  try {
    mode = statSync(path).mode
  } catch {
    throw new Error(`${name}_FILE: cannot read the file at ${path} (missing or not accessible)`)
  }
  if ((mode & GROUP_OR_OTHER_BITS) !== 0) {
    throw new Error(
      `${name}_FILE: the file at ${path} is readable by group or other; ` +
        'set its mode to 0400 or 0600',
    )
  }
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    throw new Error(`${name}_FILE: cannot read the file at ${path} (missing or not accessible)`)
  }
  const value = trimOneTrailingNewline(raw)
  if (value === '') {
    throw new Error(`${name}_FILE: the file at ${path} is empty`)
  }
  return value
}

/**
 * Returns the secret NAME, or undefined when neither NAME nor NAME_FILE is set.
 *
 * Throws when both are set, when the file cannot be read, when the file mode
 * allows group or other access, or when the file value is empty. Trims one
 * trailing newline from the file value and nothing else.
 */
export function readSecret(name: string): string | undefined {
  const direct = process.env[name]
  const path = process.env[`${name}_FILE`]
  const hasDirect = direct !== undefined && direct !== ''
  const hasFile = path !== undefined && path !== ''
  if (hasDirect && hasFile) {
    throw new Error(`${name} and ${name}_FILE are both set; set only one of them`)
  }
  if (hasFile) return readSecretFile(name, path)
  return hasDirect ? direct : undefined
}

/** Boot guard: checks the `_FILE` form of each server secret. Reads no key material into state. */
export function assertValidSecretSources(): void {
  readSecret('ATTEST_SIGNING_KEY')
  readSecret('CREDITER_MNEMONIC')
}
