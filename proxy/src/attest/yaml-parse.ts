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
  /** A server fault: no worker, a missing module, or a worker that died. Not the caller's fault. */
  | { kind: 'error'; code: string; message: string }

export interface YamlParseOptions {
  timeoutMs?: number
  /** Test seam: a worker script other than the real parser. */
  workerUrl?: URL
}

export type YamlParser = (text: string, options?: YamlParseOptions) => Promise<YamlParseOutcome>

/** Logs one line with the error code and message. Never logs the request body. */
function serverFault(code: string, message: string): YamlParseOutcome {
  console.error(`[aupm] pnpm-lock.yaml parse worker failed: ${code}: ${message}`)
  return { kind: 'error', code, message }
}

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
    } catch (error) {
      parseInFlight = false
      const fault = error as NodeJS.ErrnoException
      resolve(serverFault(fault.code ?? fault.name, fault.message))
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
      if (settled) return
      settle(
        error.code === 'ERR_WORKER_OUT_OF_MEMORY'
          ? { kind: 'too_complex' }
          : serverFault(error.code ?? error.name, error.message),
      )
    })
    worker.once('exit', (exitCode) => {
      // Fires after every settle, because settle() terminates the worker.
      if (settled) return
      settle(serverFault('WORKER_EXIT', `worker exited with code ${exitCode} before a result`))
    })
  })
}
