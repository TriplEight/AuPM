// proxy/src/record-review.test.ts
//
// Integration test for scripts/record-review.mjs's write path (Q6, SPEC
// §14, ADR 0007): a successful run must write anchor_txid, review_scope,
// repo, integrity, reviewer, and status COMMUNITY_REVIEWED through the
// proxy's real SQLite schema (proxy/src/db.ts, proxy/src/status.ts) — not a
// second schema copy. Everything except the status store itself (the
// indexer, npm, and the interactive prompt) is injected, so this never
// touches a real TTY, network or chain — mirrors proxy/src/status.test.ts's
// per-file SQLITE_PATH isolation trick.
import { randomUUID } from 'node:crypto'
import os from 'node:os'
import path from 'node:path'
import { beforeEach, describe, expect, test } from 'vitest'

process.env.SQLITE_PATH = path.join(os.tmpdir(), `aupm-record-review-test-${randomUUID()}.db`)

const { default: db } = await import('./db.js')
const statusStore = await import('./status.js')
// scripts/*.mjs are plain JS (JSDoc-typed, not part of this tsconfig's
// `include`), so tsc cannot infer their shape from a declaration file.
// @ts-expect-error -- no .d.ts for scripts/record-review.mjs
const { runRecordReview } = await import('../../scripts/record-review.mjs')
// @ts-expect-error -- no .d.ts for scripts/review-anchor.mjs
const { encodeReviewNote } = await import('../../scripts/review-anchor.mjs')

beforeEach(() => {
  db.exec('DELETE FROM audit_status')
})

const NOTE_FIELDS = {
  name: 'ms',
  version: '2.1.3',
  integrity: 'sha512-known-good',
  reviewer: 'github:alice',
  scope: 'source read, no build',
}

function stubIndexer(tx: unknown) {
  return {
    lookupTransactionByID: (_id: string) => ({
      do: async () => ({ transaction: tx }),
    }),
  }
}

function goodTx(overrides: Record<string, unknown> = {}) {
  return {
    txType: 'pay',
    sender: 'ADDR1',
    paymentTransaction: { amount: 0n, receiver: 'ADDR1' },
    confirmedRound: 100n,
    note: encodeReviewNote(NOTE_FIELDS),
    ...overrides,
  }
}

const PACKUMENT = {
  repository: 'https://github.com/vercel/ms',
  versions: { '2.1.3': { dist: { integrity: 'sha512-known-good' } } },
}

function stubFetch() {
  return async () => ({ ok: true, json: async () => PACKUMENT })
}

describe('record-review.mjs writes through the real SQLite status store', () => {
  test('a successful run writes anchor_txid, review_scope, repo, integrity, reviewer, and status', async () => {
    const result = await runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(goodTx()),
      fetchImpl: stubFetch(),
      prompt: async () => 'yes',
      statusStore,
      auditorsEnv: 'github:alice=ADDR1',
      network: 'mainnet',
      log: () => {},
    })

    expect(result.recorded).toBe(true)

    const row = statusStore.getStatusOrUnreviewed('ms', '2.1.3')
    expect(row.status).toBe('COMMUNITY_REVIEWED')
    expect(row.anchor_txid).toBe('TXID1')
    expect(row.review_scope).toBe('source read, no build')
    expect(row.repo).toBe('vercel/ms')
    expect(row.integrity).toBe('sha512-known-good')
    expect(row.reviewer).toBe('alice')
    expect(row.auditor_addr).toBe('ADDR1')
  })

  test('declining the prompt writes no row at all', async () => {
    const result = await runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(goodTx()),
      fetchImpl: stubFetch(),
      prompt: async () => 'no',
      statusStore,
      auditorsEnv: 'github:alice=ADDR1',
      network: 'testnet',
      log: () => {},
    })

    expect(result.recorded).toBe(false)
    const row = statusStore.getStatusOrUnreviewed('ms', '2.1.3')
    expect(row.status).toBe('UNREVIEWED')
  })

  const unreadTx = () =>
    goodTx({ note: encodeReviewNote({ ...NOTE_FIELDS, scope: 'unread: testnet rehearsal' }) })

  test('an unread scope on MainNet is refused before the prompt, and writes no row', async () => {
    let prompted = false
    await expect(
      runRecordReview({
        anchorTxid: 'TXID1',
        indexerClient: stubIndexer(unreadTx()),
        fetchImpl: stubFetch(),
        prompt: async () => {
          prompted = true
          return 'yes'
        },
        statusStore,
        auditorsEnv: 'github:alice=ADDR1',
        network: 'mainnet',
        log: () => {},
      }),
    ).rejects.toThrow(/TestNet-only \(ADR 0012\)/)

    expect(prompted).toBe(false)
    expect(statusStore.getStatusOrUnreviewed('ms', '2.1.3').status).toBe('UNREVIEWED')
  })

  test('an unread scope on TestNet is recorded with its scope visible', async () => {
    const result = await runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(unreadTx()),
      fetchImpl: stubFetch(),
      prompt: async () => 'yes',
      statusStore,
      auditorsEnv: 'github:alice=ADDR1',
      network: 'testnet',
      log: () => {},
    })

    expect(result.recorded).toBe(true)
    expect(statusStore.getStatusOrUnreviewed('ms', '2.1.3').review_scope).toBe(
      'unread: testnet rehearsal',
    )
  })
})
