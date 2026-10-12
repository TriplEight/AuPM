// mcp/src/tools/install-pay-failure.test.ts
//
// A payment failure on a tarball install returns the free tarball plus a donationFailure
// reason. fetch is mocked at the boundary. The free request never carries a payment header.
import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import {
  ALGORAND_MAINNET_CAIP2,
  ALGORAND_TESTNET_CAIP2,
  USDC_MAINNET_ASA_ID,
  USDC_TESTNET_ASA_ID,
} from '@x402-avm/avm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'
const PAY_TO = 'J6DSQYYXYO53B7PC6MZ5M2OO7V3RM4MIWTV7KCH5IQBUXF7KMGPVFWIRAM'
const FEE_PAYER = 'EA4DXI4WJWSSJQAAKG5ZFNVA6U26NT7DBWHUKP5C3HSVKBAQ3KGPKVEN5A'
const ORIGIN = 'https://aupm.example'
const TARBALL_BYTES = 'free tarball bytes'

type ServerNet = 'mainnet' | 'testnet'

function paymentRequiredHeader(net: ServerNet, error?: string): string {
  const asset = net === 'mainnet' ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID
  const body = {
    x402Version: 2,
    error,
    resource: { url: `${ORIGIN}/ms/-/ms-2.1.3.tgz` },
    accepts: [
      {
        scheme: 'exact',
        network: net === 'mainnet' ? ALGORAND_MAINNET_CAIP2 : ALGORAND_TESTNET_CAIP2,
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
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

type Seen = { donateHeader: string | null; signed: boolean }
type PaidAnswer = () => Response

/** The free answer to a request with X-AuPM-Donate: 0. */
type FreeAnswer = () => Response

const freeTarball: FreeAnswer = () => new Response(TARBALL_BYTES, { status: 200 })

function serverMock(net: ServerNet, paid: PaidAnswer, free: FreeAnswer = freeTarball) {
  const seen: Seen[] = []
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (request.url.includes('/v2/transactions/params')) return algodParams()
    const signed = request.headers.has('PAYMENT-SIGNATURE')
    const donateHeader = request.headers.get('X-AuPM-Donate')
    seen.push({ donateHeader, signed })
    if (signed) return paid()
    if (donateHeader === '0') return free()
    return new Response(null, {
      status: 402,
      headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader(net) },
    })
  })
  return { mock, seen }
}

const never: PaidAnswer = () => {
  throw new Error('must never pay')
}

describe('install_audited_package payment failure', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-install-pay-failure-'))
    vi.stubEnv('XDG_CONFIG_HOME', dir)
    vi.stubEnv('AUPM_DONATE', '')
    vi.stubEnv('AUPM_PROXY_URL', ORIGIN)
    vi.stubEnv('AUPM_DONOR_MNEMONIC', TEST_MNEMONIC)
    vi.stubEnv('NETWORK', '')
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  async function run(
    clientNet: ServerNet,
    net: ServerNet,
    paid: PaidAnswer,
    free: FreeAnswer = freeTarball,
  ) {
    vi.stubEnv('NETWORK', clientNet)
    vi.resetModules()
    const { installTool } = await import('./install.js')
    const server = serverMock(net, paid, free)
    vi.stubGlobal('fetch', server.mock)
    const result = await installTool.handler({ pkg: 'ms', version: '2.1.3', allowDonation: true })
    return { result, ...server }
  }

  function expectFreeTarball(result: Awaited<ReturnType<typeof run>>['result']) {
    expect(result.status).toBe('free')
    if (result.status !== 'free') throw new Error('unreachable')
    expect(result.txid).toBeNull()
    expect(result.loraUrl).toBeNull()
    expect(fs.readFileSync(result.tarballPath, 'utf8')).toBe(TARBALL_BYTES)
  }

  function expectOneFreeRequestNoPayment(seen: Seen[], signedCount: number) {
    const free = seen.filter((request) => request.donateHeader === '0')
    expect(free.length).toBe(1)
    expect(free.every((request) => !request.signed)).toBe(true)
    expect(seen.filter((request) => request.signed).length).toBe(signedCount)
  }

  it('MainNet server and TestNet client: names both networks and the fix, signs nothing', async () => {
    const { result, seen, mock } = await run('testnet', 'mainnet', never)

    expectFreeTarball(result)
    expect(result.status === 'free' && result.donationFailure?.code).toBe('network_mismatch')
    expect(result.status === 'free' && result.donationFailure?.reason).toBe(
      `No donation was paid: the server ${ORIGIN} takes payment on MainNet, but this client uses ` +
        'TestNet. AuPM signed nothing. Fix: set AUPM_PROXY_URL to a TestNet server, ' +
        'or set NETWORK=mainnet.',
    )
    expect(mock.mock.calls.some(([input]) => String(input).includes('transactions/params'))).toBe(
      false,
    )
    expectOneFreeRequestNoPayment(seen, 0)
  })

  it('no donor key: free tarball, a reason that names the fix, nothing signed', async () => {
    vi.stubEnv('AUPM_DONOR_MNEMONIC', '')
    const { result, seen } = await run('mainnet', 'mainnet', never)

    expectFreeTarball(result)
    const failure = result.status === 'free' ? result.donationFailure : undefined
    expect(failure?.code).toBe('no_donor_key')
    expect(failure?.reason).toMatch(/no donor key found.*aupm donor init/)
    expect(failure?.reason).not.toMatch(/Try again later/)
    expectOneFreeRequestNoPayment(seen, 0)
  })

  it('too little USDC: free tarball, one paid attempt, no retry text', async () => {
    const { result, seen } = await run(
      'mainnet',
      'mainnet',
      () =>
        new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader('mainnet', 'insufficient_funds') },
        }),
    )

    expectFreeTarball(result)
    const failure = result.status === 'free' ? result.donationFailure : undefined
    expect(failure?.code).toBe('insufficient_usdc')
    expect(failure?.reason).toMatch(/too little USDC/)
    expect(failure?.reason).not.toMatch(/Try again later/)
    expectOneFreeRequestNoPayment(seen, 1)
  })

  it('facilitator 5xx: free tarball, one paid attempt, says try again later', async () => {
    const { result, seen } = await run(
      'mainnet',
      'mainnet',
      () => new Response('bad gateway', { status: 502 }),
    )

    expectFreeTarball(result)
    const failure = result.status === 'free' ? result.donationFailure : undefined
    expect(failure?.code).toBe('facilitator_error')
    expect(failure?.reason).toMatch(/answered 502.*Try again later\./)
    expectOneFreeRequestNoPayment(seen, 1)
  })

  it('a 404 on the paid attempt still throws a clear error and pays nothing', async () => {
    vi.stubEnv('NETWORK', 'mainnet')
    vi.resetModules()
    const { installTool } = await import('./install.js')
    const server = serverMock('mainnet', never)
    const notFound = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init)
      server.seen.push({
        donateHeader: request.headers.get('X-AuPM-Donate'),
        signed: request.headers.has('PAYMENT-SIGNATURE'),
      })
      return new Response('not found', { status: 404 })
    })
    vi.stubGlobal('fetch', notFound)

    await expect(
      installTool.handler({ pkg: 'ms', version: '9.9.9', allowDonation: true }),
    ).rejects.toThrow('Install failed: 404')
    expect(server.seen.filter((request) => request.signed).length).toBe(0)
    expect(notFound).toHaveBeenCalledTimes(1)
  })

  it('a 404 on the free request after a payment failure throws and pays nothing', async () => {
    vi.stubEnv('AUPM_DONOR_MNEMONIC', '')
    await expect(
      run('mainnet', 'mainnet', never, () => new Response('gone', { status: 404 })),
    ).rejects.toThrow('Install failed: 404')
  })

  it('without allowDonation, a result has no donationFailure and never pays', async () => {
    vi.resetModules()
    const { installTool } = await import('./install.js')
    const server = serverMock('testnet', never)
    vi.stubGlobal('fetch', server.mock)

    const result = await installTool.handler({ pkg: 'ms', version: '2.1.3', allowDonation: false })

    expect(result.status).toBe('free')
    expect('donationFailure' in result).toBe(false)
    expect(server.seen).toHaveLength(1)
    expect(server.seen[0]?.signed).toBe(false)
  })
})
