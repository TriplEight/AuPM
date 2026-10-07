// cli/src/yarn-attest.test.ts
//
// Runs through the real attest_lockfile handler: only the child process and the network
// are faked. Proves the wrapper attests the exact bytes it sent.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))

const SENT = '# yarn lockfile v1\n\nms@^2.1.3:\n  version "2.1.3"\n  integrity sha512-ms\n'
const CHANGED = `${SENT}\nleft-pad@^1.0.0:\n  version "1.3.0"\n`

function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex')
}

describe('aupm yarn attests the bytes it sends', () => {
  let cwd: string
  let originalCwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-yarn-attest-test-'))
    originalCwd = process.cwd()
    process.chdir(cwd)
    vi.stubEnv('XDG_CONFIG_HOME', path.join(cwd, 'xdg'))
    vi.stubEnv('AUPM_DONATE', '')
    vi.stubEnv('AUPM_PROXY_URL', 'http://localhost:4873')
    vi.mocked(spawn).mockImplementation(((_cmd: string, args: string[]) => {
      const child = new EventEmitter() as EventEmitter & { stdout: EventEmitter }
      child.stdout = new EventEmitter()
      queueMicrotask(() => {
        if (args.includes('--version')) {
          child.stdout.emit('data', Buffer.from('1.22.22\n'))
          child.emit('close', 0, null)
        } else {
          child.emit('exit', 0, null)
        }
      })
      return child
    }) as never)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    process.chdir(originalCwd)
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('sends text/plain with yarn.lock read once; a later change does not alter the digest', async () => {
    const lockPath = path.join(cwd, 'yarn.lock')
    fs.writeFileSync(lockPath, SENT)
    let sentDigest = ''
    let contentType: string | null = null
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(String(input), init)
        contentType = request.headers.get('content-type')
        sentDigest = sha256(new Uint8Array(await request.arrayBuffer()))
        fs.writeFileSync(lockPath, CHANGED)
        const statement = {
          subject: [{ name: 'yarn.lock', digest: { sha256: sentDigest } }],
          predicate: { withheld: 0 },
        }
        const payload = Buffer.from(JSON.stringify(statement))
        return new Response(
          JSON.stringify({
            summary: {
              total: 1,
              reviewed: 0,
              unreviewed: 1,
              unresolvable: 0,
              integrityMismatch: 0,
            },
            attestation: { payload: payload.toString('base64') },
          }),
          { status: 200 },
        )
      }),
    )
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const outPath = path.join(cwd, 'out.json')

    const { runWrapper } = await import('./npm-wrapper.js')
    expect(await runWrapper('yarn', ['install', '--attest-out', outPath])).toBe(0)

    expect(contentType).toBe('text/plain')
    expect(sentDigest).toBe(sha256(SENT))
    expect(sha256(fs.readFileSync(lockPath))).toBe(sha256(CHANGED))
    const written = JSON.parse(fs.readFileSync(outPath, 'utf8')) as { payload: string }
    const statement = JSON.parse(Buffer.from(written.payload, 'base64').toString('utf8'))
    expect(statement.subject[0].digest.sha256).toBe(sha256(SENT))
    expect(statement.subject[0].digest.sha256).not.toBe(sha256(CHANGED))
  })
})
