// cli/src/auditor.ts
//
// `aupm auditor review|balance|claim|status`. The key is typed on a hidden prompt for each
// command that signs (ADR 0028). No key file, no env var, no flag. The app id and the payTo
// address come from GET /api/v1/contract. The anchor and the claim go to algod.
import type { DerivationChoice } from 'aupm-mcp/key-phrase'
import {
  type AccountFacts,
  assertClaimable,
  assertGenesis,
  assertMappedSigner,
  loraLink,
  MIN_CLAIM_FEE,
  type NetworkName,
  readAccountFacts,
  readBalance,
  readMappedAddress,
  sendAnchor,
  sendClaim,
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
  fetchContract,
  fetchNpmIntegrity,
  fetchReviews,
  previousReviewedVersion,
} from './auditor-server.js'
import { type AuditorDeps, defaultDeps, normalizeLogin, promptAccount } from './auditor-terminal.js'
import { describeMicroUsdc, formatMicro } from './donor-text.js'

const MAINNET_CAIP2 = 'algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8='
const TESTNET_CAIP2 = 'algorand:SGO1GKSzyE7IEPItTxCByw9x8FmnrCDexi9/cOUJOiI='

export const AUDITOR_USAGE = [
  'Usage:',
  '  aupm auditor review <name>@<version> [--login <github-login>]',
  '      [--derivation <n> | --address <address>]',
  '  aupm auditor balance <github-login>',
  '  aupm auditor claim [--login <github-login>] [--derivation <n> | --address <address>]',
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

/** Reads --derivation and --address. Both apply to 24-word phrases only (ADR 0028). */
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
  const mapped = await readMappedAddress(algod, contract.appId, `github:${login}`)
  assertMappedSigner(mapped, account.address, login)
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

async function chainFacts(deps: AuditorDeps, login: string) {
  const contract = await fetchContract(deps.fetch, deps.origin)
  const network = networkOf(contract)
  const algod = deps.algod(network)
  const identity = `github:${login}`
  const mapped = await readMappedAddress(algod, contract.appId, identity)
  const balance = await readBalance(algod, contract.appId, identity)
  const facts: AccountFacts | null = mapped
    ? await readAccountFacts(algod, mapped, contract.usdcAssetId)
    : null
  return { contract, network, algod, identity, mapped, balance, facts }
}

const CLAIM_STEP = 'Run: aupm auditor claim'

/** The one thing the auditor does next, from the first check that fails. */
function claimNextStep(args: {
  mapped: string | null
  credited: bigint
  minClaim: number
  facts: AccountFacts | null
}): string {
  const { mapped, credited, minClaim, facts } = args
  if (mapped === null || facts === null) return 'Ask the AuPM ops to link your address.'
  if (credited < BigInt(minClaim)) {
    return `Wait. You can claim from ${describeMicroUsdc(BigInt(minClaim))}.`
  }
  if (!facts.optedIn) return 'Opt in to USDC with your wallet app.'
  if (facts.algoAvailable < BigInt(MIN_CLAIM_FEE)) {
    return `Send ${formatMicro(BigInt(MIN_CLAIM_FEE))} ALGO to ${mapped}.`
  }
  return CLAIM_STEP
}

async function balance(args: string[], deps: AuditorDeps): Promise<void> {
  const raw = positionals(args)[0]
  if (!raw) throw missingArgument('GitHub login', 'balance <github-login>')
  const login = normalizeLogin(raw)
  const { contract, network, mapped, balance: credited, facts } = await chainFacts(deps, login)
  const step = claimNextStep({ mapped, credited, minClaim: contract.minClaim, facts })
  deps.print(`identity:         github:${login}`)
  deps.print(`network:          ${network}`)
  deps.print(`mapped address:   ${mapped ?? 'none (the AuPM ops must link it)'}`)
  deps.print(`credited balance: ${credited} microUSDC`)
  deps.print(`minimum claim:    ${contract.minClaim} microUSDC`)
  deps.print(`USDC opt-in:      ${facts ? (facts.optedIn ? 'yes' : 'no') : 'unknown'}`)
  deps.print(
    `ALGO for the fee: ${facts ? `${facts.algoAvailable} microALGO available` : 'unknown'}`,
  )
  deps.print(`claim possible:   ${step === CLAIM_STEP ? 'yes' : 'no'}`)
  deps.print(`Next step: ${step}`)
}

async function claim(args: string[], deps: AuditorDeps): Promise<void> {
  const account = await promptAccount(deps, derivationChoice(args))
  const login = await loginFrom(args, deps)
  const state = await chainFacts(deps, login)
  const signer = account.address
  assertGenesis(state.network, (await state.algod.getTransactionParams().do()).genesisID ?? '')
  assertClaimable({
    balance: state.balance,
    minClaim: state.contract.minClaim,
    mapped: state.mapped,
    signer,
    login,
    usdcAssetId: state.contract.usdcAssetId,
    facts: state.facts ?? { optedIn: false, algoAvailable: 0n },
  })
  deps.print(
    `Claiming ${describeMicroUsdc(state.balance)} for ${state.identity}. The USDC goes to ${signer}.`,
  )
  const txid = await sendClaim(state.algod, account, {
    appId: state.contract.appId,
    identity: state.identity,
    payTo: state.contract.payTo,
    usdcAssetId: state.contract.usdcAssetId,
    network: state.network,
  })
  deps.print(`Claimed. The USDC is in your wallet. Transaction: ${txid}`)
  deps.print(`Explorer: ${loraLink(state.network, txid)}`)
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
  claim,
  status,
}

const SIGNING = new Set(['review', 'claim'])

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
