// cli/src/auditor.test.ts
import algosdk from 'algosdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runAuditor } from './auditor.js'
import { balanceBoxName, identityBoxName } from './auditor-chain.js'
import { buildScope, encodeReviewNote } from './auditor-note.js'
import type { AuditorDeps } from './auditor-terminal.js'

const MAINNET = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
const TESTNET = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='
const ORIGIN = 'http://aupm.test'
const INTEGRITY = 'sha512-abc'

const auditor = algosdk.generateAccount()
const words = algosdk.secretKeyToMnemonic(auditor.sk)
const other = algosdk.generateAccount()

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
    if (question.startsWith('Send this review anchor')) return answers.shift() ?? 'no'
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

const words24 = words.split(' ').slice(0, 24).join(' ')

describe('aupm auditor review', () => {
  it('refuses with no TTY before any network call', async () => {
    captureErrors()
    const t = setup({ tty: false })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(t.fetchMock).not.toHaveBeenCalled()
    expect(errors.join()).toContain('needs a terminal')
  })

  it('refuses a 24-word phrase before any network call', async () => {
    captureErrors()
    const t = setup({ secret: words24 })
    expect(await runAuditor(['review', 'ms@1.2.0'], t.deps)).toBe(1)
    expect(t.fetchMock).not.toHaveBeenCalled()
    expect(errors.join()).toContain('24-word phrase is not supported yet')
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
    expect(t.printed.join('\n')).toContain('Previous reviewed version: 1.1.0')
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
    expect(errors.join()).toContain('not mapped')
  })

  it('refuses when the key address is not the mapped address', async () => {
    captureErrors()
    const t = setup({ ...base, mapped: other.addr.toString() })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('is not the address mapped')
    expect(t.sent).toHaveLength(0)
  })

  it('refuses below MIN_CLAIM', async () => {
    captureErrors()
    const t = setup({ ...base, balance: 99_999n })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('MIN_CLAIM')
  })

  it('refuses without the USDC opt-in', async () => {
    captureErrors()
    const t = setup({ ...base, optedIn: false })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('not opted in')
  })

  it('refuses without ALGO for the fee', async () => {
    captureErrors()
    const t = setup({ ...base, algo: 1_999n })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(errors.join()).toContain('microALGO')
  })

  it('refuses a 24-word phrase', async () => {
    captureErrors()
    const t = setup({ ...base, secret: words24 })
    expect(await runAuditor(['claim', '--login', 'alice'], t.deps)).toBe(1)
    expect(t.fetchMock).not.toHaveBeenCalled()
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
  it('balance prints the credited balance, MIN_CLAIM and the claim state', async () => {
    const t = setup({ balance: 150_000n, algo: 5_000n })
    expect(await runAuditor(['balance', 'Alice'], t.deps)).toBe(0)
    const out = t.printed.join('\n')
    expect(out).toContain('credited balance: 150000 microUSDC')
    expect(out).toContain('MIN_CLAIM:        100000 microUSDC')
    expect(out).toContain('USDC opt-in:      yes')
    expect(out).toContain('claim possible:   yes')
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
