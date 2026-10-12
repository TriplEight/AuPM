// mcp/src/config.ts
//
// The "always donate" setting (SPEC.md §11.4). Precedence, highest first:
// the explicit choice (the CLI flag `--donate` or `--no-donate`, or the MCP call argument
// `allowDonation`), the env var `AUPM_DONATE`, the config file
// `$XDG_CONFIG_HOME/aupm/config.toml` (default `~/.config/aupm/config.toml`), then off.
// The aupm CLI and the MCP server read this setting. Plain `npm install` stays free (ADR 0006).
//
// The config file is a strict subset of TOML: blank lines, `#` comments and one line
// `donate = true` or `donate = false`. Any other line is an error. No TOML library.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DONATE_ENV = 'AUPM_DONATE'

export type DonateSource = 'explicit' | 'env' | 'file' | 'default'

export interface DonateSetting {
  value: boolean
  source: DonateSource
}

/** Tool description text that states how the donation setting resolves. */
export const DONATION_SETTING_TEXT =
  `Donation setting: allowDonation in the call wins, true or false. Without it, the env var ${DONATE_ENV} ` +
  "(true or false) applies. Then 'donate = true' in $XDG_CONFIG_HOME/aupm/config.toml applies. " +
  'If none is set, donation is off. A malformed env var or config file makes the call fail with an error.'

/** Thrown for a malformed env value or config file. The message says how to fix it. */
export class ConfigError extends Error {}

const FILE_HEADER = '# AuPM CLI settings. Edit with: aupm config set donate <true|false>\n'
const ACCEPTED_LINE = 'donate = true  or  donate = false'
const DONATE_LINE = /^donate\s*=\s*(true|false)\s*(#.*)?$/

/** Path of the config file. Reads XDG_CONFIG_HOME at call time. */
export function configFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'aupm', 'config.toml')
}

/** Reads `donate` from the config file. Returns undefined when the file or the key is absent. */
export function readConfigDonate(file: string = configFilePath()): boolean | undefined {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  let value: boolean | undefined
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const match = DONATE_LINE.exec(line)
    if (!match) {
      throw new ConfigError(
        `${file}:${index + 1}: cannot read this line: ${JSON.stringify(line)}. ` +
          `Accepted: ${ACCEPTED_LINE}, blank lines, and # comments.`,
      )
    }
    value = match[1] === 'true'
  }
  return value
}

function readEnvDonate(env: NodeJS.ProcessEnv): boolean | undefined {
  const raw = env[DONATE_ENV]
  if (raw === undefined || raw === '') return undefined
  if (raw === 'true') return true
  if (raw === 'false') return false
  throw new ConfigError(`${DONATE_ENV} is ${JSON.stringify(raw)}. Accepted values: true or false.`)
}

/**
 * Resolves the effective donate setting. An explicit choice skips the env var and the file,
 * so a malformed value there does not block `--donate`, `--no-donate` or `allowDonation`.
 */
export function resolveDonate(
  explicit: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DonateSetting {
  if (explicit !== undefined) return { value: explicit, source: 'explicit' }
  const fromEnv = readEnvDonate(env)
  if (fromEnv !== undefined) return { value: fromEnv, source: 'env' }
  const fromFile = readConfigDonate()
  if (fromFile !== undefined) return { value: fromFile, source: 'file' }
  return { value: false, source: 'default' }
}

/** Writes the config file with `donate = <value>`. Returns the path. */
export function writeConfigDonate(value: boolean): string {
  const file = configFilePath()
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${FILE_HEADER}donate = ${value}\n`)
  return file
}
