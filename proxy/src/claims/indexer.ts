// proxy/src/claims/indexer.ts
//
// Production IndexerClient (SPEC-v3.md 5.2) for
// proxy/src/claims/reconcile.ts: lists confirmed USDC axfers into `payTo`
// from an Algorand indexer, via algosdk's own Indexer client. Pages through
// every result with `next-token` — a busy `payTo` can span more than one
// page.
//
// CAUTION: this is the only module in proxy/src/claims that talks to an
// indexer directly, over `fetch` (algosdk's own HTTP client) — same
// "production client behind an injectable interface" split as
// proxy/src/claims/github.ts's createGithubClient.

import algosdk from 'algosdk'
import type { IndexerClient, UsdcInflow } from './reconcile.js'

// One page of `/v2/transactions` per request. Well under the indexer's own
// hard cap, and small enough that a single page never times out.
const PAGE_LIMIT = 1000

/**
 * algosdk's Indexer constructor always sets `URL.port` from this argument —
 * passing the same URL's own `.port` back is a no-op for a bare host (no
 * port in the URL) and preserves an explicit one (e.g. a local indexer on
 * `http://localhost:8980`).
 */
function portOf(indexerUrl: string): string {
  return new URL(indexerUrl).port
}

/**
 * Build a real, injectable IndexerClient. `indexerUrl` and `usdcAssetId`
 * come from the caller's own environment read — proxy/src/config.ts does
 * not own INDEXER_URL (see scripts/reconcile.ts, which reads it) — so this
 * module performs no environment read itself, matching
 * createGithubClient's shape.
 */
export function createIndexerClient(indexerUrl: string, usdcAssetId: string): IndexerClient {
  const client = new algosdk.Indexer('', indexerUrl, portOf(indexerUrl))
  const assetId = BigInt(usdcAssetId)

  return {
    async listUsdcInflows(payTo: string): Promise<UsdcInflow[]> {
      const inflows: UsdcInflow[] = []
      let nextToken: string | undefined

      for (;;) {
        let request = client
          .searchForTransactions()
          .address(payTo)
          .addressRole('receiver')
          .txType('axfer')
          .assetID(assetId)
          .limit(PAGE_LIMIT)
        if (nextToken) request = request.nextToken(nextToken)

        const page = await request.do()
        for (const txn of page.transactions) {
          const transfer = txn.assetTransferTransaction
          // Defence in depth: the query above already filters on these —
          // skip anything malformed rather than ledgering a wrong receiver.
          if (!transfer || transfer.receiver !== payTo) continue
          if (!txn.id || txn.roundTime === undefined) continue
          inflows.push({
            txid: txn.id,
            amountMicro: Number(transfer.amount),
            confirmedAt: txn.roundTime,
          })
        }

        nextToken = page.nextToken
        if (!nextToken) break
      }

      return inflows
    },
  }
}
