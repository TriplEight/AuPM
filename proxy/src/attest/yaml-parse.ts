// proxy/src/attest/yaml-parse.ts
//
// Parses a pnpm-lock.yaml body in a worker thread, so a slow or hostile body
// never blocks the event loop of a free public route (ADR 0015). At most one
// parse runs in the process at a time. A parse that exceeds the time limit
// is terminated.

import { Worker } from 'node:worker_threads'

export const YAML_PARSE_TIMEOUT_MS = 5_000
export const YAML_PARSE_MEMORY_MB = 256

export type YamlParseOutcome =
  | { kind: 'ok'; value: unknown }
  | { kind: 'invalid' }
  /** The time limit passed, or the worker ran out of memory. */
  | { kind: 'too_complex' }
  /** Another parse is running. */
  | { kind: 'busy' }

export interface YamlParseOptions {
  timeoutMs?: number
  /** Test seam: a worker script other than the real parser. */
  workerUrl?: URL
}

export type YamlParser = (text: string, options?: YamlParseOptions) => Promise<YamlParseOutcome>

const DEFAULT_WORKER_URL = new URL('./yaml-worker.mjs', import.meta.url)

let parseInFlight = false

/**
 * Runs the YAML parse in a worker. Returns `busy` at once when another parse
 * runs. Never throws: every failure maps to an outcome.
 */
export const parseYamlInWorker: YamlParser = (text, options = {}) => {
  if (parseInFlight) return Promise.resolve({ kind: 'busy' })
  parseInFlight = true

  const timeoutMs = options.timeoutMs ?? YAML_PARSE_TIMEOUT_MS
  const workerUrl = options.workerUrl ?? DEFAULT_WORKER_URL

  return new Promise<YamlParseOutcome>((resolve) => {
    let worker: Worker
    try {
      worker = new Worker(workerUrl, {
        workerData: text,
        resourceLimits: { maxOldGenerationSizeMb: YAML_PARSE_MEMORY_MB },
      })
    } catch {
      parseInFlight = false
      resolve({ kind: 'invalid' })
      return
    }
    let settled = false
    let timer: NodeJS.Timeout | undefined
    const settle = (outcome: YamlParseOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      parseInFlight = false
      void worker.terminate()
      resolve(outcome)
    }
    timer = setTimeout(() => settle({ kind: 'too_complex' }), timeoutMs)

    worker.once('message', (message: { ok: boolean; value?: unknown }) => {
      settle(message.ok ? { kind: 'ok', value: message.value } : { kind: 'invalid' })
    })
    worker.once('error', (error: NodeJS.ErrnoException) => {
      settle({ kind: error.code === 'ERR_WORKER_OUT_OF_MEMORY' ? 'too_complex' : 'invalid' })
    })
    worker.once('exit', () => settle({ kind: 'invalid' }))
  })
}
