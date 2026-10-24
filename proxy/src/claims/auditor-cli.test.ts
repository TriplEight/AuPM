// proxy/src/claims/auditor-cli.test.ts
//
// Nothing is stubbed except the prompt and the output. The SQLite ledger is real.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import algosdk from 'algosdk'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-auditor-cli-test-${randomUUID()}.db`)

const { default: db } = await import('./schema.js')
const { addAuditor, getAuditorReviewAddress, listAuditors } = await import('./ledger.js')
const { runAuditorCli, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } = await import('./auditor-cli.js')

const ADDRESS = algosdk.generateAccount().addr.toString()
const OTHER = algosdk.generateAccount().addr.toString()

function setup(answer = 'yes') {
  const out: string[] = []
  const err: string[] = []
  const deps = {
    addAuditor,
    getAuditorReviewAddress,
    listAuditors,
    prompt: async () => answer,
    now: () => 1_700_000_000_000,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  }
  return { deps, out, err }
}

beforeEach(() => {
  db.exec('DELETE FROM auditors')
})

describe('auditor add', () => {
  test('writes the row after "yes", with a lower-case login', async () => {
    const { deps, out } = setup()
    expect(await runAuditorCli(['add', 'github:Alice', ADDRESS], deps)).toBe(EXIT_OK)
    expect(getAuditorReviewAddress('github:alice')).toBe(ADDRESS)
    expect(listAuditors()[0]).toEqual({
      identity: 'github:alice',
      review_address: ADDRESS,
      added_at: 1_700_000_000_000,
    })
    expect(out).toContain(`auditor added: github:alice ${ADDRESS}`)
  })

  test('refuses a second add for the same identity and keeps the first address', async () => {
    const { deps, err } = setup()
    await runAuditorCli(['add', 'github:alice', ADDRESS], deps)
    expect(await runAuditorCli(['add', 'github:ALICE', OTHER], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('not supported yet')
    expect(getAuditorReviewAddress('github:alice')).toBe(ADDRESS)
  })

  test('refuses a malformed address and writes nothing', async () => {
    const { deps, err } = setup()
    expect(await runAuditorCli(['add', 'github:alice', 'not-an-address'], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('is not an Algorand address')
    expect(listAuditors()).toEqual([])
  })

  test('refuses an identity without the github: prefix', async () => {
    const { deps, err } = setup()
    expect(await runAuditorCli(['add', 'alice', ADDRESS], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('github:<login>')
    expect(listAuditors()).toEqual([])
  })

  test('writes nothing when the answer is not "yes"', async () => {
    const { deps, out } = setup('no')
    expect(await runAuditorCli(['add', 'github:alice', ADDRESS], deps)).toBe(EXIT_REFUSED)
    expect(out).toContain('aborted: not added')
    expect(listAuditors()).toEqual([])
  })

  test('prints a usage error for missing arguments', async () => {
    const { deps, err } = setup()
    expect(await runAuditorCli(['add', 'github:alice'], deps)).toBe(EXIT_USAGE)
    expect(err.join('\n')).toContain('Usage: pnpm -C proxy auditor')
  })
})

describe('auditor list', () => {
  test('prints the header and one line per auditor', async () => {
    const { deps, out } = setup()
    await runAuditorCli(['add', 'github:alice', ADDRESS], deps)
    out.length = 0
    expect(await runAuditorCli(['list'], deps)).toBe(EXIT_OK)
    expect(out[0]).toBe('identity\treview_address\tadded')
    expect(out[1]).toBe(`github:alice\t${ADDRESS}\t2023-11-14T22:13:20.000Z`)
  })

  test('an unknown command is a usage error', async () => {
    const { deps } = setup()
    expect(await runAuditorCli(['remove'], deps)).toBe(EXIT_USAGE)
  })
})
