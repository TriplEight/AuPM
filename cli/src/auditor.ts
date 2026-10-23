// cli/src/auditor.ts
//
// `aupm auditor review|balance|status`. The key is typed on a hidden prompt for each
// command that signs. No key file, no env var, no flag. The network and the USDC asset id
// come from GET /api/v1/contract. The anchor goes to algod. A payout address goes to algod
// only. The CLI never sends it to the AuPM server.
import algosdk from 'algosdk'
import type { DerivationChoice } from 'aupm-mcp/key-phrase'
import {
  type AccountFacts,
  assertGenesis,
  loraLink,
  type NetworkName,
  readAccountFacts,
  sendAnchor,
} from './auditor-chain.js'
import {
  assertNoteFits,
  assertReadAllowed,
  buildScope,
  encodeReviewNote,
  FIRST_REVIEW,
} from './auditor-note.js'
import {
  type ContractInfo,
  type Earnings,
  fetchContract,
  fetchEarnings,
  fetchNpmIntegrity,
  fetchReviews,
  previousReviewedVersion,
} from './auditor-server.js'
import { type AuditorDeps, defaultDeps, normalizeLogin, promptAccount } from './auditor-terminal.js'
import { describeMicroUsdc } from './donor-text.js'

const MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
const TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='

export const AUDITOR_USAGE = [
  'Usage:',
  '  aupm auditor review <name>@<version> [--login <github-login>]',
  '      [--derivation <n> | --address <address>]',
  '  aupm auditor balance <github-login> [--address <payout-address>]',
  '  aupm auditor status <github-login>',
]

function networkOf(contract: ContractInfo): NetworkName {
  if (contract.network === MAINNET_CAIP2) return 'mainnet'
  if (contract.network === TESTNET_CAIP2) return 'testnet'
  throw new Error(`The server reports an unknown network: ${contract.network}`)
}

function missingArgument(what: string, command: string): Error {
  return new Error(`Missing ${what}. Run: aupm auditor ${command}\n${AUDITOR_USAGE.join('\n')}`)
}

function flagValue(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

function positionals(args: string[]): string[] {
  return args.filter((arg, i) => !arg.startsWith('--') && !args[i - 1]?.startsWith('--'))
}

/** Splits `name@version`. A scoped name starts with `@`, so split at the last `@`. */
export function parsePackageSpec(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf('@')
  if (at <= 0 || at === spec.length - 1) {
    throw new Error(`"${spec}" is not <name>@<version>.`)
  }
  return { name: spec.slice(0, at), version: spec.slice(at + 1) }
}

/** Reads --derivation and --address. Both apply to 24-word phrases only. */
function derivationChoice(args: string[]): DerivationChoice {
  const raw = flagValue(args, '--derivation')
  const address = flagValue(args, '--address')
  if (args.includes('--derivation') && (raw === undefined || !/^\d+$/.test(raw))) {
    throw new Error('--derivation needs a non-negative integer, for example --derivation 1.')
  }
  if (args.includes('--address') && !address) {
    throw new Error('--address needs an Algorand address.')
  }
  if (raw !== undefined && address !== undefined) {
    throw new Error('Use --derivation or --address, not both.')
  }
  return { derivation: raw === undefined ? undefined : Number(raw), address }
}

async function loginFrom(args: string[], deps: AuditorDeps): Promise<string> {
  return normalizeLogin(flagValue(args, '--login') ?? (await deps.ask('GitHub login: ')))
}

async function askRequired(deps: AuditorDeps, question: string): Promise<string> {
  const answer = (await deps.ask(`${question}: `)).trim()
  if (answer.length === 0) throw new Error(`The answer is empty. Write 'none' if there is nothing.`)
  return answer
}

async function askScope(deps: AuditorDeps, previous: string | null) {
  deps.print(`Previous reviewed version: ${previous ?? 'none (first review)'}`)
  deps.print(
    'Answer 4 questions. Keep the answers short: the whole review note must fit in 1,024 bytes.',
  )
  const coverage = await askRequired(deps, 'Coverage (for example: full source, 1 file, 162 lines)')
  const installScripts = await askRequired(deps, 'Install scripts (none, or list them)')
  const findings = await askRequired(deps, 'Findings (text, or none)')
  const changes = await askRequired(
    deps,
    `What changed since ${previous ?? 'the previous version'}? ` +
      `(Type "${FIRST_REVIEW}" if this is your first review of the package)`,
  )
  return { coverage, installScripts, findings, changes }
}

async function review(args: string[], deps: AuditorDeps): Promise<void> {
  const spec = positionals(args)[0]
  if (!spec) throw missingArgument('package', 'review <name>@<version>')
  const { name, version } = parsePackageSpec(spec)
  const account = await promptAccount(deps, derivationChoice(args))
  const login = await loginFrom(args, deps)
  const contract = await fetchContract(deps.fetch, deps.origin)
  const network = networkOf(contract)
  const algod = deps.algod(network)
  assertGenesis(network, (await algod.getTransactionParams().do()).genesisID ?? '')
  const integrity = await fetchNpmIntegrity(deps.fetch, name, version)
  const reviews = await fetchReviews(deps.fetch, deps.origin, login)
  const previous = previousReviewedVersion(reviews, name, version)
  const answers = await askScope(deps, previous)
  const scope = buildScope(answers, previous)
  assertReadAllowed(answers.coverage, scope, network === 'testnet')
  const reviewer = `github:${login}`
  const note = encodeReviewNote({ name, version, integrity, reviewer, scope })
  assertNoteFits(note)
  for (const line of [
    `package:   ${name}`,
    `version:   ${version}`,
    `integrity: ${integrity}`,
    `reviewer:  ${reviewer}`,
    `scope:     ${scope}`,
    `network:   ${network}`,
    `signer:    ${account.address}`,
  ]) {
    deps.print(line)
  }
  const question =
    'Send this review to the blockchain? It costs 0.001 ALGO and you cannot undo it. ' +
    'Type "yes" to confirm: '
  if ((await deps.ask(question)).trim() !== 'yes') {
    deps.print('Stopped. No transaction sent.')
    return
  }
  const txid = await sendAnchor(algod, account, note, network)
  deps.print(`Review recorded. Transaction: ${txid}`)
  deps.print(`Explorer: ${loraLink(network, txid)}`)
  deps.print('Post this txid in your auditor application issue.')
  deps.print(`After the ops record it, \`aupm auditor status ${login}\` shows it.`)
}

const PAYOUT_FLOOR_MICRO = 10_000n
const PAYOUT_WEEKLY_MICRO = 100_000n
const PAYOUT_NIGHTLY_MICRO = 1_000_000n

/** The payout rule that applies to a matured balance, as one sentence. */
function payoutRuleStep(matured: bigint): string {
  if (matured >= PAYOUT_NIGHTLY_MICRO) {
    return 'No action. The next nightly run pays your matured balance (1,000,000 microUSDC or more).'
  }
  if (matured >= PAYOUT_WEEKLY_MICRO) {
    return (
      'No action. The nightly run pays your matured balance when your last payout was ' +
      '7 days ago or more. Your onboarding date counts if you have no payout.'
    )
  }
  if (matured >= PAYOUT_FLOOR_MICRO) {
    return (
      'No action. The nightly run pays your matured balance when your last payout was ' +
      '30 days ago or more. Your onboarding date counts if you have no payout.'
    )
  }
  return (
    'No action. Your matured balance is below 10,000 microUSDC. ' +
    'It stays in the ledger until it reaches that floor.'
  )
}

/** The one thing the auditor does next, from the first check that fails. */
function balanceNextStep(args: {
  earnings: Earnings
  address: string | undefined
  facts: AccountFacts | null
  usdcAssetId: number
}): string {
  const { earnings, address, facts, usdcAssetId } = args
  if (!earnings.payoutAddressSet) {
    return (
      'Send your payout address to the AuPM ops in your auditor application issue. ' +
      'See docs/ONBOARDING.md, section Auditor, step 1.'
    )
  }
  if (address === undefined || facts === null) {
    return 'Run again with --address <your payout address> to check the USDC opt-in.'
  }
  if (!facts.optedIn) return `Opt in to the USDC asset ${usdcAssetId} on ${address}.`
  if (facts.frozen)
    return 'Contact the AuPM ops. The USDC holding of your payout address is frozen.'
  return payoutRuleStep(earnings.maturedUnpaidMicro)
}

function payoutAddressFlag(args: string[]): string | undefined {
  if (!args.includes('--address')) return undefined
  const address = flagValue(args, '--address')
  if (!address || !algosdk.isValidAddress(address)) {
    throw new Error('--address needs a valid Algorand address.')
  }
  return address
}

async function readPayoutHolding(
  deps: AuditorDeps,
  address: string,
): Promise<{ facts: AccountFacts; usdcAssetId: number; network: NetworkName }> {
  const contract = await fetchContract(deps.fetch, deps.origin)
  const network = networkOf(contract)
  const algod = deps.algod(network)
  try {
    assertGenesis(network, (await algod.getTransactionParams().do()).genesisID ?? '')
    const facts = await readAccountFacts(algod, address, contract.usdcAssetId)
    return { facts, usdcAssetId: contract.usdcAssetId, network }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Cannot read the payout address on the Algorand node: ${reason}`)
  }
}

function lastPayoutText(lastPayoutAt: number | null): string {
  return lastPayoutAt === null ? 'never' : new Date(lastPayoutAt).toISOString()
}

async function balance(args: string[], deps: AuditorDeps): Promise<void> {
  const raw = positionals(args)[0]
  if (!raw) throw missingArgument('GitHub login', 'balance <github-login>')
  const login = normalizeLogin(raw)
  const address = payoutAddressFlag(args)
  const earnings = await fetchEarnings(deps.fetch, deps.origin, login)
  const holding = address === undefined ? null : await readPayoutHolding(deps, address)
  const step = balanceNextStep({
    earnings,
    address,
    facts: holding?.facts ?? null,
    usdcAssetId: holding?.usdcAssetId ?? 0,
  })
  deps.print(`identity:       github:${login}`)
  deps.print(`held:           ${describeMicroUsdc(earnings.heldMicro)}`)
  deps.print(`matured unpaid: ${describeMicroUsdc(earnings.maturedUnpaidMicro)}`)
  deps.print(`frozen:         ${describeMicroUsdc(earnings.frozenMicro)}`)
  deps.print(`paid:           ${describeMicroUsdc(earnings.paidMicro)}`)
  deps.print(`last payout:    ${lastPayoutText(earnings.lastPayoutAt)}`)
  deps.print(`payout address: ${earnings.payoutAddressSet ? 'set' : 'not set'}`)
  if (holding) {
    deps.print(`USDC opt-in:    ${holding.facts.optedIn ? 'yes' : 'no'}`)
    deps.print(`USDC frozen:    ${holding.facts.frozen ? 'yes' : 'no'}`)
  }
  deps.print(`Next step: ${step}`)
}

async function status(args: string[], deps: AuditorDeps): Promise<void> {
  const raw = positionals(args)[0]
  if (!raw) throw missingArgument('GitHub login', 'status <github-login>')
  const login = normalizeLogin(raw)
  const reviews = await fetchReviews(deps.fetch, deps.origin, login)
  deps.print(`reviewer: github:${login}`)
  if (reviews.length === 0) {
    deps.print(
      `No reviews found for github:${login}. ` +
        'The ops record a review after you post its txid in your application issue.',
    )
  }
  for (const r of reviews) {
    deps.print(`${r.name}@${r.version}  ${r.status}  ${r.reviewedAt}  anchor ${r.anchorTxid}`)
    deps.print(`  scope: ${r.scope}`)
  }
}

const COMMANDS: Record<string, (args: string[], deps: AuditorDeps) => Promise<void>> = {
  review,
  balance,
  status,
}

const SIGNING = new Set(['review'])

/** Runs one auditor command. Returns the exit code. */
export async function runAuditor(
  args: string[],
  deps: AuditorDeps = defaultDeps(),
): Promise<number> {
  const [sub, ...rest] = args
  const handler = sub ? COMMANDS[sub] : undefined
  if (!sub || !handler) {
    for (const line of AUDITOR_USAGE) deps.print(line)
    return 1
  }
  try {
    if (SIGNING.has(sub) && !deps.isTTY) {
      throw new Error(
        `Refused. \`aupm auditor ${sub}\` asks for your recovery phrase on a hidden prompt. ` +
          'Run it in an interactive terminal, not in a script or a pipe.',
      )
    }
    await handler(rest, deps)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}
