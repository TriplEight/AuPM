// cli/src/auditor.test.ts
import fs from 'node:fs'
import * as ed from '@noble/ed25519'
import algosdk from 'algosdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAuditor } from './auditor.js'
import { assertGenesis, balanceBoxName, identityBoxName, sendAnchor } from './auditor-chain.js'
import { assertReadAllowed, buildScope, encodeReviewNote } from './auditor-note.js'
import { type AuditorDeps, normalizeLogin } from './auditor-terminal.js'

const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
const TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
const ORIGIN = 'http://aupm.test'
const INTEGRITY = 'sha512-abc'

const auditor = algosdk.generateAccount()
const words = algosdk.secretKeyToMnemonic(auditor.sk)
const other = algosdk.generateAccount()

// A public TestNet throwaway from a Pera Universal Wallet. It never held funds.
const universal = fs
  .readFileSync(
    new URL('../../mcp/src/__fixtures__/pera-testnet-universal.txt', import.meta.url),
    'utf8',
  )
  .trim()
const DERIVATION_0 = 'JNFVWY2Q44O3K5IYRYG5JE7ZKR4KP34JEQVGCKE7ECXKTTX7364VXFDK7M'
const DERIVATION_1 = 'XRGJY2DYXW3E3O34VFKLSA4VLUESY77Z2D6NBNKTNFBA76WM3NYKPTRH7A'
const REVIEW_ANSWERS = ['full source', 'none', 'none', 'first review', 'yes']

interface World {
  network?: string
  contractStatus?: number
  reviews?: unknown[]
  mapped?: string | null
  balance?: bigint
  optedIn?: boolean
  algo?: bigint
  answers?: string[]
  secret?: string
  tty?: boolean
}

function setup(world: World = {}) {
  const sent: Uint8Array[] = []
  const printed: string[] = []
  const answers = [...(world.answers ?? [])]
  const network = world.network ?? TESTNET
  const genesisID = network === MAINNET ? 'mainnet-v1.0' : 'testnet-v1.0'
  const mapped = world.mapped === undefined ? auditor.addr.toString() : world.mapped
  const boxes = new Map<string, Uint8Array>()
  if (mapped) boxes.set('id:github:alice', algosdk.decodeAddress(mapped).publicKey)
  if (world.balance !== undefined) {
    boxes.set('bal:github:alice', algosdk.encodeUint64(world.balance))
  }
  const algod = {
    getTransactionParams: () => ({
      do: async () => ({
        fee: 0n,
        minFee: 1000n,
        firstValid: 1n,
        lastValid: 1001n,
        genesisID,
        genesisHash: new Uint8Array(32),
        flatFee: false,
      }),
    }),
    getApplicationBoxByName: (_app: number, name: Uint8Array) => ({
      do: async () => {
        const value = boxes.get(new TextDecoder().decode(name))
        if (!value) throw Object.assign(new Error('box not found'), { status: 404 })
        return { value }
      },
    }),
    accountInformation: () => ({
      do: async () => ({
        amount: (world.algo ?? 0n) + 100_000n,
        minBalance: 100_000n,
        assets: world.optedIn === false ? [] : [{ assetId: 10458941n, amount: 0n }],
      }),
    }),
    sendRawTransaction: (bytes: Uint8Array) => ({
      do: async () => {
        sent.push(bytes)
        return { txid: 'TXID' }
      },
    }),
    status: () => ({ do: async () => ({ lastRound: 1n }) }),
    pendingTransactionInformation: () => ({ do: async () => ({ confirmedRound: 2n }) }),
  }
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    const u = String(url)
    if (u.endsWith('/api/v1/contract')) {
      const status = world.contractStatus ?? 200
      const body =
        status === 200
          ? {
              network,
              appId: 77,
              payTo: other.addr.toString(),
              usdcAssetId: 10458941,
              minClaim: 100000,
            }
          : { error: 'contract not configured' }
      return new Response(JSON.stringify(body), { status })
    }
    if (u.includes('/api/v1/reviews')) {
      return new Response(
        JSON.stringify({ reviewer: 'github:alice', reviews: world.reviews ?? [] }),
      )
    }
    if (u.startsWith('https://registry.npmjs.org/')) {
      return new Response(
        JSON.stringify({ versions: { '1.2.0': { dist: { integrity: INTEGRITY } } } }),
      )
    }
    return new Response('{}', { status: 404 })
  })
  const ask = vi.fn(async (question: string) => {
    if (question.startsWith('GitHub login')) return 'Alice'
    if (question.startsWith('Send this review')) return answers.shift() ?? 'no'
    return answers.shift() ?? ''
  })
  const deps: AuditorDeps = {
    isTTY: world.tty ?? true,
    ask,
    askSecret: vi.fn(async () => world.secret ?? words),
    print: (line) => printed.push(line),
    fetch: fetchMock as unknown as typeof fetch,
    algod: () => algod as unknown as algosdk.Algodv2,
    origin: ORIGIN,
  }
  return { deps, sent, printed, fetchMock }
}

let errors: string[]
function captureErrors() {
  errors = []
  vi.spyOn(console, 'error').mockImplementation((message) => {
    errors.push(String(message))
  })
}
afterEach(() => vi.restoreAllMocks())

describe('aupm auditor review', () => {
  it('refuses with no TTY before any network call', async () => {
    captureErrors()
    const t = setup({ tty: false })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(t.fetchMock).not.toHaveBeenCalled()
    expect(errors.join()).toContain('asks for your recovery phrase on a hidden prompt')
    expect(errors.join()).toContain('not in a script or a pipe')
  })

  it('signs with derivation 1 of a 24-word phrase by default', async () => {
    const t = setup({ secret: universal, mapped: DERIVATION_1, answers: REVIEW_ANSWERS })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(0)
    const signed = algosdk.decodeSignedTransaction(t.sent[0])
    expect(signed.txn.sender.toString()).toBe(DERIVATION_1)
    const publicKey = algosdk.decodeAddress(DERIVATION_1).publicKey
    expect(
      await ed.verifyAsync(signed.sig as Uint8Array, signed.txn.bytesToSign(), publicKey),
    ).toBe(true)
  })

  it('signs with --derivation 0 and with --address', async () => {
    const byDerivation = setup({ secret: universal, mapped: DERIVATION_0, answers: REVIEW_ANSWERS })
    const args = ['review', 'ms@1.2.0']
    expect(await runAuditor([...args, '--derivation', '0'], byDerivation.deps)).toBe(0)
    expect(algosdk.decodeSignedTransaction(byDerivation.sent[0]).txn.sender.toString()).toBe(
      DERIVATION_0,
    )
    const byAddress = setup({ secret: universal, mapped: DERIVATION_0, answers: REVIEW_ANSWERS })
    expect(await runAuditor([...args, '--address', DERIVATION_0], byAddress.deps)).toBe(0)
    expect(algosdk.decodeSignedTransaction(byAddress.sent[0]).txn.sender.toString()).toBe(
      DERIVATION_0,
    )
  })

  it('refuses a derivation that is not the mapped address and sends nothing', async () => {
    captureErrors()
    const t = setup({ secret: universal, mapped: DERIVATION_1, answers: REVIEW_ANSWERS })
    expect(await runAuditor(['review', 'ms@1.2.0', '--derivation', '0'], t.deps)).toBe(1)
    expect(errors.join()).toContain('The phrase you typed belongs to address')
    expect(t.sent).toHaveLength(0)
  })

  it.each([
    [['--derivation', '1', '--address', DERIVATION_1], 'not both'],
    [['--derivation', 'x'], 'non-negative integer'],
    [['--derivation'], 'non-negative integer'],
    [['--address'], 'needs an Algorand address'],
  ])('refuses the flags %j before the key prompt', async (flags, message) => {
    captureErrors()
    const t = setup({ secret: universal })
    expect(await runAuditor(['review', 'ms@1.2.0', ...flags], t.deps)).toBe(1)
    expect(errors.join()).toContain(message)
    expect(t.deps.askSecret).not.toHaveBeenCalled()
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses the flags with a 25-word key before any network call', async () => {
    captureErrors()
    const t = setup({ answers: REVIEW_ANSWERS })
    expect(await runAuditor(['review', 'ms@1.2.0', '--derivation', '1'], t.deps)).toBe(1)
    expect(errors.join()).toContain('apply to 24-word Universal Wallet phrases only')
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses a 24-word phrase with a bad checksum and does not echo the words', async () => {
    captureErrors()
    const t = setup({ secret: 'abandon '.repeat(24).trim() })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toBe(
      'The 24 words are not a valid Universal Wallet phrase. Check each word.',
    )
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses 23 words and names both formats', async () => {
    captureErrors()
    const t = setup({ secret: universal.split(' ').slice(0, 23).join(' ') })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toContain('25-word Algorand mnemonic or a 24-word Universal Wallet')
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an unread coverage on MainNet', async () => {
    captureErrors()
    const t = setup({
      network: MAINNET,
      answers: ['unread, skimmed', 'none', 'none', 'first review'],
    })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toContain('TestNet only')
    expect(t.sent).toHaveLength(0)
  })

  it('refuses a note over 1,024 bytes and says how many bytes to cut', async () => {
    captureErrors()
    const t = setup({ answers: ['x'.repeat(1100), 'none', 'none', 'first review'] })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toMatch(/Cut \d+ bytes/)
    expect(t.sent).toHaveLength(0)
  })

  it('refuses an empty answer', async () => {
    captureErrors()
    const t = setup({ answers: ['full source', '', 'none', 'first review'] })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toContain("Write 'none'")
  })

  it('refuses an unmapped login and sends nothing', async () => {
    captureErrors()
    const t = setup({
      mapped: null,
      answers: ['full source', 'none', 'none', 'first review', 'yes'],
    })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toContain('No wallet address is linked to the GitHub login alice.')
    expect(t.sent).toHaveLength(0)
  })

  it('refuses a key that is not the mapped address and sends nothing', async () => {
    captureErrors()
    const t = setup({
      mapped: other.addr.toString(),
      answers: ['full source', 'none', 'none', 'first review', 'yes'],
    })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toContain('The phrase you typed belongs to address')
    expect(t.sent).toHaveLength(0)
  })

  it('stops on a server 503', async () => {
    captureErrors()
    const t = setup({ contractStatus: 503 })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(errors.join()).toContain('503')
  })

  it('sends no transaction without yes', async () => {
    const t = setup({ answers: ['full source', 'none', 'none', 'first review', 'no'] })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(0)
    expect(t.sent).toHaveLength(0)
  })

  it('sends a 0-ALGO self-payment whose note equals scripts/review-anchor.mjs', async () => {
    const t = setup({
      answers: ['full source, 1 file', 'none', 'none', 'bumped dep', 'yes'],
      reviews: [
        {
          name: 'ms',
          version: '1.1.0',
          status: 'COMMUNITY_REVIEWED',
          scope: 's',
          anchorTxid: 'A',
          reviewedAt: '2026-01-01',
        },
      ],
    })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(0)
    const txn = algosdk.decodeSignedTransaction(t.sent[0]).txn
    const mod = await import(new URL('../../scripts/review-anchor.mjs', import.meta.url).href)
    const expected = mod.encodeReviewNote({
      name: 'ms',
      version: '1.2.0',
      integrity: INTEGRITY,
      reviewer: 'github:alice',
      scope:
        'read: full source, 1 file; install scripts: none; findings: none; since 1.1.0: bumped dep',
    })
    expect(Array.from(txn.note ?? [])).toEqual(Array.from(expected))
    expect(txn.payment?.amount).toBe(0n)
    expect(txn.sender.toString()).toBe(txn.payment?.receiver.toString())
    const out = t.printed.join('\n')
    expect(out).toContain('Previous reviewed version: 1.1.0')
    expect(out).toContain('Answer 4 questions.')
    expect(out).toMatch(/Review recorded\. Transaction: [A-Z2-7]{52}/)
    expect(out).toContain('Post this txid in your auditor application issue.')
    expect(out).toContain('`aupm auditor status alice` shows it.')
    expect(t.printed.join('\n')).toMatch(
      /Explorer: https:\/\/lora\.algokit\.io\/testnet\/transaction\/[A-Z2-7]{52}/,
    )
  })
})

describe('review note and scope', () => {
  const answers = {
    coverage: 'full source',
    installScripts: 'none',
    findings: 'none',
    changes: 'first review',
  }

  it('formats the scope for a first review and for a later review', () => {
    const head = 'read: full source; install scripts: none; findings: none;'
    expect(buildScope(answers, null)).toBe(`${head} first review`)
    expect(buildScope({ ...answers, changes: 'new flag' }, '1.0.0')).toBe(
      `${head} since 1.0.0: new flag`,
    )
    expect(buildScope(answers, '1.0.0')).toBe(`${head} first review`)
  })

  it('encodes the note as aupm:j and the JSON of the fields in order', () => {
    const note = encodeReviewNote({
      name: '@a/b',
      version: '1.0.0',
      integrity: 'i',
      reviewer: 'github:x',
      scope: 's',
    })
    expect(new TextDecoder().decode(note)).toBe(
      'aupm:j{"v":1,"name":"@a/b","version":"1.0.0","integrity":"i","reviewer":"github:x","scope":"s"}',
    )
  })
})

describe('aupm auditor claim', () => {
  const base = { balance: 150_000n, algo: 5_000n }

  it('refuses with no TTY', async () => {
    captureErrors()
    const t = setup({ ...base, tty: false })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(t.fetchMock).not.toHaveBeenCalled()
  })

  it('refuses an unmapped login', async () => {
    captureErrors()
    const t = setup({ ...base, mapped: null })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('No wallet address is linked to the GitHub login alice.')
  })

  it('refuses when the key address is not the mapped address', async () => {
    captureErrors()
    const t = setup({ ...base, mapped: other.addr.toString() })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('The phrase you typed belongs to address')
    expect(t.sent).toHaveLength(0)
  })

  it('refuses below MIN_CLAIM', async () => {
    captureErrors()
    const t = setup({ ...base, balance: 99_999n })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toBe(
      'Your balance is 99,999 microUSDC (0.099999 USDC). ' +
        'The minimum claim is 100,000 microUSDC (0.1 USDC). ' +
        'Wait for more donations. Check with: aupm auditor balance alice',
    )
  })

  it('refuses without the USDC opt-in', async () => {
    captureErrors()
    const t = setup({ ...base, optedIn: false })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('has not opted in to USDC (asset id 10458941).')
    expect(errors.join()).toContain('Opt in with your wallet app.')
    expect(errors.join()).not.toContain('donor optin')
  })

  it('refuses without ALGO for the fee', async () => {
    captureErrors()
    const t = setup({ ...base, algo: 1_500n })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('has 0.0015 ALGO free. The claim fee is 0.002 ALGO.')
    expect(errors.join()).toContain('Send at least 0.0005 ALGO to')
  })

  it('claims with derivation 1 of a 24-word phrase by default', async () => {
    const t = setup({ ...base, secret: universal, mapped: DERIVATION_1 })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(0)
    expect(algosdk.decodeSignedTransaction(t.sent[0]).txn.sender.toString()).toBe(DERIVATION_1)
  })

  it('claims with --address of a 24-word phrase', async () => {
    const t = setup({ ...base, secret: universal, mapped: DERIVATION_0 })
    expect(await runAuditor(['claim', '--login', 'alice', '--address', DERIVATION_0], t.deps)).toBe(
      0,
    )
    expect(algosdk.decodeSignedTransaction(t.sent[0]).txn.sender.toString()).toBe(DERIVATION_0)
  })

  it('refuses an --address that no derivation gives', async () => {
    captureErrors()
    const t = setup({ ...base, secret: universal })
    const unknown = other.addr.toString()
    expect(await runAuditor(['claim', '--login', 'alice', '--address', unknown], t.deps)).toBe(1)
    expect(errors.join()).toContain('No derivation from 0 to 19')
    expect(t.sent).toHaveLength(0)
  })

  it('sends one claim call with the pooled outer fee and the box references', async () => {
    const t = setup(base)
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(0)
    expect(t.sent).toHaveLength(1)
    const txn = algosdk.decodeSignedTransaction(t.sent[0]).txn
    expect(txn.fee).toBe(2000n)
    expect(txn.applicationCall?.appIndex).toBe(77n)
    expect(txn.applicationCall?.boxes.map((b) => new TextDecoder().decode(b.name))).toEqual([
      new TextDecoder().decode(identityBoxName('github:alice')),
      new TextDecoder().decode(balanceBoxName('github:alice')),
    ])
  })
})

describe('aupm auditor balance and status', () => {
  it('balance prints the credited balance, the minimum claim and the claim state', async () => {
    const t = setup({ balance: 150_000n, algo: 5_000n })
    expect(await runAuditor(['balance', 'Alice'], t.deps)).toBe(0)
    const out = t.printed.join('\n')
    expect(out).toContain('credited balance: 150000 microUSDC')
    expect(out).toContain('minimum claim:    100000 microUSDC')
    expect(out).not.toContain('MIN_CLAIM')
    expect(out).toContain('USDC opt-in:      yes')
    expect(out).toContain('claim possible:   yes')
    expect(out).toContain('Next step: Run: aupm auditor claim')
    expect(t.deps.askSecret).not.toHaveBeenCalled()
  })

  it('balance needs a login', async () => {
    captureErrors()
    const t = setup()
    expect(await runAuditor(['balance'], t.deps)).toBe(1)
  })

  it('balance stops on a server 503', async () => {
    captureErrors()
    const t = setup({ contractStatus: 503 })
    expect(await runAuditor(['balance', 'alice'], t.deps)).toBe(1)
  })

  it('status lists the reviews', async () => {
    const t = setup({
      reviews: [
        {
          name: 'ms',
          version: '1.2.0',
          status: 'COMMUNITY_REVIEWED',
          scope: 'read: x',
          anchorTxid: 'AA',
          reviewedAt: '2026-10-01',
        },
      ],
    })
    expect(await runAuditor(['status', 'alice'], t.deps)).toBe(0)
    expect(t.printed.join('\n')).toContain('ms@1.2.0  COMMUNITY_REVIEWED')
    expect(String(t.fetchMock.mock.calls[0][0])).toBe(`${ORIGIN}/api/v1/reviews?reviewer=alice`)
  })
})

describe('auditor messages', () => {
  it.each([
    [['review'], 'Missing package. Run: aupm auditor review <name>@<version>'],
    [['balance'], 'Missing GitHub login. Run: aupm auditor balance <github-login>'],
    [['status'], 'Missing GitHub login. Run: aupm auditor status <github-login>'],
  ])('names the missing item for %j', async (argv, line) => {
    captureErrors()
    const t = setup()
    expect(await runAuditor(argv, t.deps)).toBe(1)
    expect(errors.join().split('\n')[0]).toBe(line)
    expect(errors.join()).toContain('Usage:')
  })

  it('asks the review question with the cost and the questions with their rule', async () => {
    const t = setup({ answers: ['full source', 'none', 'none', 'first review', 'no'] })
    await runAuditor(['review', 'ms@1.2.0'], t.deps)
    const questions = vi.mocked(t.deps.ask).mock.calls.map((call) => call[0])
    expect(questions).toContain(
      'Send this review to the blockchain? It costs 0.001 ALGO and you cannot undo it. ' +
        'Type "yes" to confirm: ',
    )
    expect(questions).toContain(
      'What changed since the previous version? ' +
        '(Type "first review" if this is your first review of the package): ',
    )
    expect(t.printed.join('\n')).toContain('must fit in 1,024 bytes')
  })

  it('asks for the recovery phrase on the hidden prompt', async () => {
    const t = setup({ answers: ['full source', 'none', 'none', 'first review', 'no'] })
    await runAuditor(['review', 'ms@1.2.0'], t.deps)
    expect(t.deps.askSecret).toHaveBeenCalledWith(
      'Recovery phrase (24 or 25 words). The screen shows nothing while you type. ' +
        'AuPM does not store it: ',
    )
  })

  it('names the server and the reason when the network fails', async () => {
    captureErrors()
    const t = setup()
    t.deps.fetch = vi.fn(async () => {
      throw new TypeError('fetch failed', { cause: new Error('getaddrinfo ENOTFOUND aupm.test') })
    }) as unknown as typeof fetch
    expect(await runAuditor(['status', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toBe(
      'Cannot reach the AuPM server (http://aupm.test): getaddrinfo ENOTFOUND aupm.test. ' +
        'Check your network and try again.',
    )
  })

  it('names the HTTP status of a server error', async () => {
    captureErrors()
    const t = setup({ contractStatus: 502 })
    expect(await runAuditor(['balance', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('The AuPM server answered 502')
    expect(errors.join()).toContain('Try again later.')
  })

  it('tells the user to update the CLI when the answer has the wrong shape', async () => {
    captureErrors()
    const t = setup()
    t.deps.fetch = vi.fn(async () => new Response('{}')) as unknown as typeof fetch
    expect(await runAuditor(['status', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('Update the CLI: npm install -g aupm-cli.')
  })

  it('says that npm has no package on a 404', async () => {
    captureErrors()
    const t = setup()
    const inner = t.deps.fetch
    t.deps.fetch = vi.fn(async (url: string | URL | Request) =>
      String(url).startsWith('https://registry.npmjs.org/')
        ? new Response('{}', { status: 404 })
        : inner(url),
    ) as unknown as typeof fetch
    expect(await runAuditor(['review', 'nope@1.0.0'], t.deps)).toBe(1)
    expect(errors.join()).toContain('npm has no package "nope". Check the spelling.')
  })

  it('names the rule of a GitHub login', () => {
    expect(() => normalizeLogin('bad_login!')).toThrow(
      '"bad_login!" is not a valid GitHub login. Use letters, digits and hyphens only. ' +
        'Maximum 39 characters.',
    )
  })

  it('explains the unread rule without an ADR number', () => {
    expect(() => assertReadAllowed('unread', 'unread', false)).toThrow(
      'Refused. A review that says "unread" works on TestNet only. Read the package. ' +
        'Then describe what you read.',
    )
  })

  it('names the Algorand node and the fix when the network differs', () => {
    expect(() => assertGenesis('mainnet', 'testnet-v1.0')).toThrow(
      'The Algorand node is on network "testnet-v1.0". The AuPM server uses mainnet. ' +
        'Unset ALGOD_MAINNET_URL and ALGOD_TESTNET_URL, or set them to a mainnet node.',
    )
  })

  it('links the explorer when the confirmation fails', async () => {
    const algod = {
      getTransactionParams: () => ({
        do: async () => ({
          fee: 0n,
          minFee: 1000n,
          firstValid: 1n,
          lastValid: 1001n,
          genesisID: 'testnet-v1.0',
          genesisHash: new Uint8Array(32),
          flatFee: false,
        }),
      }),
      sendRawTransaction: () => ({ do: async () => ({ txid: 'X' }) }),
      status: () => ({ do: async () => ({ lastRound: 1n }) }),
      pendingTransactionInformation: () => ({ do: async () => ({ poolError: 'late' }) }),
    }
    const account = await (await import('aupm-mcp/key-phrase')).accountFromPhrase(words)
    await expect(
      sendAnchor(algod as unknown as algosdk.Algodv2, account, new Uint8Array(), 'testnet'),
    ).rejects.toThrow(
      /The transaction was sent but is not confirmed yet\. Check https:\/\/lora\.algokit\.io\/testnet\/transaction\/[A-Z2-7]{52} before you send it again\./,
    )
  })
})

describe('aupm auditor balance next step', () => {
  it.each([
    [{ mapped: null }, 'Next step: Ask the AuPM ops to link your address.'],
    [
      { balance: 90_000n, algo: 5_000n },
      'Next step: Wait. You can claim from 100,000 microUSDC (0.1 USDC).',
    ],
    [
      { balance: 150_000n, algo: 5_000n, optedIn: false },
      'Next step: Opt in to USDC with your wallet app.',
    ],
    [{ balance: 150_000n, algo: 1_000n }, `Next step: Send 0.002 ALGO to ${auditor.addr}.`],
  ])('prints the step for case %#', async (world, line) => {
    const t = setup(world)
    expect(await runAuditor(['balance', 'alice'], t.deps)).toBe(0)
    const out = t.printed.join('\n')
    expect(out.split('\n').at(-1)).toBe(line)
    expect(out).toContain('claim possible:   no')
  })

  it('names the ops when no address is linked', async () => {
    const t = setup({ mapped: null })
    await runAuditor(['balance', 'alice'], t.deps)
    expect(t.printed.join('\n')).toContain('none (the AuPM ops must link it)')
  })
})

describe('aupm auditor claim and status texts', () => {
  it('prints the value in USDC and where the USDC goes', async () => {
    const t = setup({ balance: 150_000n, algo: 5_000n })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(0)
    const out = t.printed.join('\n')
    expect(out).toContain(
      `Claiming 150,000 microUSDC (0.15 USDC) for github:alice. The USDC goes to ${auditor.addr}.`,
    )
    expect(out).toMatch(/Claimed\. The USDC is in your wallet\. Transaction: [A-Z2-7]{52}/)
  })

  it('says why there are no reviews and what to do', async () => {
    const t = setup()
    expect(await runAuditor(['status', 'alice'], t.deps)).toBe(0)
    expect(t.printed.join('\n')).toContain(
      'No reviews found for github:alice. ' +
        'The ops record a review after you post its txid in your application issue.',
    )
  })
})
