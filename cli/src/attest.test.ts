// cli/src/attest.test.ts
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attestLockfileTool } from '../../mcp/src/tools/attest.js'

vi.mock('../../mcp/src/tools/attest.js', () => ({
  attestLockfileTool: { handler: vi.fn() },
}))

describe('spm attest', () => {
  let lockfilePath: string
  let outDir: string

  beforeEach(() => {
    outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-attest-cli-test-'))
    lockfilePath = path.join(outDir, 'package-lock.json')
    fs.writeFileSync(lockfilePath, '{}')
    vi.mocked(attestLockfileTool.handler).mockReset()
  })

  afterEach(() => {
    fs.rmSync(outDir, { recursive: true, force: true })
  })

  it('with no lockfile argument, prints usage and exits 1', async () => {
    const { runAttest } = await import('./attest.js')
    const exitCode = await runAttest([])
    expect(exitCode).toBe(1)
    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })

  it('without --donate, a bare donation_required result (no attestation) exits 0 and writes no file', async () => {
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'donation_required',
      priceMicro: 1_000,
      resourceUrl: 'http://localhost:4873/v1/attest/lockfile',
      asset: '31566704',
    })

    const { runAttest } = await import('./attest.js')
    const outPath = path.join(outDir, 'spm-attestation.json')
    const exitCode = await runAttest([lockfilePath, '--out', outPath])

    expect(exitCode).toBe(0)
    expect(attestLockfileTool.handler).toHaveBeenCalledWith({ lockfilePath, allowDonation: false })
    expect(fs.existsSync(outPath)).toBe(false)
  })

  it('without --donate, a partial donation_required result writes the attestation, prints the withheld count, and exits 0', async () => {
    const attestation = {
      payloadType: 'application/vnd.in-toto+json',
      payload: 'xyz',
      signatures: [],
    }
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'donation_required',
      priceMicro: 2_000,
      resourceUrl: 'http://localhost:4873/v1/attest/lockfile',
      asset: '31566704',
      withheld: 2,
      summary: { total: 2, reviewed: 2, unreviewed: 0, unresolvable: 0, integrityMismatch: 0 },
      attestation,
    })
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    const { runAttest } = await import('./attest.js')
    const outPath = path.join(outDir, 'spm-attestation.json')
    const exitCode = await runAttest([lockfilePath, '--out', outPath])

    expect(exitCode).toBe(0)
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8'))).toEqual(attestation)
    const printed = logSpy.mock.calls.map((call) => String(call[0])).join('\n')
    expect(printed).toContain('withheld 2 reviewed entries')
    logSpy.mockRestore()
  })

  it('with --donate, writes the attestation envelope to --out and exits 0', async () => {
    const attestation = {
      payloadType: 'application/vnd.in-toto+json',
      payload: 'xyz',
      signatures: [],
    }
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'attested',
      summary: { reviewed: 1 },
      attestation,
    })

    const { runAttest } = await import('./attest.js')
    const outPath = path.join(outDir, 'out.json')
    const exitCode = await runAttest([lockfilePath, '--donate', '--out', outPath])

    expect(exitCode).toBe(0)
    expect(attestLockfileTool.handler).toHaveBeenCalledWith({ lockfilePath, allowDonation: true })
    expect(JSON.parse(fs.readFileSync(outPath, 'utf8'))).toEqual(attestation)
  })

  it('writes to the default spm-attestation.json path when --out is omitted', async () => {
    const attestation = {
      payloadType: 'application/vnd.in-toto+json',
      payload: 'xyz',
      signatures: [],
    }
    vi.mocked(attestLockfileTool.handler).mockResolvedValue({
      status: 'attested',
      summary: { reviewed: 1 },
      attestation,
    })

    const cwd = process.cwd()
    process.chdir(outDir)
    try {
      const { runAttest } = await import('./attest.js')
      const exitCode = await runAttest([lockfilePath])
      expect(exitCode).toBe(0)
      expect(fs.existsSync(path.join(outDir, 'spm-attestation.json'))).toBe(true)
    } finally {
      process.chdir(cwd)
    }
  })

  it('a trailing --out with no value is a usage error, exit 1', async () => {
    const { runAttest } = await import('./attest.js')
    const exitCode = await runAttest([lockfilePath, '--out'])
    expect(exitCode).toBe(1)
    expect(attestLockfileTool.handler).not.toHaveBeenCalled()
  })
})
