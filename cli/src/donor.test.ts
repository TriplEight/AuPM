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
const USDC = Number(USDC_ASSET_ID)
const ESCAPE = '\u001b['

let configHome: string
let keyFile: string

interface FakeAlgod {
  balance: bigint
  assets: { 'asset-id': number; amount: number }[]
  submitted: Uint8Array[]
  requests: string[]
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
    state.requests.push(`${init?.method ?? 'GET'} ${url.pathname}`)
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

function freshState(balance: bigint, assets: FakeAlgod['assets'] = []): FakeAlgod {
  return { balance, assets, submitted: [], requests: [] }
}

function optedIn(amount = 0): FakeAlgod['assets'] {
  return [{ 'asset-id': USDC, amount }]
}

function useAccount(): { mnemonic: string; address: string } {
  const account = newAccount()
  process.env[KEY_VAR] = account.mnemonic
  return account
}

function expectNoMnemonic(text: string, mnemonic: string): void {
  expect(text).not.toContain(mnemonic)
  const words = mnemonic.split(' ')
  for (let index = 0; index + 1 < words.length; index += 1) {
    expect(text).not.toContain(`${words[index]} ${words[index + 1]}`)
  }
}

function expectCleanSecretText(text: string): void {
  expect(text).not.toContain('sed')
  expect(text).not.toContain('secret set -f')
  expect(text).not.toContain('AUPM_DONOR_MNEMONIC=')
  expect(text).not.toContain('secrets.AUPM_DONOR_MNEMONIC }}')
  expect(text).not.toMatch(/dispenser|faucet|lora\.algokit\.io\/testnet\/fund|circle\.com/i)
}

function storedMnemonic(): string {
  return fs.readFileSync(keyFile, 'utf8').trim()
}

beforeEach(() => {
  configHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aupm-donor-test-'))
  process.env.XDG_CONFIG_HOME = configHome
  keyFile = path.join(configHome, 'aupm', 'donor.key')
  vi.stubEnv('NO_COLOR', undefined)
  vi.stubEnv('FORCE_COLOR', undefined)
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
  delete process.env[KEY_VAR]
  delete process.env.XDG_CONFIG_HOME
  fs.rmSync(configHome, { recursive: true, force: true })
})

describe('aupm donor init', () => {
  it('writes the key file with mode 0600 in a 0700 directory and makes no network call', async () => {
    const state = freshState(0n)
    installFakeAlgod(state)
    const code = await runDonor(['init'], { io: captureIo() })
    expect(code).toBe(0)
    expect(fs.statSync(keyFile).mode & 0o777).toBe(0o600)
    expect(fs.statSync(path.dirname(keyFile)).mode & 0o777).toBe(0o700)
    expect(state.requests).toEqual([])
  })

  it('prints the warning block first, then the address and network, then the steps', async () => {
    const io = captureIo()
    await runDonor(['init'], { io })
    const text = allText(io)
    const address = algosdk.mnemonicToSecretKey(storedMnemonic()).addr.toString()
    const warning = text.indexOf('PLEASE READ')
    const where = text.indexOf(`Address: ${address}`)
    const steps = text.indexOf('Next steps')
    expect(warning).toBeGreaterThan(-1)
    expect(where).toBeGreaterThan(warning)
    expect(steps).toBeGreaterThan(where)
    expect(text).toContain('Network: Algorand MainNet')
    for (const phrase of [
      `The file ${keyFile} holds the secret key of your donor wallet: 25 words.`,
      'hot wallet by design',
      'Any program that runs as this user can read the key',
      'and spend the funds',
      '1 USDC pays for 1,000 reviewed packages',
      'This file is the only copy.',
      'Back up the 25 words offline: on paper, or on an external drive.',
      'Never paste the key into a chat, an issue or a log.',
    ]) {
      expect(text.slice(warning, where)).toContain(phrase)
    }
  })

  it('prints five numbered steps with the ARC-26 URI for ALGO', async () => {
    const io = captureIo()
    await runDonor(['init'], { io })
    const text = allText(io)
    const address = algosdk.mnemonicToSecretKey(storedMnemonic()).addr.toString()
    for (const number of ['1.', '2.', '3.', '4.', '5.']) expect(text).toContain(`\n${number} `)
    expect(text).toContain(`algorand://${address}?amount=300000\n`)
    expect(text).not.toContain('asset=')
    expect(text).toContain('`aupm donor optin` shows a QR code for this step.')
    expect(text.split(keyFile)).toHaveLength(3)
    expect(text.startsWith('Created the donor wallet.\n')).toBe(true)
    expect(text).not.toContain('deadline')
    expect(text).toContain('Run `aupm donor status` at any time to see the next step.')
    expect(text).toContain('1. Send 0.3 ALGO to this address. The minimum is 0.201 ALGO')
    expect(text).toContain('With Pera Wallet (formerly the official Algorand Wallet): buy ALGO')
    expect(text.split('formerly').length).toBe(2)
    expect(text).toContain('Send 1 to 5 USDC to this address.')
    expect(text).toContain('USDC from other chains is lost')
    expect(text).toContain('2. Run `aupm donor optin`.')
    expect(text).toContain(
      'You may use a separate wallet: put XDG_CONFIG_HOME="$HOME/.config/aupm-ci" before the same onboarding commands.',
    )
    expect(text).toContain(`gh secret set AUPM_DONOR_MNEMONIC_MAINNET < "${keyFile}"`)
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the text shows a GitHub Actions expression
    expect(text).toContain('donor-secret: ${{ secrets.AUPM_DONOR_MNEMONIC_MAINNET }}')
    expectCleanSecretText(text)
    expect(text).toContain('Settings > Secrets and variables > Actions > New repository secret')
    expect(text).toContain('can change the workflows of the repository can read the secret')
    expect(text).toContain('5. Donate. Add --donate to an install or attest command')
    expect(text).toContain('`aupm install --donate`')
    expect(text).toContain('aupm attest package-lock.json --donate')
    expect(text).toContain('It pays 0.001 USDC for each reviewed package in the lockfile.')
    expect(text).toContain('Without --donate, every install is free, reviewed packages included.')
    expect(text).not.toContain('plain install')
    expect(text).not.toMatch(/exchange.*(binance|coinbase|kraken)/i)
  })

  it('stays within 40 lines, not counting the QR code', async () => {
    const io = captureIo()
    await runDonor(['init'], { io })
    const lines = allText(io)
      .split('\n')
      .filter((line) => !/[█▀▄]/.test(line) && !line.trim().startsWith('algorand://'))
    expect(lines.length).toBeLessThanOrEqual(40)
  })

  it('does not wait, poll or continue into the opt-in', async () => {
    const state = freshState(0n)
    installFakeAlgod(state)
    const io = captureIo()
    expect(await runDonor(['init'], { io })).toBe(0)
    expect(state.requests).toEqual([])
    expect(await runDonor(['init', '--timeout', '2'], { io })).toBe(1)
    expect(allText(io)).toContain('Usage: aupm donor')
  })

  it('never prints the mnemonic', async () => {
    const io = captureIo()
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    await runDonor(['init'], { io })
    await runDonor(['init'])
    const printed = [allText(io), ...log.mock.calls.flat(), ...error.mock.calls.flat()].join('\n')
    expectNoMnemonic(printed, storedMnemonic())
  })

  it('prints no escape code when stdout is not a terminal', async () => {
    const io = captureIo()
    await runDonor(['init'], { io })
    expect(allText(io)).not.toContain(ESCAPE)
  })

  it('prints no escape code with NO_COLOR', async () => {
    vi.stubEnv('NO_COLOR', '1')
    const io = captureIo()
    await runDonor(['init'], { io })
    expect(allText(io)).not.toContain(ESCAPE)
  })

  it('colors the warning block with FORCE_COLOR', async () => {
    vi.stubEnv('FORCE_COLOR', '1')
    const io = captureIo()
    await runDonor(['init'], { io })
    expect(allText(io)).toContain(ESCAPE)
  })

  it('says that an existing file holds funds, shows its address and never says remove', async () => {
    const account = newAccount()
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${account.mnemonic}\n`, { mode: 0o600 })
    const io = captureIo()
    const code = await runDonor(['init'], { io })
    const text = allText(io)
    expect(code).toBe(1)
    expect(text).toContain(keyFile)
    expect(text).toContain(account.address)
    expect(text).toContain('aupm donor status')
    expect(text).toContain('Deleting it loses the funds in this wallet')
    expect(text).toContain('Back up the file before you change anything.')
    expect(text).not.toMatch(/remove/i)
    expectNoMnemonic(text, account.mnemonic)
    expect(storedMnemonic()).toBe(account.mnemonic)
  })

  it('says that the env var wins over the file and shows the address in use', async () => {
    const envAccount = useAccount()
    const io = captureIo()
    expect(await runDonor(['init'], { io })).toBe(0)
    const text = allText(io)
    expect(text).toContain(
      'AUPM_DONOR_MNEMONIC is set in the environment. It wins over the key file.',
    )
    expect(text).toContain(`The address in use is: ${envAccount.address}`)
    expectNoMnemonic(text, envAccount.mnemonic)
  })

  it('says that the key file is not permission-protected on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const io = captureIo()
    await runDonor(['init'], { io })
    expect(allText(io)).toContain('On Windows, the permissions of this file are not protected')
    expect(allText(io)).toContain('$env:XDG_CONFIG_HOME = "$HOME/.config/aupm-ci"')
    expect(allText(io)).toContain(
      `Get-Content "${keyFile}" | gh secret set AUPM_DONOR_MNEMONIC_MAINNET`,
    )
    expectCleanSecretText(allText(io))
  })
})

describe('aupm donor optin', () => {
  it('sends one opt-in when funded, then prints the txid, the explorer link and the USDC step', async () => {
    const account = useAccount()
    const state = freshState(201_000n)
    installFakeAlgod(state)
    const io = captureIo()
    const code = await runDonor(['optin'], { io })
    expect(io.err.mock.calls).toEqual([])
    expect(code).toBe(0)
    expect(state.submitted).toHaveLength(1)
    const signed = algosdk.decodeSignedTransaction(state.submitted[0] as Uint8Array)
    const transfer = signed.txn.assetTransfer
    expect(transfer?.assetIndex).toBe(BigInt(USDC_ASSET_ID))
    expect(transfer?.amount).toBe(0n)
    expect(signed.txn.sender.toString()).toBe(account.address)
    expect(transfer?.receiver.toString()).toBe(account.address)
    const text = allText(io)
    const txid = signed.txn.txID()
    expect(text).toContain(`Transaction: ${txid}`)
    expect(text).toContain(`https://lora.algokit.io/mainnet/transaction/${txid}`)
    expect(text).toContain('Send 1 to 5 USDC')
    expect(text).toContain(`algorand://${account.address}?amount=1000000&asset=${USDC}`)
    expectNoMnemonic(text, account.mnemonic)
  })

  it('does not wait: an unfunded wallet gets the exact shortfall and exit 1', async () => {
    const account = useAccount()
    const state = freshState(150_000n)
    installFakeAlgod(state)
    const io = captureIo()
    const code = await runDonor(['optin'], { io })
    const text = allText(io)
    expect(code).toBe(1)
    expect(state.submitted).toHaveLength(0)
    expect(state.requests.filter((request) => request.includes('/v2/accounts/'))).toHaveLength(1)
    expect(text).toContain('ALGO balance: 0.15 ALGO. Needed: 0.201 ALGO. Shortfall: 0.051 ALGO.')
    expect(text).toContain(`algorand://${account.address}?amount=51000`)
    expect(text).toContain('Next step. Send 0.051 ALGO to this address.')
  })

  it('counts the whole minimum for an account that algod does not know yet', async () => {
    useAccount()
    installFakeAlgod(freshState(0n))
    const io = captureIo()
    expect(await runDonor(['optin'], { io })).toBe(1)
    expect(allText(io)).toContain('Shortfall: 0.201 ALGO.')
  })

  it('is idempotent: already opted in exits 0 and sends nothing', async () => {
    useAccount()
    const state = freshState(500_000n, optedIn())
    installFakeAlgod(state)
    const io = captureIo()
    expect(await runDonor(['optin'], { io })).toBe(0)
    expect(allText(io)).toContain('already opted in')
    expect(state.submitted).toHaveLength(0)
  })

  it('rejects the removed --timeout option', async () => {
    useAccount()
    const io = captureIo()
    expect(await runDonor(['optin', '--timeout', '2'], { io })).toBe(1)
    expect(allText(io)).toContain('Usage: aupm donor')
  })

  it('reads the key file when the env var is unset', async () => {
    const account = newAccount()
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${account.mnemonic}\n`, { mode: 0o600 })
    const state = freshState(500_000n, optedIn())
    installFakeAlgod(state)
    expect(await runDonor(['optin'], { io: captureIo() })).toBe(0)
    expect(state.requests.some((request) => request.includes(account.address))).toBe(true)
  })

  it('lets the env var beat the key file', async () => {
    const fileAccount = newAccount()
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${fileAccount.mnemonic}\n`, { mode: 0o600 })
    const envAccount = useAccount()
    const state = freshState(500_000n, optedIn())
    installFakeAlgod(state)
    await runDonor(['optin'], { io: captureIo() })
    expect(state.requests.some((request) => request.includes(envAccount.address))).toBe(true)
    expect(state.requests.some((request) => request.includes(fileAccount.address))).toBe(false)
  })

  it('refuses a key file with mode 0644 and suggests chmod 600', async () => {
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${newAccount().mnemonic}\n`)
    fs.chmodSync(keyFile, 0o644)
    const io = captureIo()
    expect(await runDonor(['optin'], { io })).toBe(1)
    expect(allText(io)).toContain(`chmod 600 ${keyFile}`)
  })

  it('tells the user to run init when no key exists', async () => {
    const io = captureIo()
    expect(await runDonor(['optin'], { io })).toBe(1)
    expect(allText(io)).toContain('aupm donor init')
  })

  it('names no key word when the key is not a mnemonic', async () => {
    process.env[KEY_VAR] = 'abandon abandon abandon'
    const io = captureIo()
    expect(await runDonor(['optin'], { io })).toBe(1)
    expect(allText(io)).not.toContain('abandon')
  })
})

describe('aupm donor status', () => {
  it('says how to run init when no key exists', async () => {
    const io = captureIo()
    expect(await runDonor(['status'], { io })).toBe(1)
    expect(allText(io)).toContain('aupm donor init')
  })

  it('shows the ALGO shortfall and the ALGO step for an unfunded wallet', async () => {
    const account = useAccount()
    const state = freshState(100_000n)
    installFakeAlgod(state)
    const io = captureIo()
    expect(await runDonor(['status'], { io })).toBe(0)
    const text = allText(io)
    expect(text).toContain(`Address: ${account.address}`)
    expect(text).toContain('Network: Algorand MainNet')
    expect(text).toContain('ALGO balance: 0.1 ALGO (needed: 0.201 ALGO)')
    expect(text).toContain('USDC opt-in: not done')
    expect(text).toContain('Next step. Send 0.101 ALGO to this address.')
    expect(text).toContain(`algorand://${account.address}?amount=101000`)
    expectNoMnemonic(text, account.mnemonic)
  })

  it('names the opt-in as the next step for a funded wallet', async () => {
    useAccount()
    installFakeAlgod(freshState(300_000n))
    const io = captureIo()
    await runDonor([], { io })
    expect(allText(io)).toContain('Run `aupm donor optin`')
  })

  it('names the USDC step for an opted-in wallet with no USDC', async () => {
    const account = useAccount()
    installFakeAlgod(freshState(300_000n, optedIn()))
    const io = captureIo()
    await runDonor(['status'], { io })
    const text = allText(io)
    expect(text).toContain('USDC opt-in: done')
    expect(text).toContain('USDC balance: 0 USDC (pays for 0 reviewed packages)')
    expect(text).toContain(`algorand://${account.address}?amount=1000000&asset=${USDC}`)
  })

  it('counts the reviewed packages that the USDC pays for, in integers', async () => {
    useAccount()
    installFakeAlgod(freshState(300_000n, optedIn(2_500_500)))
    const io = captureIo()
    await runDonor(['status'], { io })
    const text = allText(io)
    expect(text).toContain('USDC balance: 2.5005 USDC (pays for 2500 reviewed packages)')
    expect(text).toContain('aupm attest package-lock.json --donate')
  })

  it('sends nothing: it only reads', async () => {
    useAccount()
    const state = freshState(300_000n)
    installFakeAlgod(state)
    await runDonor(['status'], { io: captureIo() })
    expect(state.submitted).toHaveLength(0)
    expect(state.requests.every((request) => request.startsWith('GET'))).toBe(true)
  })

  it('says that the env var wins over the file and shows the address in use', async () => {
    const fileAccount = newAccount()
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${fileAccount.mnemonic}\n`, { mode: 0o600 })
    const envAccount = useAccount()
    installFakeAlgod(freshState(300_000n))
    const io = captureIo()
    await runDonor(['status'], { io })
    const text = allText(io)
    expect(text).toContain('It wins over the key file')
    expect(text).toContain(`The address in use is: ${envAccount.address}`)
    expect(text).not.toContain(fileAccount.address)
  })

  it('reads a 0644 key file on win32 and says it is not permission-protected', async () => {
    const account = newAccount()
    fs.mkdirSync(path.dirname(keyFile), { recursive: true })
    fs.writeFileSync(keyFile, `${account.mnemonic}\n`)
    fs.chmodSync(keyFile, 0o644)
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    installFakeAlgod(freshState(300_000n))
    const io = captureIo()
    expect(await runDonor(['status'], { io })).toBe(0)
    expect(allText(io)).toContain(account.address)
    expect(allText(io)).toContain('permissions of the key file are not protected')
  })
})

describe('aupm donor on TestNet', () => {
  const NOTE = 'TestNet is for development. Put NETWORK=testnet before every aupm command,'
  type DonorModule = typeof import('./donor.js')
  let donor: DonorModule

  beforeEach(async () => {
    vi.stubEnv('NETWORK', 'testnet')
    vi.resetModules()
    donor = await import('./donor.js')
  })

  afterEach(() => {
    vi.resetModules()
  })

  it('init prints the note near the top and no dispenser or faucet', async () => {
    const io = captureIo()
    expect(await donor.runDonor(['init'], { io })).toBe(0)
    const text = allText(io)
    expect(text.indexOf(NOTE)).toBeGreaterThan(-1)
    expect(text.indexOf(NOTE)).toBeLessThan(text.indexOf('PLEASE READ'))
    expect(text).toContain('Network: Algorand TestNet')
    expect(text).toContain('ASA 10458941')
    expect(text).not.toContain('Pera Wallet')
    expectCleanSecretText(text)
  })

  it('init prints the TestNet CI commands', async () => {
    const io = captureIo()
    await donor.runDonor(['init'], { io })
    const text = allText(io)
    expect(text).toContain(`gh secret set AUPM_DONOR_MNEMONIC_TESTNET < "${keyFile}"`)
    expect(text).not.toContain('MAINNET')
  })

  it('init prints the TestNet PowerShell commands on Windows', async () => {
    vi.spyOn(process, 'platform', 'get').mockReturnValue('win32')
    const io = captureIo()
    await donor.runDonor(['init'], { io })
    const text = allText(io)
    expect(text).toContain('$env:XDG_CONFIG_HOME = "$HOME/.config/aupm-ci"')
    expect(text).toContain(`Get-Content "${keyFile}" | gh secret set AUPM_DONOR_MNEMONIC_TESTNET`)
  })

  it('optin and status print the note and the network', async () => {
    const account = useAccount()
    installFakeAlgod(freshState(150_000n))
    for (const subcommand of ['optin', 'status']) {
      const io = captureIo()
      await donor.runDonor([subcommand], { io })
      const text = allText(io)
      expect(text).toContain(NOTE)
      expect(text).toContain('set AUPM_PROXY_URL to the TestNet server.')
      expect(text).toContain('Network: Algorand TestNet')
      expect(text).toContain(account.address)
      expectCleanSecretText(text)
    }
  })

  it('MainNet prints no note', async () => {
    vi.stubEnv('NETWORK', undefined)
    vi.resetModules()
    const mainnet = await import('./donor.js')
    const io = captureIo()
    await mainnet.runDonor(['init'], { io })
    expect(allText(io)).not.toContain('TestNet')
  })
})

describe('aupm donor usage', () => {
  it('prints usage for an unknown subcommand', async () => {
    const io = captureIo()
    expect(await runDonor(['frobnicate'], { io })).toBe(1)
    expect(allText(io)).toContain('Usage: aupm donor')
  })
})
