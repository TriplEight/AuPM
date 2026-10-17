// proxy/src/claims/payee-cli.test.ts
//
// Only the algod check is stubbed. The onboarding logic and the SQLite ledger are real.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, test, vi } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-payee-cli-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { getPayee, listPayees } = await import('./ledger.js')
const { onboardPayee } = await import('./credit.js')
const { runPayeeCli, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } = await import('./payee-cli.js')

type Status = 'ok' | 'not-opted-in' | 'frozen'
const ADDRESS = algosdk.generateAccount().addr.toString()

function setup(status: Status = 'ok') {
  const out: string[] = []
  const err: string[] = []
  const checkPayoutAddress = vi.fn(async () => status)
  const deps = {
    assertGenesisMatches: vi.fn(async () => {}),
    client: { checkPayoutAddress },
    onboardPayee,
    listPayees,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  }
  return { deps, out, err, checkPayoutAddress }
}

beforeEach(() => {
  db.exec('DELETE FROM payees')
})

describe('payee add', () => {
  test('writes the payee row and prints one line', async () => {
    const { deps, out } = setup()
    expect(await runPayeeCli(['add', 'id:github:alice', ADDRESS], deps)).toBe(EXIT_OK)
    expect(getPayee('id:github:alice')?.payout_address).toBe(ADDRESS)
    expect(out).toEqual([`payee added: id:github:alice ${ADDRESS}`])
    expect(deps.assertGenesisMatches).toHaveBeenCalledOnce()
  })

  test('refuses a malformed address and writes nothing', async () => {
    const { deps, err, checkPayoutAddress } = setup()
    expect(await runPayeeCli(['add', 'id:github:alice', 'not-an-address'], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('is not an Algorand address')
    expect(checkPayoutAddress).not.toHaveBeenCalled()
    expect(listPayees()).toEqual([])
  })

  test('refuses an address that has not opted in to USDC', async () => {
    const { deps, err } = setup('not-opted-in')
    expect(await runPayeeCli(['add', 'id:github:alice', ADDRESS], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('not-opted-in')
    expect(listPayees()).toEqual([])
  })

  test('refuses a frozen address', async () => {
    const { deps, err } = setup('frozen')
    expect(await runPayeeCli(['add', 'id:github:alice', ADDRESS], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('frozen')
    expect(listPayees()).toEqual([])
  })

  test('refuses when the genesis check fails', async () => {
    const { deps, err, checkPayoutAddress } = setup()
    deps.assertGenesisMatches.mockRejectedValueOnce(new Error('genesis mismatch'))
    expect(await runPayeeCli(['add', 'id:github:alice', ADDRESS], deps)).toBe(EXIT_REFUSED)
    expect(err).toEqual(['genesis mismatch'])
    expect(checkPayoutAddress).not.toHaveBeenCalled()
  })

  test.each([[['add']], [['add', 'id:github:alice']], [['add', 'a', 'b', 'c']]])(
    'exits 2 with usage on missing or extra arguments %j',
    async (args) => {
      const { deps, err } = setup()
      expect(await runPayeeCli(args, deps)).toBe(EXIT_USAGE)
      expect(err.join('\n')).toContain('Usage:')
      expect(listPayees()).toEqual([])
    },
  )
})

describe('usage', () => {
  test('no arguments prints usage and exits 2', async () => {
    const { deps, err } = setup()
    expect(await runPayeeCli([], deps)).toBe(EXIT_USAGE)
    expect(err.join('\n')).toContain('Usage:')
  })

  test('an unknown command exits 2', async () => {
    const { deps, err } = setup()
    expect(await runPayeeCli(['remove'], deps)).toBe(EXIT_USAGE)
    expect(err.join('\n')).toContain('unknown command')
  })
})

describe('payee list', () => {
  test('prints a header and one line per payee', async () => {
    const { deps, out } = setup()
    await runPayeeCli(['add', 'id:github:alice', ADDRESS], deps)
    out.length = 0
    expect(await runPayeeCli(['list'], deps)).toBe(EXIT_OK)
    expect(out).toHaveLength(2)
    expect(out[0]).toBe('identity\taddress\tonboarded\tlast_check')
    const cells = out[1]?.split('\t') ?? []
    expect(cells[0]).toBe('id:github:alice')
    expect(cells[1]).toBe(ADDRESS)
    expect(new Date(cells[2] ?? '').getTime()).not.toBeNaN()
    expect(new Date(cells[3] ?? '').getTime()).not.toBeNaN()
  })

  test('prints only the header when there is no payee', async () => {
    const { deps, out } = setup()
    expect(await runPayeeCli(['list'], deps)).toBe(EXIT_OK)
    expect(out).toHaveLength(1)
  })
})
