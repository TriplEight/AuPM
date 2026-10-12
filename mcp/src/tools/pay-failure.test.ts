// mcp/src/tools/pay-failure.test.ts
//
// A payment failure returns the free partial result plus a donationFailure reason.
// fetch is mocked at the boundary. The free request never carries a payment header.
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

type ServerNet = 'mainnet' | 'testnet'

function paymentRequiredHeader(net: ServerNet, error?: string): string {
  const asset = net === 'mainnet' ? USDC_MAINNET_ASA_ID : USDC_TESTNET_ASA_ID
  const body = {
    x402Version: 2,
    error,
    resource: { url: `${ORIGIN}/v1/attest/lockfile` },
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
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}

type Seen = { donateHeader: string | null; signed: boolean; url: string }

/** What the server answers to a request that carries a payment header. */
type PaidAnswer = () => Response

function serverMock(net: ServerNet, paid: PaidAnswer) {
  const seen: Seen[] = []
  const mock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init)
    if (request.url.includes('/v2/transactions/params')) return algodParams()
    const signed = request.headers.has('PAYMENT-SIGNATURE')
    const donateHeader = request.headers.get('X-AuPM-Donate')
    seen.push({ donateHeader, signed, url: request.url })
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

const OK_LOCKFILE = JSON.stringify({
  lockfileVersion: 3,
  packages: { 'node_modules/ms': { version: '2.1.3' } },
})

describe('attest_lockfile payment failure', () => {
  let dir: string
  let lockfilePath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-pay-failure-'))
    lockfilePath = path.join(dir, 'package-lock.json')
    fs.writeFileSync(lockfilePath, OK_LOCKFILE)
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

  async function run(clientNet: ServerNet, net: ServerNet, paid: PaidAnswer) {
    vi.stubEnv('NETWORK', clientNet)
    vi.resetModules()
    const { attestLockfileTool } = await import('./attest.js')
    const server = serverMock(net, paid)
    vi.stubGlobal('fetch', server.mock)
    const result = await attestLockfileTool.handler({ lockfilePath, allowDonation: true })
    return { result, ...server }
  }

  function expectFreePartial(result: Awaited<ReturnType<typeof run>>['result']) {
    expect(result.status).toBe('donation_required')
    if (result.status !== 'donation_required') throw new Error('unreachable')
    expect(result.withheld).toBe(1)
    expect(result.summary).toMatchObject({ reviewed: 1 })
  }

  function expectNoPaymentOnFreeRequest(seen: Seen[]) {
    const free = seen.filter((request) => request.donateHeader === '0')
    expect(free.length).toBe(1)
    expect(free.every((request) => !request.signed)).toBe(true)
    expect(seen.filter((request) => request.signed).length).toBeLessThanOrEqual(1)
  }

  it('MainNet server and TestNet client: names both networks and the fix, signs nothing', async () => {
    const { result, seen, mock } = await run('testnet', 'mainnet', () => {
      throw new Error('must never pay')
    })

    expectFreePartial(result)
    expect(result.donationFailure?.code).toBe('network_mismatch')
    expect(result.donationFailure?.reason).toBe(
      `No donation was paid: the server ${ORIGIN} takes payment on MainNet, but this client uses ` +
        'TestNet. AuPM signed nothing. Fix: set AUPM_PROXY_URL to a TestNet server, ' +
        'or set NETWORK=mainnet.',
    )
    expect(seen.some((request) => request.signed)).toBe(false)
    expect(mock.mock.calls.some(([input]) => String(input).includes('transactions/params'))).toBe(
      false,
    )
    expectNoPaymentOnFreeRequest(seen)
  })

  it('TestNet server and MainNet client: names both networks and the fix, signs nothing', async () => {
    const { result, seen } = await run('mainnet', 'testnet', () => {
      throw new Error('must never pay')
    })

    expectFreePartial(result)
    expect(result.donationFailure?.code).toBe('network_mismatch')
    expect(result.donationFailure?.reason).toBe(
      `No donation was paid: the server ${ORIGIN} takes payment on TestNet, but this client uses ` +
        'MainNet. AuPM signed nothing. Fix: set AUPM_PROXY_URL to a MainNet server, ' +
        'or set NETWORK=testnet.',
    )
    expectNoPaymentOnFreeRequest(seen)
    expect(seen.some((request) => request.signed)).toBe(false)
  })

  it('no donor key: free partial result, a reason that names the fix, nothing signed', async () => {
    vi.stubEnv('AUPM_DONOR_MNEMONIC', '')
    const { result, seen } = await run('mainnet', 'mainnet', () => {
      throw new Error('must never pay')
    })

    expectFreePartial(result)
    expect(result.donationFailure?.code).toBe('no_donor_key')
    expect(result.donationFailure?.reason).toMatch(/no donor key found.*aupm donor init/)
    expect(result.donationFailure?.reason).not.toMatch(/Try again later/)
    expect(seen.some((request) => request.signed)).toBe(false)
    expectNoPaymentOnFreeRequest(seen)
  })

  it('too little USDC: free partial result, one paid attempt, no retry text', async () => {
    const { result, seen } = await run(
      'mainnet',
      'mainnet',
      () =>
        new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader('mainnet', 'insufficient_funds') },
        }),
    )

    expectFreePartial(result)
    expect(result.donationFailure?.code).toBe('insufficient_usdc')
    expect(result.donationFailure?.reason).toMatch(/too little USDC/)
    expect(result.donationFailure?.reason).not.toMatch(/Try again later/)
    expect(seen.filter((request) => request.signed).length).toBe(1)
    expectNoPaymentOnFreeRequest(seen)
  })

  it('facilitator 5xx: free partial result, one paid attempt, says try again later', async () => {
    const { result, seen } = await run(
      'mainnet',
      'mainnet',
      () => new Response('bad gateway', { status: 502 }),
    )

    expectFreePartial(result)
    expect(result.donationFailure?.code).toBe('facilitator_error')
    expect(result.donationFailure?.reason).toMatch(/answered 502.*Try again later\./)
    expect(seen.filter((request) => request.signed).length).toBe(1)
    expectNoPaymentOnFreeRequest(seen)
  })

  it('without allowDonation, a result has no donationFailure and never pays', async () => {
    vi.resetModules()
    const { attestLockfileTool } = await import('./attest.js')
    const server = serverMock('testnet', () => {
      throw new Error('must never pay')
    })
    vi.stubGlobal('fetch', server.mock)

    const result = await attestLockfileTool.handler({ lockfilePath, allowDonation: false })

    expect(result.donationFailure).toBeUndefined()
    expect(server.seen).toHaveLength(1)
    expect(server.seen[0]?.signed).toBe(false)
  })
})
