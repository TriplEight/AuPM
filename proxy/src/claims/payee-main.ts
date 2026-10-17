// proxy/src/claims/payee-main.ts
//
// The operator CLI that adds payees and lists them. It needs no crediter key: the opt-in check
// reads algod only. The logic sits in payee-cli.ts; this file wires the real dependencies.
//
// Run with: pnpm -C proxy payee add <identity> <address>
//           pnpm -C proxy payee list

import algosdk from 'algosdk'
import { USDC_ASA_ID } from '../config.js'
import db from '../db.js'
import { buildAlgodPayoutChecker, onboardPayee } from './credit.js'
import { listPayees } from './ledger.js'
import { buildAlgodGenesisGuard } from './nightly-wiring.js'
import { runPayeeCli } from './payee-cli.js'

const DEFAULT_ALGOD_SERVER = 'https://mainnet-api.algonode.cloud'

async function main(): Promise<number> {
  const server = process.env.ALGOD_SERVER ?? DEFAULT_ALGOD_SERVER
  const token = process.env.ALGOD_TOKEN ?? ''
  const port = Number(process.env.ALGOD_PORT ?? 443)
  const algod = new algosdk.Algodv2(token, server, port)

  return runPayeeCli(process.argv.slice(2), {
    assertGenesisMatches: buildAlgodGenesisGuard(server, token),
    client: { checkPayoutAddress: buildAlgodPayoutChecker(algod, BigInt(USDC_ASA_ID)) },
    onboardPayee,
    listPayees,
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  })
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error('aupm-payee: failed —', error instanceof Error ? error.message : error)
    process.exitCode = 1
  })
  .finally(() => {
    db.close()
  })
