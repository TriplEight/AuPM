// proxy/src/attest/yaml-worker.mjs
//
// Worker thread entry: parses one pnpm-lock.yaml body and posts the result.
// The main thread never calls `yaml` for a request body (ADR 0015). This file
// is plain JavaScript on purpose: a worker needs no TypeScript loader, in
// production (tsx) or in tests (vitest).
//
// Posts { ok: true, value } on success. Posts { ok: false } for a syntax
// error or a duplicate key in the root or in `packages` (pnpm rejects both).
//
// CAUTION: `uniqueKeys: false` is deliberate. The library's duplicate-key
// check is quadratic in the number of keys. `hasDuplicateKey` does the same
// check in linear time.

import { parentPort, workerData } from 'node:worker_threads'
import { isMap, isScalar, parseDocument } from 'yaml'

function hasDuplicateKey(node) {
  if (!isMap(node)) return false
  const seen = new Set()
  for (const pair of node.items) {
    const key = isScalar(pair.key) ? pair.key.value : pair.key
    if (seen.has(key)) return true
    seen.add(key)
  }
  return false
}

function parseYamlBody(text) {
  const doc = parseDocument(text, { uniqueKeys: false })
  if (doc.errors.length > 0) return { ok: false }
  if (hasDuplicateKey(doc.contents) || hasDuplicateKey(doc.get('packages', true))) {
    return { ok: false }
  }
  return { ok: true, value: doc.toJS() }
}

let outcome
try {
  outcome = parseYamlBody(workerData)
} catch {
  outcome = { ok: false }
}
parentPort.postMessage(outcome)
