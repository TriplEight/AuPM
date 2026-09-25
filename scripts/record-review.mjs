#!/usr/bin/env node
// Records one human review from its on-chain anchor (SPEC §14, ADR 0007).
// Run by the operator, on the server. Reads the anchor transaction from the
// indexer, checks its sender against AUDITORS, checks its integrity against
// npm for that exact version, resolves the repo key (SPEC §13.1), prints
// every field, requires an interactive "yes", and only then writes the row
// through the proxy's own SQLite schema (proxy/src/status.ts's setStatus —
// never a second schema copy, never raw SQL here).
//
// Usage (run from the repository root, with the proxy workspace installed):
//   proxy/node_modules/.bin/tsx scripts/record-review.mjs <anchorTxid> \
//     [--network testnet|mainnet]
// Equivalently: node --import tsx/esm scripts/record-review.mjs <anchorTxid>
// run with proxy/ as the working directory and its node_modules resolvable.
// In the proxy container this later becomes:
//   docker compose run --rm spm node --import tsx/esm \
//     scripts/record-review.mjs <anchorTxid>
//
// This never runs in CI, a fixture or a seed path (CLAUDE.md invariant 5):
// with no TTY on stdin, it refuses before any network or database access.
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline/promises'
import { indexerEndpoint, parseNetworkFlag } from './network.mjs'
import {
  checkIntegrityMatchesNpm,
  checkIsSelfZeroPayment,
  checkSenderIsMappedAuditor,
  decodeReviewNote,
  distIntegrityForVersion,
  fetchNpmPackument,
  parseAuditors,
  repositoryForVersion,
  resolveRepoKey,
} from './review-anchor.mjs'

const require = createRequire(new URL('../proxy/package.json', import.meta.url))

function printUsage() {
  console.error('Usage: node scripts/record-review.mjs <anchorTxid> [--network testnet|mainnet]')
}

/**
 * Runs the full record-review flow against injected dependencies — no
 * global fetch, no real indexer client, no real prompt, and no import of
 * the proxy's TypeScript source. This is what makes the flow (including
 * the actual SQLite write) testable without a TTY, a network or a chain;
 * see proxy/src/record-review.test.ts, which supplies the real
 * setStatus/getStatusOrUnreviewed pair against a temp SQLITE_PATH.
 *
 * @param {object} deps
 * @param {string} deps.anchorTxid
 * @param {{lookupTransactionByID(id: string): {do(): Promise<{transaction: any}>}}} deps.indexerClient
 * @param {typeof fetch} [deps.fetchImpl]
 * @param {(question: string) => Promise<string>} deps.prompt
 * @param {{setStatus: Function, getStatusOrUnreviewed: Function}} deps.statusStore
 * @param {string|undefined} deps.auditorsEnv - the raw AUDITORS env value.
 * @param {(line: string) => void} [deps.log]
 * @returns {Promise<{recorded: boolean, pkg?: string, version?: string, repo?: string, reviewer?: string}>}
 */
export async function runRecordReview({
  anchorTxid,
  indexerClient,
  fetchImpl = fetch,
  prompt,
  statusStore,
  auditorsEnv,
  log = console.log,
}) {
  const auditors = parseAuditors(auditorsEnv)

  const { transaction: tx } = await indexerClient.lookupTransactionByID(anchorTxid).do()
  checkIsSelfZeroPayment(tx)
  const note = decodeReviewNote(tx.note)
  const login = checkSenderIsMappedAuditor({ sender: tx.sender, note, auditors })

  const packument = await fetchNpmPackument(note.name, fetchImpl)
  const npmIntegrity = distIntegrityForVersion(packument, note.name, note.version)
  checkIntegrityMatchesNpm(note, npmIntegrity)
  const repo = resolveRepoKey(note.name, repositoryForVersion(packument, note.version))

  log(`package:   ${note.name}`)
  log(`version:   ${note.version}`)
  log(`integrity: ${note.integrity}`)
  log(`reviewer:  ${note.reviewer}`)
  log(`scope:     ${note.scope}`)
  log(`repo:      ${repo}`)
  log(`sender:    ${tx.sender}`)
  log(`anchor:    ${anchorTxid}`)

  const answer = await prompt('Record this review? Type "yes" to confirm: ')
  if (answer.trim() !== 'yes') {
    log('aborted: not recorded')
    return { recorded: false }
  }

  statusStore.setStatus(
    note.name,
    note.version,
    'COMMUNITY_REVIEWED',
    tx.sender,
    anchorTxid,
    note.integrity,
    login,
    note.scope,
    repo,
  )
  log('recorded')
  return { recorded: true, pkg: note.name, version: note.version, repo, reviewer: login }
}

async function main() {
  // Refuses before any network or database access (CLAUDE.md invariant 5):
  // a script with no TTY on stdin never records a review, on purpose.
  if (!process.stdin.isTTY) {
    console.error('refusing: record-review.mjs requires an interactive TTY, none found')
    process.exit(1)
  }

  const argv = process.argv.slice(2)
  const anchorTxid = argv.find((a) => !a.startsWith('--'))
  if (!anchorTxid) {
    printUsage()
    process.exit(2)
    return
  }

  const network = parseNetworkFlag(argv)
  const algosdk = require('algosdk')
  const { server, port, token } = indexerEndpoint(network)
  const indexerClient = new algosdk.Indexer(token, server, port)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const prompt = (question) => rl.question(question)

  // Dynamic, and only reached past the TTY guard above: SQLITE_PATH must
  // already be set in this process's environment (the operator's shell, or
  // the container's) before proxy/src/db.ts is evaluated.
  const statusStore = await import('../proxy/src/status.js')

  try {
    const result = await runRecordReview({
      anchorTxid,
      indexerClient,
      prompt,
      statusStore,
      auditorsEnv: process.env.AUDITORS,
    })
    process.exit(result.recorded ? 0 : 1)
  } finally {
    rl.close()
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
  })
}
