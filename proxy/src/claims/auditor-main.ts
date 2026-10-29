// proxy/src/claims/auditor-main.ts
//
// The operator CLI that adds, rotates and lists the review keys of auditors. It needs no key.
// Only `rotate` uses the network: it reads the current round from algod. The logic sits in
// auditor-cli.ts; this file wires the real dependencies.
//
// Run with: pnpm -C proxy auditor add <github:login> <address>
//           pnpm -C proxy auditor rotate <github:login> <address> [--until <round>]
//           pnpm -C proxy auditor list

import { createInterface } from 'node:readline/promises'
import algosdk from 'algosdk'
import db from '../db.js'
import { runAuditorCli } from './auditor-cli.js'
import {
  addAuditor,
  getAuditorKeys,
  listAuditors,
  planAuditorRotation,
  rotateAuditorKey,
} from './ledger.js'
import { buildAlgodGenesisGuard } from './nightly-wiring.js'

const DEFAULT_ALGOD_SERVER = 'https://mainnet-api.algonode.cloud'

/** Reads the current round from algod, after the genesis check against NETWORK. */
async function readCurrentRound(): Promise<number> {
  const server = process.env.ALGOD_SERVER ?? DEFAULT_ALGOD_SERVER
  const token = process.env.ALGOD_TOKEN ?? ''
  const port = Number(process.env.ALGOD_PORT ?? 443)
  await buildAlgodGenesisGuard(server, token)()
  const status = await new algosdk.Algodv2(token, server, port).status().do()
  return Number(status.lastRound)
}

async function main(): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return await runAuditorCli(process.argv.slice(2), {
      addAuditor,
      getAuditorKeys,
      planAuditorRotation,
      rotateAuditorKey,
      listAuditors,
      getCurrentRound: readCurrentRound,
      prompt: (question) => rl.question(question),
      now: () => Date.now(),
      out: (line) => console.log(line),
      err: (line) => console.error(line),
    })
  } finally {
    rl.close()
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error('aupm-auditor: failed —', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    db.close()
  })
