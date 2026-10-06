// cli/src/config.ts
//
// The "always donate" setting (SPEC.md §11.4). Precedence, highest first:
// the `--donate` or `--no-donate` flag, the env var `AUPM_DONATE`, the config file
// `$XDG_CONFIG_HOME/aupm/config.toml` (default `~/.config/aupm/config.toml`), then off.
// Only the aupm CLI reads this setting. Plain `npm install` stays free (ADR 0006).
//
// The config file is a strict subset of TOML: blank lines, `#` comments and one line
// `donate = true` or `donate = false`. Any other line is an error. No TOML library.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const DONATE_ENV = 'AUPM_DONATE'

export type DonateSource = 'flag' | 'env' | 'file' | 'default'

export interface DonateSetting {
  value: boolean
  source: DonateSource
}

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
 * Resolves the effective donate setting. A flag skips the env var and the file, so a
 * malformed value there does not block `--donate` or `--no-donate`.
 */
export function resolveDonate(
  flag: boolean | undefined,
  env: NodeJS.ProcessEnv = process.env,
): DonateSetting {
  if (flag !== undefined) return { value: flag, source: 'flag' }
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

const CONFIG_USAGE = 'Usage: aupm config set donate <true|false>  |  aupm config get donate'

/** Runs `aupm config set|get donate`. Returns the process exit code. */
export function runConfig(argv: string[]): number {
  const [action, key, value] = argv
  if (key !== 'donate' || (action !== 'get' && action !== 'set')) {
    console.log(CONFIG_USAGE)
    return 1
  }
  try {
    if (action === 'get') {
      const setting = resolveDonate(undefined)
      console.log(`donate = ${setting.value} (source: ${describeSource(setting.source)})`)
      return 0
    }
    if (value !== 'true' && value !== 'false') {
      console.log(`aupm config set donate: the value must be true or false, not ${value}.`)
      console.log(CONFIG_USAGE)
      return 1
    }
    console.log(`donate = ${value} written to ${writeConfigDonate(value === 'true')}`)
    return 0
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}

function describeSource(source: DonateSource): string {
  if (source === 'env') return `env ${DONATE_ENV}`
  if (source === 'file') return `file ${configFilePath()}`
  return source
}
