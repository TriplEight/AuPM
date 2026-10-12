// mcp/src/tool-result.ts
import { ConfigError } from './config.js'

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: true }

/** Runs a tool handler. A malformed donation setting becomes an error result, not a crash. */
export async function toToolResult(run: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return { content: [{ type: 'text', text: JSON.stringify(await run(), null, 2) }] }
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error
    return { isError: true, content: [{ type: 'text', text: error.message }] }
  }
}
