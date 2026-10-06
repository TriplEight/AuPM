// cli/src/donor.test.ts
//
// algod is mocked at the HTTP boundary (global fetch). The accounts are throwaway:
// generated per test run, never funded.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import algosdk from 'algosdk'
import { USDC_ASSET_ID } from 'aupm-mcp/donor'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { type DonorIo, runDonor } from './donor.js'

const KEY_VAR = 'AUPM_DONOR_MNEMONIC'

let configHome: string
let keyFile: string

interface FakeAlgod {
  balance: bigint
  assets: { 'asset-id': number; amount: number }[]
  submitted: Uint8Array[]
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function installFakeAlgod(state: FakeAlgod): void {
  vi.stubGlobal('fetch', async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url)
    if (url.pathname.startsWith('/v2/accounts/')) {
      return jsonResponse({
        address: url.pathname.split('/').pop(),
        amount: Number(state.balance),
        'amount-without-pending-rewards': Number(state.balance),
        'min-balance': 100_000 + 100_000 * state.assets.length,
        'pending-rewards': 0,
        'reward-base': 0,
        rewards: 0,
        round: 10,
        status: 'Offline',
        'total-apps-opted-in': 0,
        'total-assets-opted-in': state.assets.length,
        'total-created-apps': 0,
        'total-created-assets': 0,
        assets: state.assets.map((asset) => ({ ...asset, 'is-frozen': false })),
      })
    }
    if (url.pathname === '/v2/transactions/params') {
      return jsonResponse({
        'consensus-version': 'https://github.com/algorandfoundation/specs/tree/abc123',
        fee: 0,
        'genesis-hash': Buffer.alloc(32, 0x12).toString('base64'),
        'genesis-id': 'mainnet-v1.0',
        'last-round': 1000,
        'min-fee': 1000,
      })
    }
    if (url.pathname === '/v2/transactions' && init?.method === 'POST') {
      state.submitted.push(new Uint8Array(init.body as ArrayBuffer))
      return jsonResponse({ txId: 'ignored' })
    }
    if (url.pathname === '/v2/status') {
      return jsonResponse({
        'catchup-time': 0,
        'last-round': 1000,
        'last-version': 'v1',
        'next-version': 'v1',
        'next-version-round': 1001,
        'next-version-supported': true,
        'stopped-at-unsupported-round': false,
        'time-since-last-round': 1,
      })
    }
    if (url.pathname.startsWith('/v2/transactions/pending/')) {
      const txn = algosdk.msgpackRawDecode(state.submitted[0] as Uint8Array)
      const body = algosdk.msgpackRawEncode({ 'confirmed-round': 1001, 'pool-error': '', txn })
      return new Response(body, { headers: { 'content-type': 'application/msgpack' } })
    }
    return new Response(`unexpected request ${init?.method} ${url.pathname}`, { status: 500 })
  })
}

function captureIo() {
  return { out: vi.fn<DonorIo['out']>(), err: vi.fn<DonorIo['err']>() }
}

function allText(io: ReturnType<typeof captureIo>): string {
  return [...io.out.mock.calls, ...io.err.mock.calls].map((call) => String(call[0])).join('\n')
}

function newAccount(): { mnemonic: string; address: string } {
  const account = algosdk.generateAccount()
  return { mnemonic: algosdk.secretKeyToMnemonic(account.sk), address: account.addr.toString() }
}

function fastOptions(state: FakeAlgod, onSleep?: () => void) {
  let clock = 0
  return {
    now: () => clock,
    pollIntervalMs: 1,
    sleep: async (ms: number) => {
      clock += 60_000 + ms
      onSleep?.()
    },
    state,
  }
}

function freshState(balance: bigint, assets: FakeAlgod['assets'] = []): FakeAlgod {
  return { balance, assets, submitted: [] }
}

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-donor-test-'))
  process.env.XDG_CONFIG_HOME = configHome
  keyFile = path.join(configHome, 'aupm', 'donor.env')
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  delete process.env[KEY_VAR]
  delete process.env.XDG_CONFIG_HOME
  fs.rmSync(configHome, { recursive: true, force: true })
})

describe('aupm donor init', () => {
  it('writes the key file with mode 0600 in a 0700 directory', async () => {
    const state = freshState(500_000n)
    installFakeAlgod(state)
    const io = captureIo()
    const code = await runDonor(['init'], { io, ...fastOptions(state) })
    expect(code).toBe(0)
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(keyFile)).mode & 0o777).toBe(0o700)
  })

  it('prints the address, the file path, the ARC-26 URI and the funding, never the key', async () => {
    const state = freshState(500_000n)
    installFakeAlgod(state)
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const write = vi.spyOn(process.stdout, 'write')
    await runDonor(['init'], fastOptions(state))
    const printed = [...log.mock.calls, ...error.mock.calls, ...write.mock.calls]
      .map((call) => String(call[0]))
      .join('\n')
    const stored = fs.readFileSync(keyFile, 'utf8').trim().replace(`${KEY_VAR}=`, '')
    const address = algosdk.mnemonicToSecretKey(stored).addr.toString()
    expect(printed).toContain(address)
    expect(printed).toContain(keyFile)
    expect(printed).toContain(`algorand://${address}`)
    expect(printed).toContain('0.201000 ALGO')
    expect(printed).toContain(`ASA ${USDC_ASSET_ID}`)
    expect(printed).not.toContain(stored)
    const words = stored.split(' ')
    for (let index = 0; index + 1 < words.length; index += 1) {
      expect(printed).not.toContain(`${words[index]} ${words[index + 1]}`)
    }
  })

  it('refuses an existing file and names the path', async () => {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, 'keep me', { mode: 0o600 })
    const io = captureIo()
    const code = await runDonor(['init'], { io })
    expect(code).toBe(1)
    expect(allText(io)).toContain(keyFile)
    expect(fs.readFileSync(keyFile, 'utf8')).toBe('keep me')
  })
})

describe('aupm donor optin', () => {
  it('waits for ALGO, then submits one opt-in for the USDC ASA', async () => {
    const account = newAccount()
    process.env[KEY_VAR] = account.mnemonic
    const state = freshState(0n)
    installFakeAlgod(state)
    const io = captureIo()
    const options = fastOptions(state, () => {
      state.balance = 201_000n
    })
    const code = await runDonor(['optin'], { io, ...options })
    expect(io.err.mock.calls).toEqual([])
    expect(code).toBe(0)
    expect(state.submitted).toHaveLength(1)
    const signed = algosdk.decodeSignedTransaction(state.submitted[0] as Uint8Array)
    const transfer = signed.txn.assetTransfer
    expect(transfer?.assetIndex).toBe(BigInt(USDC_ASSET_ID))
    expect(transfer?.amount).toBe(0n)
    expect(signed.txn.sender.toString()).toBe(account.address)
    expect(transfer?.receiver.toString()).toBe(account.address)
    expect(allText(io)).toContain('Waiting for 0.201000 ALGO')
    expect(allText(io)).not.toContain(account.mnemonic)
  })

  it('is idempotent: already opted in exits 0 and sends nothing', async () => {
    process.env[KEY_VAR] = newAccount().mnemonic
    const state = freshState(500_000n, [{ 'asset-id': Number(USDC_ASSET_ID), amount: 0 }])
    installFakeAlgod(state)
    const io = captureIo()
    const code = await runDonor(['optin'], { io, ...fastOptions(state) })
    expect(code).toBe(0)
    expect(allText(io)).toContain('already opted in')
    expect(state.submitted).toHaveLength(0)
  })

  it('exits non-zero on a poll timeout and prints the address and the funding', async () => {
    const account = newAccount()
    process.env[KEY_VAR] = account.mnemonic
    const state = freshState(0n)
    installFakeAlgod(state)
    const io = captureIo()
    const code = await runDonor(['optin', '--timeout', '2'], { io, ...fastOptions(state) })
    expect(code).toBe(1)
    expect(io.err.mock.calls.map((call) => String(call[0])).join('\n')).toContain(account.address)
    expect(allText(io)).toContain('0.201000 ALGO')
    expect(state.submitted).toHaveLength(0)
  })

  it('rejects a bad --timeout value', async () => {
    process.env[KEY_VAR] = newAccount().mnemonic
    const io = captureIo()
    expect(await runDonor(['optin', '--timeout', '0'], { io })).toBe(1)
    expect(allText(io)).toContain('--timeout')
  })

  it('stops cleanly with exit 0 on SIGINT', async () => {
    process.env[KEY_VAR] = newAccount().mnemonic
    const state = freshState(0n)
    installFakeAlgod(state)
    const io = captureIo()
    const code = await runDonor(['optin'], {
      io,
      now: () => 0,
      sleep: async (_ms, signal) => {
        process.emit('SIGINT')
        expect(signal.aborted).toBe(true)
      },
    })
    expect(code).toBe(0)
    expect(allText(io)).toContain('Stopped')
  })

  it('reads the key file when the env var is unset', async () => {
    const account = newAccount()
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${KEY_VAR}=${account.mnemonic}\n`, { mode: 0o600 })
    const state = freshState(500_000n, [{ 'asset-id': Number(USDC_ASSET_ID), amount: 0 }])
    installFakeAlgod(state)
    const requested: string[] = []
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      requested.push(String(input))
      return inner(input, init)
    })
    expect(await runDonor(['optin'], { io: captureIo(), ...fastOptions(state) })).toBe(0)
    expect(requested.some((url) => url.includes(account.address))).toBe(true)
  })

  it('lets the env var beat the key file', async () => {
    const fileAccount = newAccount()
    const envAccount = newAccount()
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${KEY_VAR}=${fileAccount.mnemonic}\n`, { mode: 0o600 })
    process.env[KEY_VAR] = envAccount.mnemonic
    const state = freshState(500_000n, [{ 'asset-id': Number(USDC_ASSET_ID), amount: 0 }])
    installFakeAlgod(state)
    const requested: string[] = []
    const inner = globalThis.fetch
    vi.stubGlobal('fetch', (input: string | URL | Request, init?: RequestInit) => {
      requested.push(String(input))
      return inner(input, init)
    })
    await runDonor(['optin'], { io: captureIo(), ...fastOptions(state) })
    expect(requested.some((url) => url.includes(envAccount.address))).toBe(true)
    expect(requested.some((url) => url.includes(fileAccount.address))).toBe(false)
  })

  it('refuses a key file with mode 0644 and suggests chmod 600', async () => {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${KEY_VAR}=${newAccount().mnemonic}\n`)
    fs.chmodSync(keyFile, 0o644)
    const io = captureIo()
    const code = await runDonor(['optin'], { io })
    expect(code).toBe(1)
    expect(allText(io)).toContain(`chmod 600 ${keyFile}`)
  })

  it('tells the user to run init when no key exists', async () => {
    const io = captureIo()
    expect(await runDonor(['optin'], { io })).toBe(1)
    expect(allText(io)).toContain('aupm donor init')
  })
})

describe('aupm donor usage', () => {
  it('prints usage for an unknown subcommand', async () => {
    const io = captureIo()
    expect(await runDonor(['frobnicate'], { io })).toBe(1)
    expect(allText(io)).toContain('Usage: aupm donor')
  })
})
