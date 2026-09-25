// proxy/src/claims/nightly-wiring.ts
//
// Builds the real, network-touching NightlyDeps (nightly.ts): the real
// indexer and algod clients, the SQLite backup step, the credit client,
// and the R3c genesis guard. Shared by the two real callers — nightly-main.ts
// (the operator's manual entry point) and proxy/src/index.ts (the
// in-process scheduler, ADR 0009) — so the job is wired exactly one way,
// not two. Reads process.env itself, the same scope nightly-main.ts held
// before this split, but performs no network I/O at call time: every
// network call happens later, inside the functions buildRealNightlyDeps
// returns. Never imported by a test — the same reason nightly-main.ts
// never was: it wires real clients, no stub, no fake.

import algosdk from 'algosdk'
import { NETWORK, PAY_TO, USDC_ASA_ID } from '../config.js'
import db from '../db.js'
import { backupDatabase } from './backup.js'
import { buildAlgodCreditClient, type CreditChainClient } from './credit.js'
import { assertGenesisMatchesNetwork, fetchGenesisId } from './genesis.js'
import { createIndexerClient } from './indexer.js'
import type { NightlyDeps } from './nightly.js'

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

/**
 * Wires the real NightlyDeps from the current process's own environment
 * (INDEXER_URL, ALGOD_SERVER, ALGOD_TOKEN, ALGOD_PORT, INDEXER_TOKEN,
 * CREDITER_MNEMONIC, BACKUP_DIR — see .env.example). Call this once per
 * run: nightly-main.ts calls it once per process; proxy/src/index.ts's
 * scheduler calls it once at boot and reuses the result for every
 * scheduled and catch-up run.
 */
export function buildRealNightlyDeps(): NightlyDeps {
  const indexerUrl = process.env.INDEXER_URL ?? DEFAULT_INDEXER_URL
  const indexer = createIndexerClient(indexerUrl, USDC_ASA_ID)
  const algodServer = process.env.ALGOD_SERVER ?? DEFAULT_ALGOD_SERVER
  const algodToken = process.env.ALGOD_TOKEN ?? ''
  const indexerToken = process.env.INDEXER_TOKEN ?? ''

  return {
    indexer,
    backup: () => backupDatabase(db, process.env.BACKUP_DIR ?? ''),
    creditClient: buildCreditClient(indexerUrl),
    assertGenesisMatches: buildGenesisGuard(algodServer, algodToken, indexerUrl, indexerToken),
  }
}
