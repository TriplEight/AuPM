// proxy/src/build-info.test.ts
import { describe, expect, test } from 'vitest'
import { resolveBuildInfo } from './build-info.js'

const SHA = '0123456789abcdef0123456789abcdef01234567'

function run(env: Record<string, string | undefined>) {
  const warnings: string[] = []
  return { info: resolveBuildInfo(env, (m) => warnings.push(m)), warnings }
}

describe('resolveBuildInfo', () => {
  test('accepts a release tag and a 40-hex SHA', () => {
    const { info, warnings } = run({ AUPM_VERSION: 'v0.2.10', AUPM_COMMIT: SHA })
    expect(info).toEqual({ version: 'v0.2.10', commit: SHA })
    expect(warnings).toEqual([])
  })

  test('accepts pr-N and dev versions', () => {
    expect(run({ AUPM_VERSION: 'pr-82' }).info.version).toBe('pr-82')
    expect(run({ AUPM_VERSION: 'dev' }).info.version).toBe('dev')
  })

  test('reports dev and null, silently, when both are unset or empty', () => {
    for (const env of [{}, { AUPM_VERSION: '', AUPM_COMMIT: '' }]) {
      const { info, warnings } = run(env)
      expect(info).toEqual({ version: 'dev', commit: null })
      expect(warnings).toEqual([])
    }
  })

  test.each(['0.2.10', 'main', 'v1', 'pr-', 'v1.2.3\nx', '<script>'])(
    'falls back to dev with one log line for version %j',
    (bad) => {
      const { info, warnings } = run({ AUPM_VERSION: bad, AUPM_COMMIT: SHA })
      expect(info).toEqual({ version: 'dev', commit: SHA })
      expect(warnings).toHaveLength(1)
    },
  )

  test.each(['abc123', SHA.toUpperCase(), `${SHA}0`, 'g'.repeat(40)])(
    'falls back to null with one log line for commit %j',
    (bad) => {
      const { info, warnings } = run({ AUPM_VERSION: 'v1.0.0', AUPM_COMMIT: bad })
      expect(info).toEqual({ version: 'v1.0.0', commit: null })
      expect(warnings).toHaveLength(1)
    },
  )
})
