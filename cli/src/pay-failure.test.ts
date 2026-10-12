// cli/src/pay-failure.test.ts
//
// A payment failure after `aupm install` prints the free summary, then one reason line. The
// install exit code stays unchanged. fetch is mocked at the boundary; the real attest tool runs.

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('node:child_process', () => ({ spawn: vi.fn() }))
vi.mock('./npm-prefix.js', () => ({ runNpmPrefix: async () => process.cwd() }))

const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'
const PAY_TO = 'J6DSQYYXYO53B7PC6MZ5M2OO7V3RM4MIWTV7KCH5IQBUXF7KMGPVFWIRAM'
const FEE_PAYER = 'EA4DXI4WJWSSJQAAKG5ZFNVA6U26NT7DBWHUKP5C3HSVKBAQ3KGPKVEN5A'
const ORIGIN = 'https://aupm.example'
const MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
const TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
const USDC_MAINNET_ASA_ID = '31566704'
const USDC_TESTNET_ASA_ID = '10458941'

function paymentRequiredHeader(net: 'mainnet' | 'testnet'): string {
  const asset = net === 'mainnet' ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID
  const body = {
    x402Version: 2,
    resource: { url: `${ORIGIN}/v1/attest/lockfile` },
    accepts: [
      {
        scheme: 'exact',
        network: net === 'mainnet' ? MAINNET_CAIP2 : TESTNET_CAIP2,
        asset,
        amount: '1000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: { asset, feePayer: FEE_PAYER, tag: 'x402-global-challenge' },
      },
    ],
  }
  return Buffer.from(JSON.stringify(body)).toString('base64')
}

function partialAttestation(): { payloadType: string; payload: string } {
  const statement = { _type: 'https://in-toto.io/Statement/v1', predicate: { withheld: 1 } }
  return {
    payloadType: 'application/vnd.in-toto+json',
    payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  }
}

function algodParams(): Response {
  return new Response(
    JSON.stringify({
      'consensus-version': 'https://github.com/algorandfoundation/specs/tree/abc123',
      fee: 0,
      'genesis-hash': Buffer.alloc(32, 0x12).toString('base64'),
      'genesis-id': 'mainnet-v1.0',
      'last-round': 1000,
      'min-fee': 1000,
    }),
    { status: 200 },
  )
}

type Seen = { donateHeader: string | null; signed: boolean }

function serverMock(net: 'mainnet' | 'testnet', paid: () => Response) {
  const seen: Seen[] = []
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (request.url.includes('/v2/transactions/params')) return algodParams()
    const signed = request.headers.has('PAYMENT-SIGNATURE')
    const donateHeader = request.headers.get('X-AuPM-Donate')
    seen.push({ donateHeader, signed })
    if (signed) return paid()
    if (donateHeader === '0') {
      const summary = {
        total: 1,
        reviewed: 1,
        unreviewed: 0,
        unresolvable: 0,
        integrityMismatch: 0,
      }
      return new Response(JSON.stringify({ summary, attestation: partialAttestation() }), {
        status: 200,
      })
    }
    return new Response(null, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader(net) },
    })
  })
  return { mock, seen }
}

const FREE_SUMMARY = 'aupm: Reviewed: 1. Not reviewed: 0. Integrity mismatch: 0. Unresolvable: 0.'

describe('aupm install with a payment failure', () => {
  let dir: string
  let cwdSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-cli-pay-failure-'))
    fs.writeFileSync(
      path.join(dir, 'package-lock.json'),
      JSON.stringify({
        lockfileVersion: 3,
        packages: { 'node_modules/ms': { version: '2.1.3' } },
      }),
    )
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir)
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('AUPM_DONATE', '')
    vi.stubEnv('AUPM_PROXY_URL', ORIGIN)
    vi.stubEnv('AUPM_DONOR_MNEMONIC', TEST_MNEMONIC)
    vi.stubEnv('NETWORK', '')
    vi.mocked(spawn).mockReset()
    vi.resetModules()
  })

  afterEach(() => {
    cwdSpy.mockRestore()
    logSpy.mockRestore()
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function install(args: string[]): Promise<number> {
    const child = new EventEmitter()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')
    const exit = runWrapper('npm', ['install', 'ms@2.1.3', ...args])
    child.emit('exit', 0, null)
    return exit
  }

  function lines(): string[] {
    return logSpy.mock.calls
      .map((call: unknown[]) => String(call[0]))
      .filter((line: string) => line.startsWith('aupm: '))
  }

  function expectFreeSummaryThenOneReason(seen: Seen[], reasonPattern: RegExp) {
    const printed = lines()
    expect(printed[0]).toBe(FREE_SUMMARY)
    expect(printed.at(-1)).toMatch(reasonPattern)
    expect(printed.filter((line) => line.includes('No donation was paid'))).toHaveLength(1)
    expect(printed).toHaveLength(2)
    expect(printed.join('\n')).not.toMatch(/You can donate|all reviewed packages in the lockfile/)
    expect(printed.join('\n')).not.toMatch(/AuPM could not get the review summary/)
    const free = seen.filter((request) => request.donateHeader === '0')
    expect(free).toHaveLength(1)
    expect(free[0]?.signed).toBe(false)
    expect(seen.filter((request) => request.signed).length).toBeLessThanOrEqual(1)
  }

  it('network mismatch (MainNet server, TestNet client): names both and the fix', async () => {
    vi.stubEnv('NETWORK', 'testnet')
    const server = serverMock('mainnet', () => {
      throw new Error('must never pay')
    })
    vi.stubGlobal('fetch', server.mock)

    const exit = await install(['--donate'])

    expect(exit).toBe(0)
    expectFreeSummaryThenOneReason(server.seen, /MainNet.*TestNet.*AUPM_PROXY_URL.*NETWORK=mainnet/)
    expect(lines().at(-1)).not.toMatch(/Try again later/)
    expect(server.seen.some((request) => request.signed)).toBe(false)
  })

  it('network mismatch from the config setting (plain install): same lines, exit 0', async () => {
    const server = serverMock('testnet', () => {
      throw new Error('must never pay')
    })
    vi.stubGlobal('fetch', server.mock)
    fs.mkdirSync(path.join(dir, 'aupm'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'aupm', 'config.toml'), 'donate = true\n')

    const exit = await install([])

    expect(exit).toBe(0)
    expectFreeSummaryThenOneReason(server.seen, /TestNet.*MainNet.*NETWORK=testnet/)
  })

  it('no donor key: free summary, one reason with the fix, no retry text', async () => {
    vi.stubEnv('AUPM_DONOR_MNEMONIC', '')
    const server = serverMock('mainnet', () => {
      throw new Error('must never pay')
    })
    vi.stubGlobal('fetch', server.mock)

    const exit = await install(['--donate'])

    expect(exit).toBe(0)
    expectFreeSummaryThenOneReason(server.seen, /no donor key found.*aupm donor init/)
    expect(lines().at(-1)).not.toMatch(/Try again later/)
  })

  it('too little USDC: free summary, one reason, one paid attempt', async () => {
    const server = serverMock('mainnet', () => {
      const body = JSON.parse(
        Buffer.from(paymentRequiredHeader('mainnet'), 'base64').toString('utf8'),
      )
      body.error = 'insufficient_funds'
      const header = Buffer.from(JSON.stringify(body)).toString('base64')
      return new Response(null, { status: 402, headers: { 'PAYMENT-REQUIRED': header } })
    })
    vi.stubGlobal('fetch', server.mock)

    const exit = await install(['--donate'])

    expect(exit).toBe(0)
    expectFreeSummaryThenOneReason(server.seen, /too little USDC/)
    expect(server.seen.filter((request) => request.signed)).toHaveLength(1)
    expect(lines().at(-1)).not.toMatch(/Try again later/)
  })

  it('facilitator 5xx: free summary, one reason that says try again later', async () => {
    const server = serverMock('mainnet', () => new Response('bad gateway', { status: 502 }))
    vi.stubGlobal('fetch', server.mock)

    const exit = await install(['--donate'])

    expect(exit).toBe(0)
    expectFreeSummaryThenOneReason(server.seen, /answered 502.*Try again later\.$/)
    expect(server.seen.filter((request) => request.signed)).toHaveLength(1)
  })

  it('a non-zero install exit code is not changed', async () => {
    vi.stubEnv('NETWORK', 'testnet')
    const server = serverMock('mainnet', () => {
      throw new Error('must never pay')
    })
    vi.stubGlobal('fetch', server.mock)
    const child = new EventEmitter()
    vi.mocked(spawn).mockReturnValue(child as never)
    const { runWrapper } = await import('./npm-wrapper.js')

    const exit = runWrapper('npm', ['install', 'ms@2.1.3', '--donate'])
    child.emit('exit', 1, null)

    expect(await exit).toBe(1)
    expect(server.mock).not.toHaveBeenCalled()
  })

  it('without a donation, the offer lines still print', async () => {
    const server = serverMock('mainnet', () => {
      throw new Error('must never pay')
    })
    vi.stubGlobal('fetch', server.mock)

    const exit = await install([])

    expect(exit).toBe(0)
    expect(lines().join('\n')).toMatch(/You can donate 0\.001 USDC for 1 reviewed package/)
    expect(lines().join('\n')).toMatch(/all reviewed packages in the lockfile/)
  })
})
