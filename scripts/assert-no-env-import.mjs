// scripts/assert-no-env-import.mjs
//
// Test-only helper (R3a Result 2 hardening). Proves that importing a
// module never reads, writes, checks for, or otherwise touches the repo's
// root .env file, and never changes the set of `process.env` keys —
// without ever touching the real .env file itself. The pre-push hook runs
// scripts/*.test.mjs on every push, and the main tree's .env holds real
// TestNet keys; a test that appends a marker to that file and restores it
// is not safe against a killed run.
//
// Method: spawn a child `node` process with a generated `--import`
// preload that wraps fs.readFileSync/existsSync/openSync/promises.readFile
// and process.loadEnvFile (when present) to record every path whose
// basename is ".env" that any code in the child process ever touches. The
// child then imports the module under test and reports what it saw, plus
// process.env's own key set before and after. Nothing here ever opens,
// writes, or deletes a real file named ".env" — only a generated preload
// script inside its own throwaway temp directory.
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const PRELOAD_SOURCE = `
import fs from 'node:fs'
import path from 'node:path'

globalThis.__spmEnvAccessLog = []

function record(candidate) {
  try {
    if (typeof candidate === 'string' && path.basename(candidate) === '.env') {
      globalThis.__spmEnvAccessLog.push(candidate)
    }
  } catch {
    // A non-path argument (a file descriptor, a Buffer, a URL) never
    // matches -- never throws out of the wrapper either.
  }
}

function wrap(obj, key) {
  const original = obj[key]
  if (typeof original !== 'function') return
  obj[key] = function (...args) {
    record(args[0])
    return original.apply(this, args)
  }
}

wrap(fs, 'readFileSync')
wrap(fs, 'existsSync')
wrap(fs, 'openSync')
wrap(fs.promises, 'readFile')

if (typeof process.loadEnvFile === 'function') {
  const originalLoadEnvFile = process.loadEnvFile
  process.loadEnvFile = function (candidate) {
    record(candidate ?? '.env')
    return originalLoadEnvFile.call(process, candidate)
  }
}
`

/**
 * Imports `moduleHref` in a fresh child process and reports every ".env"
 * path any wrapped fs/process API saw during that import, plus whether the
 * child's own `process.env` key set changed. Never touches the real root
 * .env.
 *
 * @param {string} moduleHref - a `file://` URL for the module under test.
 * @returns {{
 *   envPaths: string[],
 *   envKeysChanged: boolean,
 *   envKeysBefore: string[],
 *   envKeysAfter: string[],
 * }}
 */
export function importWithoutEnvMutation(moduleHref) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spm-env-import-guard-'))
  try {
    const preloadPath = path.join(tmpDir, 'preload.mjs')
    fs.writeFileSync(preloadPath, PRELOAD_SOURCE)
    const preloadHref = pathToFileURL(preloadPath).href

    const entry =
      'const before = Object.keys(process.env).sort();' +
      `await import(${JSON.stringify(moduleHref)});` +
      'const after = Object.keys(process.env).sort();' +
      'process.stdout.write(JSON.stringify({' +
      'envPaths: globalThis.__spmEnvAccessLog ?? [],' +
      'envKeysBefore: before,' +
      'envKeysAfter: after,' +
      '}));'

    const result = spawnSync(
      process.execPath,
      ['--import', preloadHref, '--input-type=module', '-e', entry],
      { encoding: 'utf8' },
    )
    if (result.status !== 0) {
      throw new Error(
        `child process failed importing ${moduleHref}: ${result.stderr || result.stdout}`,
      )
    }
    const report = JSON.parse(result.stdout)
    const envKeysChanged =
      JSON.stringify(report.envKeysBefore) !== JSON.stringify(report.envKeysAfter)
    return {
      envPaths: report.envPaths,
      envKeysChanged,
      envKeysBefore: report.envKeysBefore,
      envKeysAfter: report.envKeysAfter,
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }
}
