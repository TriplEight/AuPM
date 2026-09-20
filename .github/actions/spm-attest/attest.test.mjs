import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'

import { resolveOptions, run } from './attest.mjs'

const CANARY_SECRET = 'CANARY-wallet-secret-do-not-leak-4f9c'

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address()
      resolve({ server, url: `http://127.0.0.1:${port}` })
    })
  })
}

function makeLockfile(dir, content) {
  const path = join(dir, 'package-lock.json')
  writeFileSync(path, content)
  return path
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (chunk) => chunks.push(chunk))
    req.on('end', () => resolve(Buffer.concat(chunks)))
  })
}

function okResponse(res, summary) {
  res.writeHead(200, { 'content-type': 'application/json' })
  res.end(
    JSON.stringify({
      summary,
      attestation: { payload: 'e30=', payloadType: 'application/vnd.spm+json', signatures: [] },
    }),
  )
}

test('200 response with zero reviewed packages writes envelope and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const lockfile = makeLockfile(dir, '{"name":"demo","lockfileVersion":3}')
  const output = join(dir, 'out.json')
  const { server, url } = await startServer((_req, res) => {
    okResponse(res, { total: 0, reviewed: 0, unreviewed: 0, integrityMismatch: 0 })
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const code = await run({
    endpoint: url,
    lockfile,
    walletSecret: '',
    failOnMismatch: false,
    output,
  })

  assert.equal(code, 0)
  const written = JSON.parse(readFileSync(output, 'utf8'))
  assert.equal(written.payloadType, 'application/vnd.spm+json')
})

test('500 response warns and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const lockfile = makeLockfile(dir, '{"name":"demo"}')
  const output = join(dir, 'out.json')
  const { server, url } = await startServer((_req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' })
    res.end('internal error')
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const code = await run({
    endpoint: url,
    lockfile,
    walletSecret: '',
    failOnMismatch: false,
    output,
  })

  assert.equal(code, 0)
})

test('402 response warns and exits 0 without retrying or attempting payment', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const lockfile = makeLockfile(dir, '{"name":"demo"}')
  const output = join(dir, 'out.json')
  let requestCount = 0
  const { server, url } = await startServer((_req, res) => {
    requestCount += 1
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'payment required' }))
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const code = await run({
    endpoint: url,
    lockfile,
    failOnMismatch: false,
    output,
  })

  assert.equal(code, 0)
  // This action never pays: exactly one request total, no retry.
  assert.equal(requestCount, 1)
})

test('resolveOptions never surfaces a wallet secret from any source', () => {
  const options = resolveOptions(['--wallet-secret', CANARY_SECRET], {
    WALLET_SECRET: CANARY_SECRET,
    INPUT_WALLET_SECRET: CANARY_SECRET,
  })

  assert.equal('walletSecret' in options, false)
  assert.ok(
    !Object.values(options).some((v) => typeof v === 'string' && v.includes(CANARY_SECRET)),
    'no resolved option should ever contain the wallet secret value',
  )
})

test('a configured secret never appears in any request header, body, or URL (free path)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const lockfile = makeLockfile(dir, '{"name":"demo","lockfileVersion":3}')
  const output = join(dir, 'out.json')
  const seenRequests = []

  const { server, url } = await startServer(async (req, res) => {
    const body = await readBody(req)
    seenRequests.push({ url: req.url, headers: req.headers, body: body.toString('utf8') })
    okResponse(res, { total: 0, reviewed: 0, unreviewed: 0, integrityMismatch: 0 })
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  // Simulate a stale third-party workflow that still supplies every shape
  // of wallet secret this action used to accept. None of it is read.
  process.env.WALLET_SECRET = CANARY_SECRET
  process.env.INPUT_WALLET_SECRET = CANARY_SECRET
  t.after(() => {
    delete process.env.WALLET_SECRET
    delete process.env.INPUT_WALLET_SECRET
  })

  const options = resolveOptions(['--endpoint', url, '--lockfile', lockfile, '--output', output], {
    ...process.env,
  })
  const code = await run(options)

  assert.equal(code, 0)
  assert.ok(seenRequests.length >= 1, 'server should have received at least one request')
  for (const seen of seenRequests) {
    const serialized = JSON.stringify(seen)
    assert.ok(
      !serialized.includes(CANARY_SECRET),
      `request must not contain the secret anywhere, got: ${serialized}`,
    )
  }
})

test('a configured secret never appears in any request header, body, or URL (402 path)', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const lockfile = makeLockfile(dir, '{"name":"demo"}')
  const output = join(dir, 'out.json')
  const seenRequests = []

  const { server, url } = await startServer(async (req, res) => {
    const body = await readBody(req)
    seenRequests.push({ url: req.url, headers: req.headers, body: body.toString('utf8') })
    res.writeHead(402, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ error: 'payment required' }))
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const code = await run({
    endpoint: url,
    lockfile,
    failOnMismatch: false,
    output,
    // Even if a caller still passes this key on the options object directly
    // (e.g. an un-migrated integration), run() must not read or send it.
    walletSecret: CANARY_SECRET,
  })

  assert.equal(code, 0)
  assert.ok(seenRequests.length >= 1, 'server should have received at least one request')
  for (const seen of seenRequests) {
    const serialized = JSON.stringify(seen)
    assert.ok(
      !serialized.includes(CANARY_SECRET),
      `request must not contain the secret anywhere, got: ${serialized}`,
    )
  }
})

test('fail-on-mismatch true with integrityMismatch above zero exits 1', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const lockfile = makeLockfile(dir, '{"name":"demo"}')
  const output = join(dir, 'out.json')
  const { server, url } = await startServer((_req, res) => {
    okResponse(res, { total: 3, reviewed: 2, unreviewed: 1, integrityMismatch: 1 })
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const code = await run({
    endpoint: url,
    lockfile,
    walletSecret: '',
    failOnMismatch: true,
    output,
  })

  assert.equal(code, 1)
})

test('fail-on-mismatch false with integrityMismatch above zero exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const lockfile = makeLockfile(dir, '{"name":"demo"}')
  const output = join(dir, 'out.json')
  const { server, url } = await startServer((_req, res) => {
    okResponse(res, { total: 3, reviewed: 2, unreviewed: 1, integrityMismatch: 1 })
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const code = await run({
    endpoint: url,
    lockfile,
    walletSecret: '',
    failOnMismatch: false,
    output,
  })

  assert.equal(code, 0)
})

test('posted body bytes equal the lockfile bytes exactly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'))
  const content =
    '{\n  "name": "demo",\n  "lockfileVersion": 3,\n  "note": "  spacing   preserved  "\n}\n'
  const lockfile = makeLockfile(dir, content)
  const output = join(dir, 'out.json')
  const fileBytes = readFileSync(lockfile)
  let capturedBody = null

  const { server, url } = await startServer(async (req, res) => {
    capturedBody = await readBody(req)
    okResponse(res, { total: 0, reviewed: 0, unreviewed: 0, integrityMismatch: 0 })
  })
  t.after(() => {
    server.close()
    rmSync(dir, { recursive: true, force: true })
  })

  const code = await run({
    endpoint: url,
    lockfile,
    walletSecret: '',
    failOnMismatch: false,
    output,
  })

  assert.equal(code, 0)
  assert.ok(capturedBody !== null, 'server should have received a request body')
  assert.ok(
    Buffer.isBuffer(capturedBody) && capturedBody.equals(fileBytes),
    'posted body must equal file bytes exactly',
  )
})
