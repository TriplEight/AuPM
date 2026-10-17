// proxy/src/claims/payee-cli.ts
//
// The logic of the payee operator CLI. It takes the arguments and its dependencies and returns an
// exit code, so a test can run it with stubs. payee-main.ts wires the real dependencies.

import type { CreditChainClient } from './credit.js'
import type { PayeeRow } from './schema.js'

export const EXIT_OK = 0
export const EXIT_REFUSED = 1
export const EXIT_USAGE = 2

export const USAGE = [
  'Usage: pnpm -C proxy payee <command>',
  '',
  'Commands:',
  '  add <identity> <address>  Check the USDC opt-in of the address, then add the payee.',
  '  list                      Print all payees.',
].join('\n')

export interface PayeeCliDeps {
  /** Checks the genesis id of the algod node against NETWORK. Throws on a mismatch. */
  assertGenesisMatches: () => Promise<void>
  client: Pick<CreditChainClient, 'checkPayoutAddress'>
  onboardPayee: (
    client: Pick<CreditChainClient, 'checkPayoutAddress'>,
    identity: string,
    address: string,
  ) => Promise<void>
  listPayees: () => PayeeRow[]
  out: (line: string) => void
  err: (line: string) => void
}

function usageError(deps: PayeeCliDeps, message?: string): number {
  if (message) deps.err(message)
  deps.err(USAGE)
  return EXIT_USAGE
}

async function addPayee(args: string[], deps: PayeeCliDeps): Promise<number> {
  const [identity, address, ...extra] = args
  if (!identity || !address || extra.length > 0) {
    return usageError(deps, 'payee add: expected <identity> <address>.')
  }
  try {
    await deps.assertGenesisMatches()
    await deps.onboardPayee(deps.client, identity, address)
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error))
    return EXIT_REFUSED
  }
  deps.out(`payee added: ${identity} ${address}`)
  return EXIT_OK
}

function listPayees(deps: PayeeCliDeps): number {
  deps.out('identity\taddress\tonboarded\tlast_check')
  for (const row of deps.listPayees()) {
    const onboarded = new Date(row.onboarded_at).toISOString()
    const checked = new Date(row.last_optin_check).toISOString()
    deps.out(`${row.identity}\t${row.payout_address}\t${onboarded}\t${checked}`)
  }
  return EXIT_OK
}

/** Runs one payee command and returns the process exit code. */
export async function runPayeeCli(args: string[], deps: PayeeCliDeps): Promise<number> {
  const [command, ...rest] = args
  if (command === 'add') return addPayee(rest, deps)
  if (command === 'list' && rest.length === 0) return listPayees(deps)
  return usageError(deps, command ? `payee: unknown command or arguments: ${command}` : undefined)
}
