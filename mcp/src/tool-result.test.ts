import { describe, expect, it } from 'vitest'
import { ConfigError } from './config.js'
import { toToolResult } from './tool-result.js'

describe('toToolResult', () => {
  it('wraps a value as JSON text', async () => {
    expect(await toToolResult(async () => ({ a: 1 }))).toEqual({
      content: [{ type: 'text', text: '{\n  "a": 1\n}' }],
    })
  })

  it('returns a ConfigError as an error result', async () => {
    const result = await toToolResult(async () => {
      throw new ConfigError('AUPM_DONATE is "yes". Accepted values: true or false.')
    })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('AUPM_DONATE')
  })

  it('rethrows any other error', async () => {
    await expect(
      toToolResult(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
  })
})
