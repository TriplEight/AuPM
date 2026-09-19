import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from './attest.mjs';

function startServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

function makeLockfile(dir, content) {
  const path = join(dir, 'package-lock.json');
  writeFileSync(path, content);
  return path;
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function okResponse(res, summary) {
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(
    JSON.stringify({
      summary,
      attestation: { payload: 'e30=', payloadType: 'application/vnd.spm+json', signatures: [] },
    }),
  );
}

test('200 response with zero reviewed packages writes envelope and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'));
  const lockfile = makeLockfile(dir, '{"name":"demo","lockfileVersion":3}');
  const output = join(dir, 'out.json');
  const { server, url } = await startServer((req, res) => {
    okResponse(res, { total: 0, reviewed: 0, unreviewed: 0, integrityMismatch: 0 });
  });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await run({ endpoint: url, lockfile, walletSecret: '', failOnMismatch: false, output });

  assert.equal(code, 0);
  const written = JSON.parse(readFileSync(output, 'utf8'));
  assert.equal(written.payloadType, 'application/vnd.spm+json');
});

test('500 response warns and exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'));
  const lockfile = makeLockfile(dir, '{"name":"demo"}');
  const output = join(dir, 'out.json');
  const { server, url } = await startServer((req, res) => {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('internal error');
  });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await run({ endpoint: url, lockfile, walletSecret: '', failOnMismatch: false, output });

  assert.equal(code, 0);
});

test('402 response triggers exactly one retry', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'));
  const lockfile = makeLockfile(dir, '{"name":"demo"}');
  const output = join(dir, 'out.json');
  let requestCount = 0;
  const { server, url } = await startServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1) {
      res.writeHead(402, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payment required' }));
      return;
    }
    okResponse(res, { total: 1, reviewed: 1, unreviewed: 0, integrityMismatch: 0 });
  });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await run({
    endpoint: url,
    lockfile,
    walletSecret: 'demo-wallet-secret',
    failOnMismatch: false,
    output,
  });

  assert.equal(code, 0);
  assert.equal(requestCount, 2);
});

test('fail-on-mismatch true with integrityMismatch above zero exits 1', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'));
  const lockfile = makeLockfile(dir, '{"name":"demo"}');
  const output = join(dir, 'out.json');
  const { server, url } = await startServer((req, res) => {
    okResponse(res, { total: 3, reviewed: 2, unreviewed: 1, integrityMismatch: 1 });
  });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await run({ endpoint: url, lockfile, walletSecret: '', failOnMismatch: true, output });

  assert.equal(code, 1);
});

test('fail-on-mismatch false with integrityMismatch above zero exits 0', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'));
  const lockfile = makeLockfile(dir, '{"name":"demo"}');
  const output = join(dir, 'out.json');
  const { server, url } = await startServer((req, res) => {
    okResponse(res, { total: 3, reviewed: 2, unreviewed: 1, integrityMismatch: 1 });
  });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await run({ endpoint: url, lockfile, walletSecret: '', failOnMismatch: false, output });

  assert.equal(code, 0);
});

test('posted body bytes equal the lockfile bytes exactly', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'spm-attest-'));
  const content = '{\n  "name": "demo",\n  "lockfileVersion": 3,\n  "note": "  spacing   preserved  "\n}\n';
  const lockfile = makeLockfile(dir, content);
  const output = join(dir, 'out.json');
  const fileBytes = readFileSync(lockfile);
  let capturedBody = null;

  const { server, url } = await startServer(async (req, res) => {
    capturedBody = await readBody(req);
    okResponse(res, { total: 0, reviewed: 0, unreviewed: 0, integrityMismatch: 0 });
  });
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });

  const code = await run({ endpoint: url, lockfile, walletSecret: '', failOnMismatch: false, output });

  assert.equal(code, 0);
  assert.ok(capturedBody !== null, 'server should have received a request body');
  assert.ok(Buffer.isBuffer(capturedBody) && capturedBody.equals(fileBytes), 'posted body must equal file bytes exactly');
});
