#!/usr/bin/env node
// Anchors one human review on-chain (SPEC §14, ADR 0007). Run by the
// auditor, on their own machine — the auditor's key never touches the
// server. Fetches the current npm dist.integrity for name@version, prints
// every field, requires an interactive "yes", then sends a confirmed
// 0-ALGO self-payment carrying the ARC-2 note `spm:j{...}` and prints its
// txid. The operator later runs scripts/record-review.mjs <txid> on the
// server to record the review.
//
// Usage:
//   node scripts/anchor-review.mjs <name> <version> --reviewer <login> \
//     --scope <scope> --key-file <path> [--network testnet|mainnet] \
//     [--confirm-mainnet]
//
// <login> is the bare GitHub login (e.g. "alice"), never "github:alice" —
// this script builds the "github:" prefix itself, matching status.ts's
// convention (proxy/src/status.ts's reviewerIdentity()).
//
// <path> (--key-file) holds the auditor's 25-word Algorand mnemonic, one
// line, nothing else. It must not be readable by group or other — this
// script refuses a looser file rather than read a key off a shared machine.
//
// This never runs in CI, a fixture or a seed path (CLAUDE.md invariant 5):
// with no TTY on stdin, it refuses before any file, network or chain access.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { createInterface } from 'node:readline/promises'
import { algodEndpoint, assertMainnetConfirmed, parseNetworkFlag } from './network.mjs'
import { distIntegrityForVersion, encodeReviewNote, fetchNpmPackument } from './review-anchor.mjs'

const require = createRequire(new URL('../proxy/package.json', import.meta.url))

function printUsage() {
  console.error(
    'Usage: node scripts/anchor-review.mjs <name> <version> --reviewer <login> ' +
      '--scope <scope> --key-file <path> [--network testnet|mainnet] [--confirm-mainnet]',
  )
}

/**
 * Parses the positional and flag arguments this script takes. Pure, so it
 * is covered directly by scripts/anchor-review.test.mjs with no process
 * spawn needed.
 *
 * @param {string[]} argv
 * @returns {{name: string, version: string, reviewer: string, scope: string, keyFile: string}}
 */
export function parseAnchorArgs(argv) {
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i]
    if (token === '--confirm-mainnet') continue
    if (token.startsWith('--')) {
      i += 1 // skip this flag's value
      continue
    }
    positional.push(token)
  }
  const [name, version] = positional
  const flag = (flagName) => {
    const idx = argv.indexOf(`--${flagName}`)
    return idx === -1 ? undefined : argv[idx + 1]
  }
  const reviewer = flag('reviewer')
  const scope = flag('scope')
  const keyFile = flag('key-file')
  if (!name || !version || !reviewer || !scope || !keyFile) {
    throw new Error('missing required argument(s): <name> <version> --reviewer --scope --key-file')
  }
  return { name, version, reviewer, scope, keyFile }
}

/**
 * Reads the auditor mnemonic from `keyFile`. Refuses a missing file and a
 * file readable by group or other — a mnemonic on a shared machine must
 * never be one loose `chmod` away from every other user on it.
 *
 * @param {string} keyFile
 * @returns {string} the mnemonic, trimmed — never logged, never echoed.
 */
export function readKeyFile(keyFile) {
  let stat
  try {
    stat = fs.statSync(keyFile)
  } catch {
    throw new Error(`--key-file ${keyFile} does not exist`)
  }
  if ((stat.mode & 0o077) !== 0) {
    throw new Error(
      `--key-file ${keyFile} must not be readable by group or other (chmod 600 ${keyFile})`,
    )
  }
  return fs.readFileSync(keyFile, 'utf8').trim()
}

async function main() {
  // Refuses before any file, network or chain access (CLAUDE.md invariant
  // 5): a script with no TTY on stdin never anchors a review, on purpose.
  if (!process.stdin.isTTY) {
    console.error('refusing: anchor-review.mjs requires an interactive TTY, none found')
    process.exit(1)
  }

  const argv = process.argv.slice(2)
  let args
  try {
    args = parseAnchorArgs(argv)
  } catch (e) {
    console.error(e.message)
    printUsage()
    process.exit(2)
    return
  }

  const network = parseNetworkFlag(argv)
  assertMainnetConfirmed(network, argv)

  const mnemonic = readKeyFile(args.keyFile)

  const packument = await fetchNpmPackument(args.name)
  const integrity = distIntegrityForVersion(packument, args.name, args.version)
  const reviewer = `github:${args.reviewer}`

  console.log(`package:   ${args.name}`)
  console.log(`version:   ${args.version}`)
  console.log(`integrity: ${integrity}`)
  console.log(`reviewer:  ${reviewer}`)
  console.log(`scope:     ${args.scope}`)
  console.log(`network:   ${network}`)

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const answer = await rl.question('Send this review anchor? Type "yes" to confirm: ')
  rl.close()
  if (answer.trim() !== 'yes') {
    console.log('aborted: no transaction sent')
    return
  }

  const algosdk = require('algosdk')
  const { server, port, token } = algodEndpoint(network)
  const algod = new algosdk.Algodv2(token, server, port)
  const account = algosdk.mnemonicToSecretKey(mnemonic)

  const note = encodeReviewNote({
    name: args.name,
    version: args.version,
    integrity,
    reviewer,
    scope: args.scope,
  })

  const sp = await algod.getTransactionParams().do()
  const txn = algosdk.makePaymentTxnWithSuggestedParamsFromObject({
    sender: account.addr.toString(),
    receiver: account.addr.toString(),
    amount: 0,
    note,
    suggestedParams: sp,
  })
  const signed = txn.signTxn(account.sk)
  const { txid } = await algod.sendRawTransaction(signed).do()
  await algosdk.waitForConfirmation(algod, txid, 6)

  console.log(`anchored. txid: ${txid}`)
  console.log(`Next: run "node scripts/record-review.mjs ${txid}" on the server.`)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => {
    console.error(`FAIL  ${e.message}`)
    process.exit(1)
  })
}
