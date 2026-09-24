import assert from 'node:assert/strict'
import path from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { importWithoutEnvMutation } from './assert-no-env-import.mjs'

const scriptsDir = path.dirname(fileURLToPath(import.meta.url))
const optinUsdcModuleHref = pathToFileURL(path.join(scriptsDir, 'optin-usdc.mjs')).href

// R3a Result 2: the module must never read the root .env just because a
// caller imports it — only main() (the CLI entry path) may. Checked in a
// child process that never opens the real root .env
// (assert-no-env-import.mjs) — the main tree's .env holds real TestNet
// keys, and this test runs on every push.
test('importing optin-usdc.mjs never touches .env and never mutates process.env', () => {
  const report = importWithoutEnvMutation(optinUsdcModuleHref)
  assert.deepEqual(report.envPaths, [])
  assert.equal(report.envKeysChanged, false)
})
