import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { runRecordReview } from './record-review.mjs'
import { encodeReviewNote } from './review-anchor.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SCRIPT = path.join(__dirname, 'record-review.mjs')

const GOOD_NOTE_FIELDS = {
  name: 'ms',
  version: '2.1.3',
  integrity: 'sha512-known-good',
  reviewer: 'github:alice',
  scope: 'source read, no build',
}

/** A minimal indexer stub whose lookupTransactionByID always returns `tx`. */
function stubIndexer(tx) {
  return {
    lookupTransactionByID: (_id) => ({
      do: async () => ({ transaction: tx }),
    }),
  }
}

function goodTx(overrides = {}) {
  return {
    txType: 'pay',
    sender: 'ADDR1',
    paymentTransaction: { amount: 0n, receiver: 'ADDR1' },
    confirmedRound: 100n,
    note: encodeReviewNote(GOOD_NOTE_FIELDS),
    ...overrides,
  }
}

function stubFetch(packument) {
  return async () => ({ ok: true, json: async () => packument })
}

const GOOD_PACKUMENT = {
  repository: 'https://github.com/vercel/ms',
  versions: { '2.1.3': { dist: { integrity: 'sha512-known-good' } } },
}

/** Fake PaymentRouter identity boxes: identity -> address. Records the lookups. */
function stubRegistry(boxes) {
  const lookups = []
  return {
    lookups,
    readMappedAddress: async (appId, identity) => {
      lookups.push([appId, identity])
      return boxes[identity] ?? null
    },
  }
}

const REGISTRY_ARGS = { paymentRouterAppId: '123', ...stubRegistry({ 'github:alice': 'ADDR1' }) }

function recordedRows(store) {
  const rows = []
  return {
    store: {
      setStatus: (...args) => {
        rows.push(args)
        store?.(...args)
      },
    },
    rows,
  }
}

test('a successful run prints the fields, prompts, and writes the row on "yes"', async () => {
  const { store, rows } = recordedRows()
  const result = await runRecordReview({
    anchorTxid: 'TXID1',
    indexerClient: stubIndexer(goodTx()),
    fetchImpl: stubFetch(GOOD_PACKUMENT),
    prompt: async () => 'yes',
    statusStore: store,
    ...REGISTRY_ARGS,
    log: () => {},
  })
  assert.equal(result.recorded, true)
  assert.equal(result.pkg, 'ms')
  assert.equal(result.version, '2.1.3')
  assert.equal(result.repo, 'vercel/ms')
  assert.equal(result.reviewer, 'alice')
  assert.deepEqual(rows[0], [
    'ms',
    '2.1.3',
    'COMMUNITY_REVIEWED',
    'ADDR1',
    'TXID1',
    'sha512-known-good',
    'alice',
    'source read, no build',
    'vercel/ms',
  ])
})

test('declining the prompt writes nothing', async () => {
  const { store, rows } = recordedRows()
  const result = await runRecordReview({
    anchorTxid: 'TXID1',
    indexerClient: stubIndexer(goodTx()),
    fetchImpl: stubFetch(GOOD_PACKUMENT),
    prompt: async () => 'no',
    statusStore: store,
    ...REGISTRY_ARGS,
    log: () => {},
  })
  assert.equal(result.recorded, false)
  assert.equal(rows.length, 0)
})

test('an unmapped reviewer login throws and writes nothing', async () => {
  const { store, rows } = recordedRows()
  await assert.rejects(
    runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(goodTx()),
      fetchImpl: stubFetch(GOOD_PACKUMENT),
      prompt: async () => 'yes',
      statusStore: store,
      paymentRouterAppId: '123',
      ...stubRegistry({}),
      log: () => {},
    }),
    /github:alice is not mapped in PaymentRouter/,
  )
  assert.equal(rows.length, 0)
})

test('a sender that differs from the mapped address throws and writes nothing', async () => {
  const { store, rows } = recordedRows()
  await assert.rejects(
    runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(
        goodTx({ sender: 'ADDR2', paymentTransaction: { amount: 0n, receiver: 'ADDR2' } }),
      ),
      fetchImpl: stubFetch(GOOD_PACKUMENT),
      prompt: async () => 'yes',
      statusStore: store,
      ...REGISTRY_ARGS,
      log: () => {},
    }),
    /is not the address mapped to github:alice/,
  )
  assert.equal(rows.length, 0)
})

test('a missing app id throws before any lookup and writes nothing', async () => {
  const { store, rows } = recordedRows()
  const registry = stubRegistry({ 'github:alice': 'ADDR1' })
  await assert.rejects(
    runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(goodTx()),
      fetchImpl: stubFetch(GOOD_PACKUMENT),
      prompt: async () => 'yes',
      statusStore: store,
      paymentRouterAppId: undefined,
      ...registry,
      log: () => {},
    }),
    /PAYMENT_ROUTER_APP_ID is not set/,
  )
  assert.equal(registry.lookups.length, 0)
  assert.equal(rows.length, 0)
})

test('a mixed-case reviewer login matches a lower-case box', async () => {
  const { store, rows } = recordedRows()
  const registry = stubRegistry({ 'github:alice': 'ADDR1' })
  const result = await runRecordReview({
    anchorTxid: 'TXID1',
    indexerClient: stubIndexer(
      goodTx({ note: encodeReviewNote({ ...GOOD_NOTE_FIELDS, reviewer: 'github:Alice' }) }),
    ),
    fetchImpl: stubFetch(GOOD_PACKUMENT),
    prompt: async () => 'yes',
    statusStore: store,
    paymentRouterAppId: '123',
    ...registry,
    log: () => {},
  })
  assert.deepEqual(registry.lookups, [[123, 'github:alice']])
  assert.equal(result.reviewer, 'alice')
  assert.equal(rows[0][6], 'alice')
})

test('two different auditors both record from one registry', async () => {
  const registry = stubRegistry({ 'github:alice': 'ADDR1', 'github:bob': 'ADDR2' })
  for (const [login, address] of [
    ['alice', 'ADDR1'],
    ['bob', 'ADDR2'],
  ]) {
    const { store, rows } = recordedRows()
    const result = await runRecordReview({
      anchorTxid: `TXID-${login}`,
      indexerClient: stubIndexer(
        goodTx({
          sender: address,
          paymentTransaction: { amount: 0n, receiver: address },
          note: encodeReviewNote({ ...GOOD_NOTE_FIELDS, reviewer: `github:${login}` }),
        }),
      ),
      fetchImpl: stubFetch(GOOD_PACKUMENT),
      prompt: async () => 'yes',
      statusStore: store,
      paymentRouterAppId: '123',
      ...registry,
      log: () => {},
    })
    assert.equal(result.recorded, true)
    assert.equal(rows[0][6], login)
  }
})

test('an integrity mismatch against npm throws and writes nothing', async () => {
  const { store, rows } = recordedRows()
  const mismatched = {
    ...GOOD_PACKUMENT,
    versions: { '2.1.3': { dist: { integrity: 'sha512-different' } } },
  }
  await assert.rejects(
    runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(goodTx()),
      fetchImpl: stubFetch(mismatched),
      prompt: async () => 'yes',
      statusStore: store,
      ...REGISTRY_ARGS,
      log: () => {},
    }),
    /does not match npm dist\.integrity/,
  )
  assert.equal(rows.length, 0)
})

test('an anchor that is not a confirmed 0-ALGO self-payment throws and writes nothing', async () => {
  const { store, rows } = recordedRows()
  await assert.rejects(
    runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(
        goodTx({ paymentTransaction: { amount: 1000n, receiver: 'ADDR1' } }),
      ),
      fetchImpl: stubFetch(GOOD_PACKUMENT),
      prompt: async () => 'yes',
      statusStore: store,
      ...REGISTRY_ARGS,
      log: () => {},
    }),
    /not a 0-ALGO payment/,
  )
  assert.equal(rows.length, 0)
})

test('a malformed note throws and writes nothing', async () => {
  const { store, rows } = recordedRows()
  await assert.rejects(
    runRecordReview({
      anchorTxid: 'TXID1',
      indexerClient: stubIndexer(goodTx({ note: new TextEncoder().encode('not-an-arc2-note') })),
      fetchImpl: stubFetch(GOOD_PACKUMENT),
      prompt: async () => 'yes',
      statusStore: store,
      ...REGISTRY_ARGS,
      log: () => {},
    }),
    /ARC-2 prefix/,
  )
  assert.equal(rows.length, 0)
})

// -- no TTY: the real script must refuse before any network or database
// access. Spawned with stdio piped (never a TTY) and no network
// reachable — a hang or a network/database attempt would fail this test.
test('record-review.mjs refuses immediately with no TTY on stdin', () => {
  const result = spawnSync(process.execPath, [SCRIPT, 'SOME_TXID'], {
    input: '',
    encoding: 'utf8',
    timeout: 5000,
  })
  assert.equal(result.status, 1)
  assert.match(result.stderr, /requires an interactive TTY/)
})
