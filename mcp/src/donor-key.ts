// mcp/src/donor-key.ts
//
// The donor key file: `$XDG_CONFIG_HOME/aupm/donor.env` (default `~/.config/aupm/donor.env`),
// one line `AUPM_DONOR_MNEMONIC=<25 words>`, directory 0700, file 0600 (SPEC.md §11.4).
//
// WARNING: never print or expose the mnemonic. Error messages name the path only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Env var holding the donor's 25-word Algorand mnemonic. */
export const AUPM_DONOR_MNEMONIC_ENV = 'AUPM_DONOR_MNEMONIC'

/** Path of the donor env file. Reads XDG_CONFIG_HOME at call time. */
export function donorEnvFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'aupm', 'donor.env')
}

/** Writes the key file. Refuses when the file exists. Never prints the mnemonic. */
export function writeDonorEnvFile(mnemonic: string): string {
  const file = donorEnvFilePath()
  if (fs.existsSync(file)) {
    throw new Error(`donor key file already exists: ${file}. Run: aupm donor status`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Flag 'wx' fails when the file exists: a racing second init cannot overwrite the key.
  fs.writeFileSync(file, `${AUPM_DONOR_MNEMONIC_ENV}=${mnemonic}\n`, { flag: 'wx', mode: 0o600 })
  return file
}

/**
 * Reads the mnemonic from the key file. Returns null when the file does not exist.
 * Refuses a file whose mode is wider than 0600. Windows has no POSIX mode: it skips this check.
 */
export function readDonorEnvFile(): string | null {
  const file = donorEnvFilePath()
  let stat: fs.Stats
  try {
    stat = fs.statSync(file)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
  if (process.platform !== 'win32' && (stat.mode & 0o177) !== 0) {
    const mode = (stat.mode & 0o777).toString(8).padStart(4, '0')
    throw new Error(
      `donor key file ${file} has mode ${mode}, wider than 0600. Fix: chmod 600 ${file}`,
    )
  }
  const prefix = `${AUPM_DONOR_MNEMONIC_ENV}=`
  const line = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .find((candidate) => candidate.startsWith(prefix))
  const value = line?.slice(prefix.length).trim()
  if (!value) throw new Error(`donor key file ${file} has no ${AUPM_DONOR_MNEMONIC_ENV} line`)
  return value
}

/** The env var wins; otherwise the key file. Throws when neither exists. */
export function loadDonorMnemonic(): string {
  const fromEnv = process.env[AUPM_DONOR_MNEMONIC_ENV]
  if (fromEnv) return fromEnv
  const fromFile = readDonorEnvFile()
  if (fromFile) return fromFile
  throw new Error(
    `${AUPM_DONOR_MNEMONIC_ENV} env var not set and no key file at ${donorEnvFilePath()}. ` +
      'Run: aupm donor init',
  )
}
