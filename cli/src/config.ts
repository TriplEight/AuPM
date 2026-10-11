// cli/src/config.ts
import {
  ConfigError,
  configFilePath,
  DONATE_ENV,
  type DonateSource,
  resolveDonate,
  writeConfigDonate,
} from 'aupm-mcp/config'

const CONFIG_USAGE = 'Usage: aupm config set donate <true|false>  |  aupm config get donate'

/** Runs `aupm config set|get donate`. Returns the process exit code. */
export function runConfig(argv: string[]): number {
  const [action, key, value] = argv
  if (key !== 'donate' || (action !== 'get' && action !== 'set')) {
    console.log('aupm config manages AuPM settings only. For npm settings, run npm config.')
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
