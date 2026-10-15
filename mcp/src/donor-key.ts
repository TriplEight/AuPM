// mcp/src/donor-key.ts
//
// The donor key file: `$XDG_CONFIG_HOME/aupm/donor.key` (default `~/.config/aupm/donor.key`).
// It holds the 25 words (Algo25) or the 24 words (Universal Wallet) and a newline,
// nothing else. Directory 0700, file 0600.
//
// WARNING: never print or expose the mnemonic. Error messages name the path only.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { isValidPhrase } from './key-phrase.js'

/** Env var holding the donor's 25-word Algorand mnemonic or 24-word Universal Wallet phrase. */
export const AUPM_DONOR_MNEMONIC_ENV = 'AUPM_DONOR_MNEMONIC'

/** Path of the donor key file. Reads XDG_CONFIG_HOME at call time. */
export function donorKeyFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'aupm', 'donor.key')
}

/** Writes the key file. Refuses when the file exists. Never prints the mnemonic. */
export function writeDonorKeyFile(mnemonic: string): string {
  const file = donorKeyFilePath()
  if (fs.existsSync(file)) {
    throw new Error(`donor key file already exists: ${file}. Run: aupm donor status`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 })
  // Flag 'wx' fails when the file exists: a racing second init cannot overwrite the key.
  fs.writeFileSync(file, `${mnemonic}\n`, { flag: 'wx', mode: 0o600 })
  return file
}

/**
 * Reads the mnemonic from the key file. Returns null when the file does not exist.
 * Refuses a file whose mode is wider than 0600. Windows has no POSIX mode: it skips this check.
 * Refuses a file that is not exactly one valid 25-word or 24-word phrase.
 */
export function readDonorKeyFile(): string | null {
  const file = donorKeyFilePath()
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
  const value = fs.readFileSync(file, 'utf8').trim()
  if (value.includes('\n') || !isValidPhrase(value)) {
    throw new Error(`donor key file ${file} must hold one line with 25 or 24 valid mnemonic words`)
  }
  return value
}

/** The env var wins; otherwise the key file. Throws when neither exists. */
export function loadDonorMnemonic(): string {
  const fromEnv = process.env[AUPM_DONOR_MNEMONIC_ENV]
  if (fromEnv) return fromEnv.trim()
  const fromFile = readDonorKeyFile()
  if (fromFile) return fromFile
  throw new Error(
    'No donor key found. Run `aupm donor init` to make one.\n' +
      `Experts: set ${AUPM_DONOR_MNEMONIC_ENV}, or put the key in ${donorKeyFilePath()}.`,
  )
}
