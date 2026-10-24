// proxy/src/claims/auditor-cli.ts
//
// The logic of the auditor operator CLI. It takes the arguments and its dependencies and returns an
// exit code, so a test can run it with stubs. auditor-main.ts wires the real dependencies.

import algosdk from 'algosdk'
import type { AuditorRow } from './schema.js'

export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2

export const USAGE = [
  'Usage: pnpm -C proxy auditor <command>',
  '',
  'Commands:',
  '  add <github:login> <address>  Add the review address of an auditor. Asks for "yes".',
  '  list                          Print all auditors.',
].join('\n')

export interface AuditorCliDeps {
  addAuditor: (identity: string, reviewAddress: string, addedAt: number) => void
  getAuditorReviewAddress: (identity: string) => string | null
  listAuditors: () => AuditorRow[]
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
    const existing = deps.getAuditorReviewAddress(identity)
    if (existing !== null) {
      throw new Error(
        `auditor add: ${identity} already has the review address ${existing}. ` +
          'A change of address is not supported yet.',
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

function listAuditorsCommand(deps: AuditorCliDeps): number {
  deps.out('identity\treview_address\tadded')
  for (const row of deps.listAuditors()) {
    deps.out(`${row.identity}\t${row.review_address}\t${new Date(row.added_at).toISOString()}`)
  }
  return EXIT_OK
}

/** Runs one auditor command and returns the process exit code. */
export async function runAuditorCli(args: string[], deps: AuditorCliDeps): Promise<number> {
  const [command, ...rest] = args
  if (command === 'add') return addAuditorCommand(rest, deps)
  if (command === 'list' && rest.length === 0) return listAuditorsCommand(deps)
  return usageError(deps, command ? `auditor: unknown command or arguments: ${command}` : undefined)
}
