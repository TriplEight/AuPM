import { Buffer } from 'node:buffer'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } from '@x402-avm/avm'
import { encodePaymentResponseHeader } from '@x402-avm/core/http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { attestLockfileTool } from './attest.js'

const TEST_MNEMONIC =
  'empower weekend pioneer arctic analyst off visa clay reveal ocean chaos price wear suit energy april cradle trigger awful crew scissors panic noodle absorb mom'

const PAY_TO = 'J6DSQYYXYO53B7PC6MZ5M2OO7V3RM4MIWTV7KCH5IQBUXF7KMGPVFWIRAM'
const FEE_PAYER = 'EA4DXI4WJWSSJQAAKG5ZFNVA6U26NT7DBWHUKP5C3HSVKBAQ3KGPKVEN5A'
const RESOURCE_URL = 'http://localhost:4873/v1/attest/lockfile'
// The default lockfile fixture below has exactly one package entry, so its
// spend cap (SPEC.md §11.4) is 1,000 microUSDC * 1 entry.
const LOCKFILE_PRICE = '1000'

function algodParamsResponse(): Response {
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

function paymentRequiredHeader(amount: string = LOCKFILE_PRICE): string {
  const paymentRequired = {
    x402Version: 2,
    resource: { url: RESOURCE_URL },
    accepts: [
      {
        scheme: 'exact',
        network: ALGORAND_MAINNET_CAIP2,
        asset: USDC_MAINNET_ASA_ID,
        amount,
        payTo: PAY_TO,
        maxTimeoutSeconds: 120,
        extra: {
          asset: USDC_MAINNET_ASA_ID,
          feePayer: FEE_PAYER,
          tag: 'x402-global-challenge',
        },
      },
    ],
  }
  return Buffer.from(JSON.stringify(paymentRequired)).toString('base64')
}

/** DSSE-shaped attestation whose payload decodes to a Statement with the given `withheld`. */
function attestationWithWithheld(withheld: number): { payloadType: string; payload: string } {
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://aupm.example.com/attestation/lockfile/v1',
    predicate: { withheld },
  }
  return {
    payloadType: 'application/vnd.in-toto+json',
    payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  }
}

/** Builds a package-lock.json body with exactly `count` package entries. */
function lockfileWithEntries(count: number): string {
  const packages: Record<string, unknown> = {}
  for (let i = 0; i < count; i += 1) {
    packages[`node_modules/pkg-${i}`] = { version: '1.0.0' }
  }
  return JSON.stringify({ lockfileVersion: 3, packages })
}

function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input
  if (input instanceof URL) return input.toString()
  return input.url
}

function settleResponseHeader(transaction: string): string {
  return encodePaymentResponseHeader({
    success: true,
    transaction,
    network: ALGORAND_MAINNET_CAIP2,
  })
}

function writeLockfile(
  content: string = JSON.stringify({
    lockfileVersion: 3,
    packages: { 'node_modules/ms': { version: '2.1.3' } },
  }),
): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-attest-test-'))
  const lockfilePath = path.join(dir, 'package-lock.json')
  fs.writeFileSync(lockfilePath, content)
  return lockfilePath
}

describe('attest_lockfile', () => {
  let lockfilePath: string

  beforeEach(() => {
    lockfilePath = writeLockfile()
    process.env.AUPM_DONOR_MNEMONIC = TEST_MNEMONIC
    process.env.AUPM_PROXY_URL = 'http://localhost:4873'
    delete process.env.NETWORK
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.AUPM_DONOR_MNEMONIC
    delete process.env.AUPM_PROXY_URL
    delete process.env.NETWORK
    fs.rmSync(path.dirname(lockfilePath), { recursive: true, force: true })
  })

  it('without allowDonation, a 402 never signs and reports donation_required', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
        }),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath })

    expect(result.status).toBe('donation_required')
    if (result.status !== 'donation_required') throw new Error('unreachable')
    expect(result.priceMicro).toBe(1000)
    expect(result.resourceUrl).toBe(RESOURCE_URL)
    expect(result.asset).toBe(USDC_MAINNET_ASA_ID)
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('without allowDonation, sends X-AuPM-Donate: 0', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(requestUrl(input), init)
      expect(request.headers.get('X-AuPM-Donate')).toBe('0')
      return new Response(
        JSON.stringify({
          summary: { total: 1, reviewed: 1, unreviewed: 0, unresolvable: 0, integrityMismatch: 0 },
          attestation: attestationWithWithheld(0),
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await attestLockfileTool.handler({ lockfilePath })

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('with allowDonation, sends X-AuPM-Donate: 1 on both the initial and the paid retry', async () => {
    const seenHeaderValues: (string | null)[] = []

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()

      const request = input instanceof Request ? input : new Request(url, init)
      seenHeaderValues.push(request.headers.get('X-AuPM-Donate'))
      const paymentSignature = request.headers.get('PAYMENT-SIGNATURE')
      if (!paymentSignature) {
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
        })
      }
      return new Response(
        JSON.stringify({
          summary: { total: 1, reviewed: 1, unreviewed: 0, unresolvable: 0, integrityMismatch: 0 },
          attestation: attestationWithWithheld(0),
        }),
        { status: 200, headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-header-ok') } },
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    await attestLockfileTool.handler({ lockfilePath, allowDonation: true })

    expect(seenHeaderValues).toEqual(['1', '1'])
  })

  it('a lockfile with 25 reviewed entries (402 amount 25,000) is paid', async () => {
    const bigLockfilePath = writeLockfile(lockfileWithEntries(25))
    let paidRequestCount = 0

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()

      const request = input instanceof Request ? input : new Request(url, init)
      if (!request.headers.get('PAYMENT-SIGNATURE')) {
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader('25000') },
        })
      }

      paidRequestCount += 1
      return new Response(
        JSON.stringify({
          summary: {
            total: 25,
            reviewed: 25,
            unreviewed: 0,
            unresolvable: 0,
            integrityMismatch: 0,
          },
          attestation: attestationWithWithheld(0),
        }),
        { status: 200, headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-25-ok') } },
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({
      lockfilePath: bigLockfilePath,
      allowDonation: true,
    })

    expect(result.status).toBe('attested')
    if (result.status !== 'attested') throw new Error('unreachable')
    expect(result.settlement).toEqual({ txid: 'txid-25-ok', amountMicro: 25_000 })
    expect(paidRequestCount).toBe(1)
  })

  it('a 402 above the cap (1,000 * entries + 1) is refused and nothing is signed', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()
      const request = input instanceof Request ? input : new Request(url, init)
      if (request.headers.get('PAYMENT-SIGNATURE')) {
        throw new Error('must never sign a requirement above the spend cap')
      }
      return new Response(null, {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader('1001') },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(attestLockfileTool.handler({ lockfilePath, allowDonation: true })).rejects.toThrow(
      /refusing to donate/,
    )
  })

  it('a 402 for a non-USDC asset is refused and nothing is signed', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()
      const request = input instanceof Request ? input : new Request(url, init)
      if (request.headers.get('PAYMENT-SIGNATURE')) {
        throw new Error('must never sign a non-USDC requirement')
      }
      const paymentRequired = {
        x402Version: 2,
        resource: { url: RESOURCE_URL },
        accepts: [
          {
            scheme: 'exact',
            network: ALGORAND_MAINNET_CAIP2,
            asset: '0',
            amount: LOCKFILE_PRICE,
            payTo: PAY_TO,
            maxTimeoutSeconds: 120,
            extra: { asset: '0', feePayer: FEE_PAYER, tag: 'x402-global-challenge' },
          },
        ],
      }
      return new Response(null, {
        status: 402,
        headers: {
          'PAYMENT-REQUIRED': Buffer.from(JSON.stringify(paymentRequired)).toString('base64'),
        },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(attestLockfileTool.handler({ lockfilePath, allowDonation: true })).rejects.toThrow(
      /refusing to donate/,
    )
  })

  it('without allowDonation, a partial 200 with withheld packages reports donation_required with the attestation', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: {
              total: 1,
              reviewed: 1,
              unreviewed: 0,
              unresolvable: 0,
              integrityMismatch: 0,
            },
            attestation: attestationWithWithheld(1),
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath })

    expect(result.status).toBe('donation_required')
    if (result.status !== 'donation_required') throw new Error('unreachable')
    expect(result.withheld).toBe(1)
    expect(result.priceMicro).toBe(1000)
    expect(result.resourceUrl).toBe(RESOURCE_URL)
    expect(result.asset).toBe(USDC_MAINNET_ASA_ID)
    expect(result.summary).toMatchObject({ reviewed: 1 })
    expect(result.attestation).toBeDefined()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('without allowDonation, a genuinely full (withheld: 0) 200 response reports status: attested', async () => {
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: {
              total: 1,
              reviewed: 0,
              unreviewed: 1,
              unresolvable: 0,
              integrityMismatch: 0,
            },
            attestation: attestationWithWithheld(0),
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath })

    expect(result.status).toBe('attested')
  })

  it('with allowDonation, POSTs the raw lockfile bytes and pays exactly one retry', async () => {
    let capturedBody: string | null = null
    let paidRequestCount = 0

    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes('/v2/transactions/params')) return algodParamsResponse()

      const request = input instanceof Request ? input : new Request(url, init)
      const paymentSignature = request.headers.get('PAYMENT-SIGNATURE')
      if (!paymentSignature) {
        capturedBody = await request.clone().text()
        return new Response(null, {
          status: 402,
          headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader() },
        })
      }

      paidRequestCount += 1
      return new Response(
        JSON.stringify({
          summary: { total: 1, reviewed: 1, unreviewed: 0, unresolvable: 0, integrityMismatch: 0 },
          attestation: { payloadType: 'application/vnd.in-toto+json' },
        }),
        { status: 200, headers: { 'PAYMENT-RESPONSE': settleResponseHeader('txid-lockfile-ok') } },
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath, allowDonation: true })

    expect(result.status).toBe('attested')
    if (result.status !== 'attested') throw new Error('unreachable')
    expect(result.summary).toMatchObject({ reviewed: 1 })
    expect(result.settlement).toEqual({
      txid: 'txid-lockfile-ok',
      amountMicro: Number(LOCKFILE_PRICE),
    })
    expect(paidRequestCount).toBe(1)
    expect(capturedBody).toContain('node_modules/ms')

    const resourceCalls = mockFetch.mock.calls.filter(
      ([input]) => !requestUrl(input as RequestInfo | URL).includes('/v2/transactions/params'),
    )
    expect(resourceCalls).toHaveLength(2)
  })

  it('a zero-coverage 200 succeeds without AUPM_DONOR_MNEMONIC set', async () => {
    delete process.env.AUPM_DONOR_MNEMONIC
    const mockFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            summary: {
              total: 1,
              reviewed: 0,
              unreviewed: 1,
              unresolvable: 0,
              integrityMismatch: 0,
            },
            attestation: { payloadType: 'application/vnd.in-toto+json' },
          }),
          { status: 200 },
        ),
    )
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath, allowDonation: true })

    expect(result.status).toBe('attested')
    if (result.status !== 'attested') throw new Error('unreachable')
    expect(result.settlement).toBeNull()
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('attest_lockfile with a pnpm-lock.yaml', () => {
  const PNPM_BODY = `lockfileVersion: '9.0'

packages:

  ms@2.1.3:
    resolution: {integrity: sha512-ms}
`
  let dir: string
  let pnpmLockfilePath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-attest-pnpm-test-'))
    pnpmLockfilePath = path.join(dir, 'pnpm-lock.yaml')
    fs.writeFileSync(pnpmLockfilePath, PNPM_BODY)
    process.env.AUPM_DONOR_MNEMONIC = TEST_MNEMONIC
    process.env.AUPM_PROXY_URL = 'http://localhost:4873'
    delete process.env.NETWORK
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.AUPM_DONOR_MNEMONIC
    delete process.env.AUPM_PROXY_URL
    delete process.env.NETWORK
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function okResponse(): Response {
    return new Response(
      JSON.stringify({
        summary: { total: 1, reviewed: 0, unreviewed: 1, unresolvable: 0, integrityMismatch: 0 },
        attestation: attestationWithWithheld(0),
      }),
      { status: 200 },
    )
  }

  it('sends the YAML content type and the exact file bytes', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(requestUrl(input), init)
      expect(request.headers.get('content-type')).toBe('application/yaml')
      expect(request.headers.get('X-AuPM-Donate')).toBe('0')
      expect(await request.text()).toBe(PNPM_BODY)
      return okResponse()
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath: pnpmLockfilePath })

    expect(result.status).toBe('attested')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('counts pnpm entries for the donation cap: 1 entry refuses a 2,000 microUSDC price', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (requestUrl(input).includes('/v2/transactions/params')) return algodParamsResponse()
      return new Response(null, {
        status: 402,
        headers: { 'PAYMENT-REQUIRED': paymentRequiredHeader('2000') },
      })
    })
    vi.stubGlobal('fetch', mockFetch)

    await expect(
      attestLockfileTool.handler({ lockfilePath: pnpmLockfilePath, allowDonation: true }),
    ).rejects.toThrow()
    expect(mockFetch.mock.calls.length).toBeLessThanOrEqual(2)
  })

  it('refuses a pnpm-lock.yaml over 2 MiB without sending it', async () => {
    fs.writeFileSync(pnpmLockfilePath, `lockfileVersion: '9.0'\n#${'x'.repeat(2 * 1024 * 1024)}\n`)
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    await expect(attestLockfileTool.handler({ lockfilePath: pnpmLockfilePath })).rejects.toThrow(
      /2097152 bytes/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('reports 413 and 422 with a clear message', async () => {
    for (const [status, text] of [
      [413, /too large/],
      [422, /time limit/],
    ] as const) {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('x', { status })),
      )
      await expect(attestLockfileTool.handler({ lockfilePath: pnpmLockfilePath })).rejects.toThrow(
        text,
      )
    }
  })

  it('honors Retry-After on a 503 once, then succeeds', async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('busy', { status: 503, headers: { 'Retry-After': '0' } }))
      .mockResolvedValueOnce(okResponse())
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath: pnpmLockfilePath })

    expect(result.status).toBe('attested')
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('fails with a message when the second attempt is also 503', async () => {
    const mockFetch = vi.fn(
      async () => new Response('busy', { status: 503, headers: { 'Retry-After': '0' } }),
    )
    vi.stubGlobal('fetch', mockFetch)

    await expect(attestLockfileTool.handler({ lockfilePath: pnpmLockfilePath })).rejects.toThrow(
      /busy parsing/,
    )
    expect(mockFetch).toHaveBeenCalledTimes(2)
  })

  it('keeps application/json for package-lock.json', async () => {
    const jsonPath = path.join(dir, 'package-lock.json')
    fs.writeFileSync(jsonPath, JSON.stringify({ lockfileVersion: 3, packages: {} }))
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(requestUrl(input), init)
      expect(request.headers.get('content-type')).toBe('application/json')
      return okResponse()
    })
    vi.stubGlobal('fetch', mockFetch)

    await attestLockfileTool.handler({ lockfilePath: jsonPath })

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('attest_lockfile with a yarn.lock', () => {
  const YARN_BODY = `# yarn lockfile v1


"ms@^2.0.0", ms@^2.1.3:
  version "2.1.3"
  resolved "https://registry.yarnpkg.com/ms/-/ms-2.1.3.tgz#abc"
  integrity sha512-ms
`
  let dir: string
  let yarnLockPath: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-attest-yarn-test-'))
    yarnLockPath = path.join(dir, 'yarn.lock')
    fs.writeFileSync(yarnLockPath, YARN_BODY)
    process.env.AUPM_PROXY_URL = 'http://localhost:4873'
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    delete process.env.AUPM_PROXY_URL
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('sends text/plain and the exact file bytes', async () => {
    const mockFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(requestUrl(input), init)
      expect(request.headers.get('content-type')).toBe('text/plain')
      expect(await request.text()).toBe(YARN_BODY)
      return new Response(
        JSON.stringify({
          summary: { total: 1, reviewed: 0, unreviewed: 1, unresolvable: 0, integrityMismatch: 0 },
          attestation: attestationWithWithheld(0),
        }),
        { status: 200 },
      )
    })
    vi.stubGlobal('fetch', mockFetch)

    const result = await attestLockfileTool.handler({ lockfilePath: yarnLockPath })

    expect(result.status).toBe('attested')
    expect(mockFetch).toHaveBeenCalledTimes(1)
  })

  it('refuses a berry yarn.lock before any request', async () => {
    fs.writeFileSync(yarnLockPath, '__metadata:\n  version: 8\n')
    const mockFetch = vi.fn()
    vi.stubGlobal('fetch', mockFetch)

    await expect(attestLockfileTool.handler({ lockfilePath: yarnLockPath })).rejects.toThrow(
      /only yarn classic/,
    )
    expect(mockFetch).not.toHaveBeenCalled()
  })
})
