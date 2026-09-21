#!/usr/bin/env node

// scripts/payout.ts
//
// Manual, batched payout runner for the SPM claims ledger (SPEC.md 5.3
// step 5, CLAUDE.md "pool-account mnemonics are cold").
//
// WARNING: dry-run by default. Without --execute this script only reads the
// ledger and prints the batch it would pay; it signs and submits nothing.
//
// WARNING: this script never reads a pool mnemonic from an environment
// variable or a dotfile. Pool keys are cold — they never live on the server
// or in that dotfile. Pass --key-file with an explicit path to a local
// mnemonic file to sign a real payout. No environment-variable read touches
// a mnemonic anywhere in this file.
//
// Run with: node --experimental-strip-types scripts/payout.ts [options]

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const proxyRoot = path.join(__dirname, '..', 'proxy')

// This script lives outside the proxy pnpm workspace package, so it has no
// node_modules of its own. Anchor `require` at proxy/package.json to reach
// the dependencies already installed there (better-sqlite3, algosdk)
// without adding a new dependency declaration anywhere.
const proxyRequire = createRequire(path.join(proxyRoot, 'package.json'))

const HELP = `spm-payout — manual, batched claims payout (dry-run by default)

Usage:
  node --experimental-strip-types scripts/payout.ts [options]

Options:
  --db <path>        Path to the SQLite ledger file.
                      Default: $SQLITE_PATH, or proxy/audit.db.
  --execute           Sign and print a submittable batch. Default: dry-run —
                      prints the batch and exits without touching a key.
  --key-file <path>   Local file holding the pool mnemonic. Required with
                      --execute. Never read from an environment variable or
                      from .env — pool keys are cold (CLAUDE.md).
  --help              Show this help and exit.

WARNING: --execute signs a real MainNet USDC transfer from a pool account.
Pool keys are cold. A human runs this locally with --key-file pointing at an
offline mnemonic file, after checking each claim by hand (SPEC.md 5.3
step 5). The recipient address must be opted into USDC 31566704 first.

Dry run is the default so this script is always safe to run to inspect the
current batch.
`

interface CliArgs {
  db?: string
  execute: boolean
  keyFile?: string
  help: boolean
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { execute: false, help: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--help' || arg === '-h') args.help = true
    else if (arg === '--execute') args.execute = true
    else if (arg === '--db') args.db = argv[++i]
    else if (arg === '--key-file') args.keyFile = argv[++i]
  }
  return args
}

interface PayoutLine {
  identity: string
  role: string
  algorandAddress: string
  amountMicro: number
}

interface BetterSqlite3Database {
  prepare<T = unknown>(
    sql: string,
  ): {
    all(...params: unknown[]): T[]
    get(...params: unknown[]): T | undefined
    run(...params: unknown[]): unknown
  }
  close(): void
}

/**
 * A claim is payable when it is verified and its accrued-minus-already-paid
 * balance for a role is positive. WARNING: never use floating point for
 * amounts — every arithmetic step here stays in integer micro-units.
 */
function buildPayoutBatch(db: BetterSqlite3Database): PayoutLine[] {
  const accrued = db
    .prepare<{ identity: string; role: string; total: number }>(
      'SELECT identity, role, SUM(amount_micro) as total FROM accruals GROUP BY identity, role',
    )
    .all()

  const paid = db
    .prepare<{ identity: string; role: string; total: number }>(
      'SELECT identity, role, SUM(amount_micro) as total FROM payouts GROUP BY identity, role',
    )
    .all()
  const paidByKey = new Map<string, number>()
  for (const row of paid) paidByKey.set(`${row.identity}\u0000${row.role}`, row.total)

  const verifiedClaims = db
    .prepare<{ identity: string; algorand_address: string }>(
      "SELECT identity, algorand_address FROM claims WHERE status = 'verified'",
    )
    .all()
  const addressByIdentity = new Map(verifiedClaims.map((c) => [c.identity, c.algorand_address]))

  const batch: PayoutLine[] = []
  for (const row of accrued) {
    if (row.identity === 'unassigned') continue // no claimant to pay yet
    const algorandAddress = addressByIdentity.get(row.identity)
    if (!algorandAddress) continue // not a verified claim — nothing to pay yet
    const owedMicro = row.total - (paidByKey.get(`${row.identity}\u0000${row.role}`) ?? 0)
    if (owedMicro <= 0) continue
    batch.push({ identity: row.identity, role: row.role, algorandAddress, amountMicro: owedMicro })
  }
  return batch.sort((a, b) => a.identity.localeCompare(b.identity) || a.role.localeCompare(b.role))
}

function printBatch(batch: PayoutLine[], mode: 'DRY RUN' | 'EXECUTE'): void {
  console.log(`spm-payout: ${mode} — ${batch.length} payout line(s)`)
  for (const line of batch) {
    console.log(
      `  ${line.identity}\trole=${line.role}\tamount_micro=${line.amountMicro}\t-> ${line.algorandAddress}`,
    )
  }
  const total = batch.reduce((sum, line) => sum + line.amountMicro, 0)
  console.log(`  total: ${total} micro-USDC`)
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(HELP)
    return
  }

  const dbPath = args.db ?? process.env.SQLITE_PATH ?? path.join(proxyRoot, 'audit.db')
  const BetterSqlite3 = proxyRequire('better-sqlite3') as new (
    filename: string,
    options?: { readonly?: boolean },
  ) => BetterSqlite3Database
  const db = new BetterSqlite3(dbPath, { readonly: !args.execute })

  try {
    const batch = buildPayoutBatch(db)

    if (!args.execute) {
      printBatch(batch, 'DRY RUN')
      console.log('\nDry run only — nothing was signed or submitted.')
      console.log('Pass --execute --key-file <path> to sign a real payout.')
      return
    }

    if (!args.keyFile) {
      console.error('ERROR: --execute requires --key-file <path to a local mnemonic file>')
      process.exitCode = 1
      return
    }

    // CAUTION: the mnemonic is read only from this explicit, human-supplied
    // file path — never from process.env or .env (CLAUDE.md). Pool keys are
    // cold; this script is the one place they are ever touched, and only
    // when a human hands it the file path directly.
    const mnemonic = readFileSync(args.keyFile, 'utf8').trim()
    const algosdk = proxyRequire('algosdk') as {
      mnemonicToSecretKey(mnemonic: string): { addr: unknown }
    }
    const account = algosdk.mnemonicToSecretKey(mnemonic)

    printBatch(batch, 'EXECUTE')
    console.log(`\nSigning account resolved: ${String(account.addr)}`)
    console.log(
      'This MVP script stops here by design: payouts are manual and batched, with a human',
    )
    console.log(
      'checking each claim before broadcast (SPEC.md 5.3 step 5). Confirm the batch above,',
    )
    console.log('then submit each transfer by hand and record it with recordPayout().')
  } finally {
    db.close()
  }
}

main()
