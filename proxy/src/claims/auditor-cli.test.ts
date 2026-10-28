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
const { addAuditor, getAuditorKeys, listAuditors, planAuditorRotation, rotateAuditorKey } =
  await import('./ledger.js')
const { runAuditorCli, EXIT_OK, EXIT_REFUSED, EXIT_USAGE } = await import('./auditor-cli.js')

const ADDRESS = algosdk.generateAccount().addr.toString()
const OTHER = algosdk.generateAccount().addr.toString()
const THIRD = algosdk.generateAccount().addr.toString()
const CURRENT_ROUND = 500

function setup(answer = 'yes') {
  const out: string[] = []
  const err: string[] = []
  const deps = {
    addAuditor,
    getAuditorKeys,
    planAuditorRotation,
    rotateAuditorKey,
    listAuditors,
    getCurrentRound: async () => CURRENT_ROUND,
    prompt: async () => answer,
    now: () => 1_700_000_000_000,
    out: (line: string) => out.push(line),
    err: (line: string) => err.push(line),
  }
  return { deps, out, err }
}

beforeEach(() => {
  db.exec('DELETE FROM auditor_keys')
})

describe('auditor add', () => {
  test('writes the row after "yes", with a lower-case login', async () => {
    const { deps, out } = setup()
    expect(await runAuditorCli(['add', 'github:Alice', ADDRESS], deps)).toBe(EXIT_OK)
    expect(listAuditors()[0]).toEqual({
      identity: 'github:alice',
      review_address: ADDRESS,
      valid_from_round: 0,
      valid_until_round: null,
      added_at: 1_700_000_000_000,
    })
    expect(out).toContain(`auditor added: github:alice ${ADDRESS}`)
  })

  test('refuses a second add for the same identity and keeps the first address', async () => {
    const { deps, err } = setup()
    await runAuditorCli(['add', 'github:alice', ADDRESS], deps)
    expect(await runAuditorCli(['add', 'github:ALICE', OTHER], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('already has a review key')
    expect(getAuditorKeys('github:alice').map((row) => row.review_address)).toEqual([ADDRESS])
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
    expect(out[0]).toBe('identity\treview_address\tvalid_from_round\tvalid_until_round\tadded')
    expect(out[1]).toBe(`github:alice\t${ADDRESS}\t0\topen\t2023-11-14T22:13:20.000Z`)
  })

  test('prints a closed key with its last round and the open key after it', async () => {
    const { deps, out } = setup()
    await runAuditorCli(['add', 'github:alice', ADDRESS], deps)
    await runAuditorCli(['rotate', 'github:alice', OTHER, '--until', '120'], deps)
    out.length = 0
    await runAuditorCli(['list'], deps)
    expect(out[1]).toBe(`github:alice\t${ADDRESS}\t0\t120\t2023-11-14T22:13:20.000Z`)
    expect(out[2]).toBe(`github:alice\t${OTHER}\t121\topen\t2023-11-14T22:13:20.000Z`)
  })

  test('an unknown command is a usage error', async () => {
    const { deps } = setup()
    expect(await runAuditorCli(['remove'], deps)).toBe(EXIT_USAGE)
  })
})

describe('auditor rotate', () => {
  async function rotateSetup(answer = 'yes') {
    const ctx = setup(answer)
    await runAuditorCli(['add', 'github:alice', ADDRESS], setup().deps)
    return ctx
  }

  const rows = () =>
    getAuditorKeys('github:alice').map((row) => [
      row.review_address,
      row.valid_from_round,
      row.valid_until_round,
    ])

  test('closes the old key at the current round and opens the new key after it', async () => {
    const { deps, out } = await rotateSetup()
    expect(await runAuditorCli(['rotate', 'github:Alice', OTHER], deps)).toBe(EXIT_OK)
    expect(rows()).toEqual([
      [ADDRESS, 0, CURRENT_ROUND],
      [OTHER, CURRENT_ROUND + 1, null],
    ])
    expect(out).toContain('identity:    github:alice')
    expect(out).toContain(`old address: ${ADDRESS}`)
    expect(out).toContain(`new address: ${OTHER}`)
    expect(out.some((line) => line.startsWith(`cutoff round: ${CURRENT_ROUND}`))).toBe(true)
  })

  test('uses the round of --until as the cutoff', async () => {
    const { deps } = await rotateSetup()
    expect(await runAuditorCli(['rotate', 'github:alice', OTHER, '--until', '0'], deps)).toBe(
      EXIT_OK,
    )
    expect(rows()).toEqual([
      [ADDRESS, 0, 0],
      [OTHER, 1, null],
    ])
  })

  test('chains a second rotation from the first', async () => {
    const { deps } = await rotateSetup()
    await runAuditorCli(['rotate', 'github:alice', OTHER, '--until', '100'], deps)
    expect(await runAuditorCli(['rotate', 'github:alice', THIRD, '--until', '200'], deps)).toBe(
      EXIT_OK,
    )
    expect(rows()).toEqual([
      [ADDRESS, 0, 100],
      [OTHER, 101, 200],
      [THIRD, 201, null],
    ])
  })

  test('refuses an unknown identity', async () => {
    const { deps, err } = setup()
    expect(await runAuditorCli(['rotate', 'github:alice', OTHER], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('github:alice has no open review key')
  })

  test('refuses the address of the open key', async () => {
    const { deps, err } = await rotateSetup()
    expect(await runAuditorCli(['rotate', 'github:alice', ADDRESS], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('already the open review key')
    expect(rows()).toEqual([[ADDRESS, 0, null]])
  })

  test('refuses an address that an earlier key of the identity used', async () => {
    const { deps, err } = await rotateSetup()
    await runAuditorCli(['rotate', 'github:alice', OTHER, '--until', '100'], deps)
    expect(await runAuditorCli(['rotate', 'github:alice', ADDRESS], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('was already a review key')
    expect(rows()).toEqual([
      [ADDRESS, 0, 100],
      [OTHER, 101, null],
    ])
  })

  test('refuses --until below the start of the open key', async () => {
    const { deps, err } = await rotateSetup()
    await runAuditorCli(['rotate', 'github:alice', OTHER, '--until', '100'], deps)
    expect(await runAuditorCli(['rotate', 'github:alice', THIRD, '--until', '100'], deps)).toBe(
      EXIT_REFUSED,
    )
    expect(err.join('\n')).toContain('below 101')
    expect(rows()[1]).toEqual([OTHER, 101, null])
  })

  test('refuses --until above the current round', async () => {
    const { deps, err } = await rotateSetup()
    expect(await runAuditorCli(['rotate', 'github:alice', OTHER, '--until', '501'], deps)).toBe(
      EXIT_REFUSED,
    )
    expect(err.join('\n')).toContain('above the current round 500')
    expect(rows()).toEqual([[ADDRESS, 0, null]])
  })

  test('refuses a malformed address', async () => {
    const { deps, err } = await rotateSetup()
    expect(await runAuditorCli(['rotate', 'github:alice', 'nope'], deps)).toBe(EXIT_REFUSED)
    expect(err.join('\n')).toContain('is not an Algorand address')
  })

  test('changes nothing when the answer is not "yes"', async () => {
    const { deps, out } = await rotateSetup('y')
    expect(await runAuditorCli(['rotate', 'github:alice', OTHER], deps)).toBe(EXIT_REFUSED)
    expect(out).toContain('aborted: not rotated')
    expect(rows()).toEqual([[ADDRESS, 0, null]])
  })

  test('prints a usage error for a bad --until', async () => {
    const { deps } = await rotateSetup()
    expect(await runAuditorCli(['rotate', 'github:alice', OTHER, '--until', 'x'], deps)).toBe(
      EXIT_USAGE,
    )
    expect(await runAuditorCli(['rotate', 'github:alice'], deps)).toBe(EXIT_USAGE)
  })

  test('add and list never call the network', async () => {
    const { deps } = setup()
    deps.getCurrentRound = async () => {
      throw new Error('network used')
    }
    expect(await runAuditorCli(['add', 'github:alice', ADDRESS], deps)).toBe(EXIT_OK)
    expect(await runAuditorCli(['list'], deps)).toBe(EXIT_OK)
  })
})

describe('one open key per identity', () => {
  test('the database refuses a second open key', () => {
    addAuditor('github:alice', ADDRESS, 1)
    expect(() =>
      db
        .prepare(
          'INSERT INTO auditor_keys (identity, review_address, valid_from_round, added_at) VALUES (?, ?, ?, ?)',
        )
        .run('github:alice', OTHER, 10, 1),
    ).toThrow(/UNIQUE/)
  })

  test('addAuditor refuses an identity with only a closed key', () => {
    addAuditor('github:alice', ADDRESS, 1)
    rotateAuditorKey('github:alice', OTHER, 5, 5, 2)
    db.prepare('DELETE FROM auditor_keys WHERE valid_until_round IS NULL').run()
    expect(() => addAuditor('github:alice', THIRD, 3)).toThrow(/already has a key row/)
  })
})
