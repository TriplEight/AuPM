// proxy/src/index.test.ts
//
// Exercises proxy/src/index.ts as a real subprocess (tsx), not an import.
// index.ts calls process.exit() on a failed boot and binds a real TCP
// port on a successful one, neither of which is safe to run in-process
// inside the vitest worker.

import { spawn } from 'node:child_process'
import net from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, test } from 'vitest'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROXY_ROOT = path.resolve(__dirname, '..')
const INDEX_ENTRY = path.join(__dirname, 'index.ts')

const SUBPROCESS_TIMEOUT_MS = 10_000

type RunResult = {
  code: number | null
  stdout: string
  stderr: string
}

// Runs `tsx proxy/src/index.ts` with the given env, killing it after
// `timeoutMs` if it has not exited on its own. CAUTION: a hanging child
// process is a failing test, not a slow one — always bound and always kill.
function runIndex(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn('pnpm', ['exec', 'tsx', INDEX_ENTRY], {
      cwd: PROXY_ROOT,
      env: { ...process.env, ...env },
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      child.kill('SIGKILL')
      reject(new Error(`subprocess outlived ${timeoutMs}ms timeout; stderr=${stderr}`))
    }, timeoutMs)

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
    })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    child.on('exit', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ code, stdout, stderr })
    })

    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
  })
}

// True when a TCP connection to 127.0.0.1:port succeeds within timeoutMs.
function isPortListening(port: number, timeoutMs = 500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host: '127.0.0.1' })
    const finish = (result: boolean) => {
      socket.destroy()
      resolve(result)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

describe('index.ts startup guard (subprocess)', () => {
  test(
    'refuses to boot and never opens the port when the facilitator is unreachable',
    async () => {
      const DEAD_FACILITATOR = 'http://127.0.0.1:9'
      const PORT = 39871

      const result = await runIndex(
        {
          FACILITATOR_URL: DEAD_FACILITATOR,
          PORT: String(PORT),
          NETWORK: 'mainnet',
          SPLIT_APP_ADDRESS: 'FAKEADDRESSAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        },
        SUBPROCESS_TIMEOUT_MS,
      )

      expect(result.code).not.toBe(0)
      expect(result.code).not.toBeNull()
      expect(result.stderr).toMatch(/127\.0\.0\.1:9/)

      const listening = await isPortListening(PORT)
      expect(listening).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS + 5_000,
  )
})
