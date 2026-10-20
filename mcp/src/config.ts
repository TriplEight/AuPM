// mcp/src/config.ts
//
// The "always donate" and donor multiplier settings. Precedence, highest first:
// the explicit choice (the CLI flag `--donate` or `--no-donate`, or the MCP call argument
// `allowDonation`), the env var `AUPM_DONATE`, the config file
// `$XDG_CONFIG_HOME/aupm/config.toml` (default `~/.config/aupm/config.toml`), then off.
// The aupm CLI and the MCP server read this setting. Plain `npm install` stays free.
//
// The config file is a strict subset of TOML: blank lines, `#` comments and one line
// `donate = true` or `donate = false`, or one line `multiplier = "2.5"`. Any other line is an
// error. The multiplier env var is `AUPM_MULTIPLIER`; it has no explicit choice. No TOML library.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DONATE_ENV = 'AUPM_DONATE'
export const MULTIPLIER_ENV = 'AUPM_MULTIPLIER'

export type DonateSource = 'explicit' | 'env' | 'file' | 'default'

export interface DonateSetting {
  value: boolean
  source: DonateSource
}

/** Tool description text that states how the donation setting resolves. */
export const DONATION_SETTING_TEXT =
  `Donation setting: allowDonation in the call wins, true or false. Without it, the env var ${DONATE_ENV} ` +
  "(true or false) applies. Then 'donate = true' in $XDG_CONFIG_HOME/aupm/config.toml applies. " +
  'If none is set, donation is off. A malformed env var or config file makes the call fail with an error. ' +
  `The donation per reviewed package is the multiplier times $0.01 ('multiplier = "<x>"' in the same file, ` +
  `or env var ${MULTIPLIER_ENV}). The default is x1 ($0.01). The minimum is x0.1 ($0.001) ` +
  'and the maximum is x100 ($1.00). Without a multiplier, the donation is x1.'

/** Thrown for a malformed env value or config file. The message says how to fix it. */
export class ConfigError extends Error {}

const FILE_HEADER =
  '# AuPM CLI settings. Edit with: aupm config set donate <true|false>, aupm config set multiplier <x>\n'
const ACCEPTED_LINE = 'donate = true  or  donate = false  or  multiplier = "<x0.1 to x100>"'
const DONATE_LINE = /^donate\s*=\s*(true|false)\s*(#.*)?$/
const MULTIPLIER_LINE = /^multiplier\s*=\s*"([^"]*)"\s*(#.*)?$/

/** The donor multiplier is a whole number of tenths: 1 is x0.1 and 1000 is x100. */
export const MIN_MULTIPLIER_TENTHS = 1
export const MAX_MULTIPLIER_TENTHS = 1000
export const DEFAULT_MULTIPLIER_TENTHS = 10

const MULTIPLIER_RANGE_TEXT =
  'The multiplier must be a decimal from 0.1 to 100 with at most one fraction digit, for example 0.1, 1 or 2.5.'

const MULTIPLIER_TEXT = /^(\d{1,3})(?:\.(\d))?$/

/** Parses a human decimal such as "2.5" into tenths. Uses no floats. Throws ConfigError. */
export function parseMultiplier(text: string): number {
  const match = MULTIPLIER_TEXT.exec(text.trim())
  const tenths = match ? Number(match[1]) * 10 + Number(match[2] ?? 0) : Number.NaN
  if (!(tenths >= MIN_MULTIPLIER_TENTHS && tenths <= MAX_MULTIPLIER_TENTHS)) {
    throw new ConfigError(
      `Multiplier ${JSON.stringify(text)} is not valid. ${MULTIPLIER_RANGE_TEXT}`,
    )
  }
  return tenths
}

/** Formats tenths as the human multiplier, for example 25 gives "x2.5". */
export function formatMultiplier(tenths: number): string {
  const whole = Math.floor(tenths / 10)
  const fraction = tenths % 10
  return `x${whole}${fraction === 0 ? '' : `.${fraction}`}`
}

export type MultiplierSource = 'env' | 'file' | 'default'

export interface MultiplierSetting {
  tenths: number
  source: MultiplierSource
}

/** The multiplier text for a receipt. A default value says so. */
export function describeMultiplier(setting: MultiplierSetting): string {
  const label = formatMultiplier(setting.tenths)
  return setting.source === 'default' ? `${label} (default)` : label
}

interface ConfigValues {
  donate?: boolean
  multiplier?: number
}

/** Path of the config file. Reads XDG_CONFIG_HOME at call time. */
export function configFilePath(): string {
  const configHome = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config')
  return path.join(configHome, 'aupm', 'config.toml')
}

function readConfigFile(file: string): ConfigValues {
  let text: string
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}
    throw error
  }
  const values: ConfigValues = {}
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    const donate = DONATE_LINE.exec(line)
    const multiplier = MULTIPLIER_LINE.exec(line)
    if (donate) {
      values.donate = donate[1] === 'true'
    } else if (multiplier) {
      try {
        values.multiplier = parseMultiplier(multiplier[1] ?? '')
      } catch (error) {
        throw new ConfigError(`${file}:${index + 1}: ${(error as Error).message}`)
      }
    } else {
      throw new ConfigError(
        `${file}:${index + 1}: cannot read this line: ${JSON.stringify(line)}. ` +
          `Accepted: ${ACCEPTED_LINE}, blank lines, and # comments.`,
      )
    }
  }
  return values
}

/** Reads `donate` from the config file. Returns undefined when the file or the key is absent. */
export function readConfigDonate(file: string = configFilePath()): boolean | undefined {
  return readConfigFile(file).donate
}

/** Reads `multiplier` from the config file, in tenths. Returns undefined when absent. */
export function readConfigMultiplier(file: string = configFilePath()): number | undefined {
  return readConfigFile(file).multiplier
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

function writeConfigFile(values: ConfigValues): string {
  const file = configFilePath()
  const lines = [FILE_HEADER.trimEnd()]
  if (values.donate !== undefined) lines.push(`donate = ${values.donate}`)
  if (values.multiplier !== undefined) {
    lines.push(`multiplier = "${formatMultiplier(values.multiplier).slice(1)}"`)
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${lines.join('\n')}\n`)
  return file
}

/** Writes `donate = <value>` and keeps the other settings. Returns the path. */
export function writeConfigDonate(value: boolean): string {
  return writeConfigFile({ ...readConfigFile(configFilePath()), donate: value })
}

/** Writes `multiplier = "<x>"` and keeps the other settings. Returns the path. */
export function writeConfigMultiplier(tenths: number): string {
  return writeConfigFile({ ...readConfigFile(configFilePath()), multiplier: tenths })
}

/** Resolves the multiplier: env var, then config file, then the default x1. */
export function resolveMultiplier(env: NodeJS.ProcessEnv = process.env): MultiplierSetting {
  const raw = env[MULTIPLIER_ENV]
  if (raw !== undefined && raw !== '') {
    try {
      return { tenths: parseMultiplier(raw), source: 'env' }
    } catch (error) {
      throw new ConfigError(`${MULTIPLIER_ENV}: ${(error as Error).message}`)
    }
  }
  const fromFile = readConfigMultiplier()
  if (fromFile !== undefined) return { tenths: fromFile, source: 'file' }
  return { tenths: DEFAULT_MULTIPLIER_TENTHS, source: 'default' }
}
