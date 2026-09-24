// proxy/src/claims/nightly-main.ts
//
// The nightly job's real process entry point (SPEC.md §13.2, ADR 0001,
// ADR 0005; replaces reconcile-main.ts). A host systemd timer starts this
// inside the proxy Docker image (`docker compose run --rm proxy pnpm
// nightly`, see deploy/systemd/spm-nightly.*) — it holds no scheduling,
// genesis-guard, reconcile, backup, or credit logic of its own; it only
// wires the real indexer, algod client, SQLite backup step, and genesis
// check (R3c, genesis.ts) and calls runNightly() (nightly.ts). runNightly()'s
// own tests exercise the actual behavior with stubs (nightly.test.ts,
// credit.test.ts, backup.test.ts) — this file is never imported by a test.
//
// Run with: pnpm -C proxy nightly

import algosdk from 'algosdk'
import { assertValidPayTo, NETWORK, PAY_TO, USDC_ASA_ID } from '../config.js'
import db from '../db.js'
import { backupDatabase } from './backup.js'
import { buildAlgodCreditClient, type CreditChainClient } from './credit.js'
import { assertGenesisMatchesNetwork, fetchGenesisId } from './genesis.js'
import { createIndexerClient } from './indexer.js'
import { runNightly } from './nightly.js'

// INDEXER_URL and ALGOD_SERVER are read here, not from proxy/src/config.ts
// — the running proxy never talks to an indexer or algod, only this
// offline runner does (see indexer.ts's createIndexerClient doc comment).
const DEFAULT_INDEXER_URL = 'https://mainnet-idx.algonode.cloud'
const DEFAULT_ALGOD_SERVER = 'https://mainnet-api.algonode.cloud'

const ALGOD_TOKEN_HEADER = 'X-Algo-API-Token'
const INDEXER_TOKEN_HEADER = 'X-Indexer-API-Token'
// The indexer has no dedicated genesis endpoint and /health carries no
// genesis-id (checked against the live indexers, R3c fix attempt 1); round
// 1's header does, alongside genesis-hash.
const INDEXER_GENESIS_PATH = '/v2/blocks/1?header-only=true'

/**
 * Refuses when NETWORK does not match the connected algod's or indexer's
 * own reported genesis id (R3c). Fetches both over HTTP (genesis.ts's
 * fetchGenesisId), then reuses genesis.ts's pure assertGenesisMatchesNetwork
 * for the comparison — called first inside runNightly, before any on-chain
 * read (nightly.ts).
 */
function buildGenesisGuard(
  algodServer: string,
  algodToken: string,
  indexerUrl: string,
  indexerToken: string,
): () => Promise<void> {
  return async () => {
    const algodGenesisId = await fetchGenesisId(
      algodServer,
      '/v2/transactions/params',
      algodToken,
      ALGOD_TOKEN_HEADER,
    )
    assertGenesisMatchesNetwork('algod', NETWORK, algodGenesisId, algodServer, 'ALGOD_SERVER')

    const indexerGenesisId = await fetchGenesisId(
      indexerUrl,
      INDEXER_GENESIS_PATH,
      indexerToken,
      INDEXER_TOKEN_HEADER,
    )
    assertGenesisMatchesNetwork('indexer', NETWORK, indexerGenesisId, indexerUrl, 'INDEXER_URL')
  }
}

/**
 * algosdk's Indexer constructor always sets `URL.port` from this argument —
 * mirrors indexer.ts's own `portOf` (out of scope here: this file may not
 * edit indexer.ts, and indexer.ts's own IndexerClient abstraction has no
 * note-search method, only `listUsdcInflows`).
 */
function portOf(url: string): string {
  return new URL(url).port
}

/**
 * null when CREDITER_MNEMONIC is unset — the credit step then logs why and
 * stops (SPEC.md §13.2 step 3) rather than failing to build a client.
 */
function buildCreditClient(indexerUrl: string): CreditChainClient | null {
  const crediterMnemonic = process.env.CREDITER_MNEMONIC
  if (!crediterMnemonic) return null

  const server = process.env.ALGOD_SERVER ?? DEFAULT_ALGOD_SERVER
  const port = Number(process.env.ALGOD_PORT ?? 443)
  const token = process.env.ALGOD_TOKEN ?? ''
  const algod = new algosdk.Algodv2(token, server, port)
  const indexer = new algosdk.Indexer('', indexerUrl, portOf(indexerUrl))
  return buildAlgodCreditClient(algod, indexer, crediterMnemonic, PAY_TO, BigInt(USDC_ASA_ID))
}

async function main(): Promise<void> {
  // payTo guard: cheap, local, no I/O — checked before any network call.
  // Reuses proxy/src/config.ts's own boot guard rather than a second copy
  // of the same validation, and its error message names PAY_TO_ADDRESS.
  assertValidPayTo()

  const indexerUrl = process.env.INDEXER_URL ?? DEFAULT_INDEXER_URL
  const indexer = createIndexerClient(indexerUrl, USDC_ASA_ID)
  const algodServer = process.env.ALGOD_SERVER ?? DEFAULT_ALGOD_SERVER
  const algodToken = process.env.ALGOD_TOKEN ?? ''
  const indexerToken = process.env.INDEXER_TOKEN ?? ''

  await runNightly({
    indexer,
    backup: () => backupDatabase(db, process.env.BACKUP_DIR ?? ''),
    creditClient: buildCreditClient(indexerUrl),
    assertGenesisMatches: buildGenesisGuard(algodServer, algodToken, indexerUrl, indexerToken),
  })
}

main()
  .catch((err: unknown) => {
    console.error('spm-nightly: failed —', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(() => {
    db.close()
  })
