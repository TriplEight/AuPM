// cli/src/config.ts
import {
  ConfigError,
  configFilePath,
  DONATE_ENV,
  type DonateSource,
  describeMultiplier,
  MULTIPLIER_ENV,
  type MultiplierSource,
  parseMultiplier,
  resolveDonate,
  resolveMultiplier,
  writeConfigDonate,
  writeConfigMultiplier,
} from 'aupm-mcp/config'

const CONFIG_USAGE =
  'Usage: aupm config set donate <true|false>  |  aupm config get donate\n' +
  '       aupm config set multiplier <x>  |  aupm config get multiplier\n' +
  'The multiplier is a decimal from 0.1 to 100. Default $0.01 (x1), minimum $0.001 (x0.1), maximum x100.'

/** Runs `aupm config set|get donate|multiplier`. Returns the process exit code. */
export function runConfig(argv: string[]): number {
  const [action, key, value] = argv
  if ((key !== 'donate' && key !== 'multiplier') || (action !== 'get' && action !== 'set')) {
    console.log('aupm config manages AuPM settings only. For npm settings, run npm config.')
    console.log(CONFIG_USAGE)
    return 1
  }
  try {
    if (action === 'get') {
      console.log(key === 'donate' ? donateSettingLine() : multiplierSettingLine())
      return 0
    }
    return key === 'donate' ? setDonate(value) : setMultiplier(value)
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message)
      return 1
    }
    throw error
  }
}

function setDonate(value: string | undefined): number {
  if (value !== 'true' && value !== 'false') {
    console.log(`aupm config set donate: the value must be true or false, not ${value}.`)
    console.log(CONFIG_USAGE)
    return 1
  }
  console.log(`donate = ${value} written to ${writeConfigDonate(value === 'true')}`)
  return 0
}

function setMultiplier(value: string | undefined): number {
  const tenths = parseMultiplier(value ?? '')
  const file = writeConfigMultiplier(tenths)
  console.log(`multiplier = ${describeMultiplier({ tenths, source: 'file' })} written to ${file}`)
  return 0
}

function describeSource(source: DonateSource): string {
  if (source === 'env') return `env ${DONATE_ENV}`
  if (source === 'file') return `file ${configFilePath()}`
  return source
}

/** `donate = true (source: file <path>)`. Throws ConfigError when the setting is malformed. */
export function donateSettingLine(): string {
  const setting = resolveDonate(undefined)
  return `donate = ${setting.value} (source: ${describeSource(setting.source)})`
}

function describeMultiplierSource(source: Exclude<MultiplierSource, 'default'>): string {
  return source === 'env' ? `env ${MULTIPLIER_ENV}` : `file ${configFilePath()}`
}

/** `multiplier = x1 (source: file <path>)`. Throws ConfigError when the setting is malformed. */
export function multiplierSettingLine(): string {
  const setting = resolveMultiplier()
  const label = describeMultiplier(setting)
  if (setting.source === 'default') return `multiplier = ${label}`
  return `multiplier = ${label} (source: ${describeMultiplierSource(setting.source)})`
}
