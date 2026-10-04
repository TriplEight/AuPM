#!/usr/bin/env node
// Install step of the aupm Action. Runs `npm ci` through the AuPM registry and
// falls back to plain `npm ci`. It uses the caller's Node and npm, so it runs
// before the Action sets up its own toolchain. Dependency-free.
//
// An AuPM registry failure never fails the job: the script falls back to npm.
// A plain npm failure fails the job, the same as a plain `npm ci` step.

import { spawn } from 'node:child_process'
import { dirname, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

const INSTALL_MODES = ['npm', 'none']

/** Print a GitHub Actions warning annotation. */
export function warn(message) {
  console.log(`::warning::${message}`)
}

/** Print a GitHub Actions error annotation. */
export function fail(message) {
  console.log(`::error::${message}`)
}

/** Return the endpoint with exactly one trailing slash. */
export function registryUrl(endpoint) {
  return `${endpoint.replace(/\/+$/, '')}/`
}

/** Read the install options from the environment. */
export function resolveOptions(env) {
  return {
    install: (env.INSTALL ?? env.INPUT_INSTALL ?? 'npm').trim(),
    endpoint: env.ENDPOINT ?? env.INPUT_ENDPOINT ?? '',
    lockfile: env.LOCKFILE ?? env.INPUT_LOCKFILE ?? 'package-lock.json',
    cwd: env.CWD ?? process.cwd(),
  }
}

/** Run one command with inherited output. Resolve with its exit code. */
function runNpm(args, cwd, spawnFn) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawnFn('npm', args, { cwd, stdio: 'inherit' })
    } catch (err) {
      console.log(`could not start npm: ${err.message}`)
      resolveRun(1)
      return
    }
    child.on('error', (err) => {
      console.log(`could not start npm: ${err.message}`)
      resolveRun(1)
    })
    child.on('close', (code) => resolveRun(code ?? 1))
  })
}

/**
 * Install the project's dependencies. Returns an exit code and never calls
 * process.exit, so tests can inspect the result.
 *
 * - `install: none` does nothing and returns 0.
 * - Any other value except `npm` is a configuration error and returns 1.
 * - `npm ci --registry <endpoint>` that fails falls back to plain `npm ci`.
 * - A failing plain `npm ci` returns its failure, so the job fails.
 */
export async function install(options, { spawnFn = spawn } = {}) {
  const { install: mode, endpoint, lockfile, cwd } = options
  if (!INSTALL_MODES.includes(mode)) {
    fail(`install must be 'npm' or 'none', got '${mode}'`)
    return 1
  }
  if (mode === 'none') return 0

  const workDir = dirname(resolvePath(cwd, lockfile))

  if (endpoint) {
    const code = await runNpm(['ci', '--registry', registryUrl(endpoint)], workDir, spawnFn)
    if (code === 0) return 0
    warn('AuPM registry install failed; installing from the npm registry instead.')
  } else {
    warn('no endpoint configured; installing from the npm registry instead.')
  }

  return runNpm(['ci'], workDir, spawnFn)
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  process.exitCode = await install(resolveOptions(process.env))
}
