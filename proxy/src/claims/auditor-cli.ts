// proxy/src/claims/auditor-cli.ts
//
// The logic of the auditor operator CLI. It takes the arguments and its dependencies and returns an
// exit code, so a test can run it with stubs. auditor-main.ts wires the real dependencies.

import algosdk from 'algosdk'
import type { AuditorRotationPlan } from './ledger.js'
import type { AuditorKeyRow } from './schema.js'

export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2

export const USAGE = [
  'Usage: pnpm -C proxy auditor <command>',
  '',
  'Commands:',
  '  add <github:login> <address>  Add the review address of an auditor. Asks for "yes".',
  '  rotate <github:login> <address> [--until <round>]',
  '                                Replace the review key. The old key stays valid up to the',
  '                                round --until (default: the current round). Asks for "yes".',
  '  list                          Print every review key.',
].join('\n')

export interface AuditorCliDeps {
  addAuditor: (identity: string, reviewAddress: string, addedAt: number) => void
  getAuditorKeys: (identity: string) => AuditorKeyRow[]
  planAuditorRotation: (
    identity: string,
    newAddress: string,
    untilRound: number | null,
    currentRound: number,
  ) => AuditorRotationPlan
  rotateAuditorKey: (
    identity: string,
    newAddress: string,
    untilRound: number | null,
    currentRound: number,
    addedAt: number,
  ) => AuditorRotationPlan
  listAuditors: () => AuditorKeyRow[]
  /** The current round of the chain. Only `rotate` calls it. */
  getCurrentRound: () => Promise<number>
  prompt: (question: string) => Promise<string>
  now: () => number
  out: (line: string) => void
  err: (line: string) => void
}

function usageError(deps: AuditorCliDeps, message?: string): number {
  if (message) deps.err(message)
  deps.err(USAGE)
  return EXIT_USAGE
}

function checkAddArgs(identity: string, address: string): void {
  if (!identity.startsWith('github:') || identity.length <= 'github:'.length) {
    throw new Error(`auditor add: "${identity}" must be "github:<login>"`)
  }
  if (!algosdk.isValidAddress(address)) {
    throw new Error(`auditor add: "${address}" is not an Algorand address`)
  }
}

async function addAuditorCommand(args: string[], deps: AuditorCliDeps): Promise<number> {
  const [rawIdentity, address, ...extra] = args
  if (!rawIdentity || !address || extra.length > 0) {
    return usageError(deps, 'auditor add: expected <github:login> <address>.')
  }
  const identity = rawIdentity.toLowerCase()
  try {
    checkAddArgs(identity, address)
    const existing = deps.getAuditorKeys(identity)
    if (existing.length > 0) {
      throw new Error(
        `auditor add: ${identity} already has a review key. Use "auditor rotate" to change it.`,
      )
    }
    deps.out(`identity: ${identity}`)
    deps.out(`address:  ${address}`)
    const answer = await deps.prompt('Add this auditor? Type "yes" to confirm: ')
    if (answer.trim() !== 'yes') {
      deps.out('aborted: not added')
      return EXIT_REFUSED
    }
    deps.addAuditor(identity, address, deps.now())
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error))
    return EXIT_REFUSED
  }
  deps.out(`auditor added: ${identity} ${address}`)
  return EXIT_OK
}

function parseRotateArgs(
  args: string[],
): { identity: string; address: string; until: number | null } | null {
  const [rawIdentity, address, flag, value, ...extra] = args
  if (!rawIdentity || !address || extra.length > 0) return null
  if (flag === undefined) return { identity: rawIdentity.toLowerCase(), address, until: null }
  if (flag !== '--until' || value === undefined || !/^\d+$/.test(value)) return null
  return { identity: rawIdentity.toLowerCase(), address, until: Number(value) }
}

async function rotateAuditorCommand(args: string[], deps: AuditorCliDeps): Promise<number> {
  const parsed = parseRotateArgs(args)
  if (!parsed) {
    return usageError(deps, 'auditor rotate: expected <github:login> <address> [--until <round>].')
  }
  const { identity, address, until } = parsed
  try {
    checkAddArgs(identity, address)
    const currentRound = await deps.getCurrentRound()
    const plan = deps.planAuditorRotation(identity, address, until, currentRound)
    deps.out(`identity:    ${identity}`)
    deps.out(`old address: ${plan.oldAddress}`)
    deps.out(`new address: ${address}`)
    deps.out(`cutoff round: ${plan.untilRound} (the new key starts at ${plan.untilRound + 1})`)
    const answer = await deps.prompt('Rotate this review key? Type "yes" to confirm: ')
    if (answer.trim() !== 'yes') {
      deps.out('aborted: not rotated')
      return EXIT_REFUSED
    }
    deps.rotateAuditorKey(identity, address, until, currentRound, deps.now())
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error))
    return EXIT_REFUSED
  }
  deps.out(`review key rotated: ${identity} ${address}`)
  return EXIT_OK
}

function listAuditorsCommand(deps: AuditorCliDeps): number {
  deps.out('identity\treview_address\tvalid_from_round\tvalid_until_round\tadded')
  for (const row of deps.listAuditors()) {
    const until = row.valid_until_round === null ? 'open' : String(row.valid_until_round)
    const added = new Date(row.added_at).toISOString()
    deps.out(`${row.identity}\t${row.review_address}\t${row.valid_from_round}\t${until}\t${added}`)
  }
  return EXIT_OK
}

/** Runs one auditor command and returns the process exit code. */
export async function runAuditorCli(args: string[], deps: AuditorCliDeps): Promise<number> {
  const [command, ...rest] = args
  if (command === 'add') return addAuditorCommand(rest, deps)
  if (command === 'rotate') return rotateAuditorCommand(rest, deps)
  if (command === 'list' && rest.length === 0) return listAuditorsCommand(deps)
  return usageError(deps, command ? `auditor: unknown command or arguments: ${command}` : undefined)
}
