// proxy/src/index.test.ts
//
// Exercises proxy/src/index.ts as a real subprocess (tsx), not an import.
// index.ts calls process.exit() on a failed boot and binds a real TCP
// port on a successful one, neither of which is safe to run in-process
// inside the vitest worker.

import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import algosdk from 'algosdk'
import { describe, expect, test } from 'vitest'
import { CAIP2_NETWORK } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const PROXY_ROOT = path.resolve(__dirname, '..')
const INDEX_ENTRY = path.join(__dirname, 'index.ts')

const SUBPROCESS_TIMEOUT_MS = 10_000

// A real, checksum-valid Algorand address, generated fresh (never funded,
// never used on-chain) — used wherever a test needs SPLIT_APP_ADDRESS to
// pass shape validation so it can exercise a *different* boot-guard step
// (e.g. facilitator reachability) without PAY_TO validation short-circuiting
// it first.
const VALID_APP_ADDRESS = algosdk.generateAccount().addr.toString()

// 58 characters of base32, but not a real address — decodes to the wrong
// checksum. Distinct from VALID_APP_ADDRESS only in its last character.
const MALFORMED_APP_ADDRESS = `${VALID_APP_ADDRESS.slice(0, 57)}${VALID_APP_ADDRESS.at(-1) === 'A' ? 'B' : 'A'}`

type RunResult = {
  code: number | null
  stdout: string
  stderr: string
}

// Runs `tsx proxy/src/index.ts` with the given env, killing it after
// `timeoutMs` if it has not exited on its own. CAUTION: a hanging child
// process is a failing test, not a slow one — always bound and always kill.
//
// CAUTION: the subprocess's index.ts statically imports app.js, which
// reaches db.ts before boot() ever runs (and regardless of whether boot
// fails) — so this child process gets its own SQLITE_PATH here, the same
// trick as proxy/src/claims/ledger.test.ts, rather than opening the real
// proxy/audit.db. Every call gets a fresh path unless the caller's `env`
// overrides it.
function runIndex(env: NodeJS.ProcessEnv, timeoutMs: number): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const sqlitePath = path.join(os.tmpdir(), `spm-index-test-${randomUUID()}.db`)
    const child = spawn('pnpm', ['exec', 'tsx', INDEX_ENTRY], {
      cwd: PROXY_ROOT,
      env: { ...process.env, SQLITE_PATH: sqlitePath, ...env },
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

// Polls isPortListening() until it succeeds or deadlineMs elapses.
async function waitForPortListening(port: number, deadlineMs: number): Promise<boolean> {
  const start = Date.now()
  while (Date.now() - start < deadlineMs) {
    if (await isPortListening(port)) return true
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return false
}

// A local stand-in for the GoPlausible facilitator's GET /supported — no
// network dependency, deterministic, matches the shape resolveFeePayer()
// (proxy/src/config.ts) reads: one "exact" kind on the configured network
// carrying extra.feePayer. Used only to get a real subprocess past the
// facilitator boot guard so the PAY_TO guard test below can prove the port
// actually opens; the fee payer's authenticity is not this file's concern
// (that is proxy/src/x402/server.test.ts).
function startStubFacilitator(feePayer: string): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/supported') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            kinds: [
              { x402Version: 2, scheme: 'exact', network: CAIP2_NETWORK, extra: { feePayer } },
            ],
            extensions: [],
            signers: {},
          }),
        )
        return
      }
      res.writeHead(404)
      res.end()
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolve({ url: `http://127.0.0.1:${port}`, close: () => server.close() })
    })
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
          // Must be a *valid* address here — this test proves the
          // facilitator-reachability guard fires, not the PAY_TO guard.
          SPLIT_APP_ADDRESS: VALID_APP_ADDRESS,
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

describe('index.ts PAY_TO guard (subprocess)', () => {
  // WARNING: G5 — a misconfigured PAY_TO must never let the port bind. A
  // server advertising an empty or malformed payTo answers 402s no caller
  // can pay against, and payTo is the leaderboard key (CLAUDE.md invariant
  // 1). None of these three cases may reach the facilitator or the port.
  const DEAD_FACILITATOR = 'http://127.0.0.1:9'

  test(
    'refuses to boot and never opens the port when SPLIT_APP_ADDRESS is unset',
    async () => {
      const PORT = 39872
      // No SPLIT_APP_ADDRESS key at all — runIndex() spreads this over
      // process.env, so the subprocess only sees it unset if it is also
      // unset in this test runner's own environment, which CI and local
      // dev both guarantee (nothing in this repo sets it globally).
      const result = await runIndex(
        {
          FACILITATOR_URL: DEAD_FACILITATOR,
          PORT: String(PORT),
          NETWORK: 'mainnet',
        },
        SUBPROCESS_TIMEOUT_MS,
      )

      expect(result.code).not.toBe(0)
      expect(result.code).not.toBeNull()
      expect(result.stderr).toMatch(/PAY_TO/)
      // Proves the PAY_TO guard fired first: it never reached the (dead)
      // facilitator, so the facilitator's address is absent from stderr.
      expect(result.stderr).not.toMatch(/127\.0\.0\.1:9/)

      const listening = await isPortListening(PORT)
      expect(listening).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS + 5_000,
  )

  test(
    'refuses to boot and never opens the port when SPLIT_APP_ADDRESS is malformed',
    async () => {
      const PORT = 39873

      const result = await runIndex(
        {
          FACILITATOR_URL: DEAD_FACILITATOR,
          PORT: String(PORT),
          NETWORK: 'mainnet',
          SPLIT_APP_ADDRESS: MALFORMED_APP_ADDRESS,
        },
        SUBPROCESS_TIMEOUT_MS,
      )

      expect(result.code).not.toBe(0)
      expect(result.code).not.toBeNull()
      expect(result.stderr).toMatch(/PAY_TO/)
      expect(result.stderr).not.toMatch(/127\.0\.0\.1:9/)

      const listening = await isPortListening(PORT)
      expect(listening).toBe(false)
    },
    SUBPROCESS_TIMEOUT_MS + 5_000,
  )

  test(
    'boots normally when SPLIT_APP_ADDRESS is a valid address',
    async () => {
      const PORT = 39874

      // Past the PAY_TO guard, boot() still needs a reachable facilitator
      // (proxy/src/x402/server.ts). A local stub keeps this test free of a
      // real network dependency, deterministic, and focused on the PAY_TO
      // guard specifically — the facilitator contract itself is covered by
      // proxy/src/x402/server.test.ts.
      const feePayer = algosdk.generateAccount().addr.toString()
      const facilitator = await startStubFacilitator(feePayer)

      const sqlitePath = path.join(os.tmpdir(), `spm-index-test-${randomUUID()}.db`)
      const child = spawn('pnpm', ['exec', 'tsx', INDEX_ENTRY], {
        cwd: PROXY_ROOT,
        env: {
          ...process.env,
          SQLITE_PATH: sqlitePath,
          PORT: String(PORT),
          NETWORK: 'mainnet',
          FACILITATOR_URL: facilitator.url,
          SPLIT_APP_ADDRESS: VALID_APP_ADDRESS,
        },
      })

      let stderr = ''
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString()
      })

      try {
        const listening = await waitForPortListening(PORT, SUBPROCESS_TIMEOUT_MS)
        expect(listening).toBe(true)
      } finally {
        child.kill('SIGKILL')
        facilitator.close()
      }
      // A boot failure would have exited before the port ever opened, so
      // reaching a successful isPortListening() already proves this; the
      // stderr check below guards against a false positive from some other
      // process already holding the port.
      expect(stderr).not.toMatch(/PAY_TO/)
    },
    SUBPROCESS_TIMEOUT_MS + 5_000,
  )
})
