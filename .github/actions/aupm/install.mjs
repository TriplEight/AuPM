#!/usr/bin/env node
// Install step of the aupm Action. It finds the lockfile, picks npm, pnpm or
// yarn classic, and installs through the AuPM registry. It falls back to the
// same command against the public registry. It uses the caller's Node and
// package managers, so it runs before the Action sets up its own toolchain.
// Dependency-free.
//
// An AuPM registry failure never fails the job: the script falls back to the
// public registry. A failure of the fallback fails the job, the same as a
// plain install step. The step writes the resolved lockfile path to
// GITHUB_OUTPUT, so the check step reads the same file.

import { spawn } from 'node:child_process'
import { appendFileSync, existsSync } from 'node:fs'
import { basename, dirname, resolve as resolvePath } from 'node:path'
import { pathToFileURL } from 'node:url'

const INSTALL_VALUES = ['auto', 'npm', 'pnpm', 'yarn', 'none']

const LOCKFILES = {
  npm: 'package-lock.json',
  pnpm: 'pnpm-lock.yaml',
  yarn: 'yarn.lock',
}

const FROZEN_ARGS = {
  npm: ['ci'],
  pnpm: ['install', '--frozen-lockfile'],
  yarn: ['install', '--frozen-lockfile'],
}

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
    install: (env.INSTALL ?? env.INPUT_INSTALL ?? 'auto').trim(),
    endpoint: env.ENDPOINT ?? env.INPUT_ENDPOINT ?? '',
    lockfile: (env.LOCKFILE ?? env.INPUT_LOCKFILE ?? '').trim(),
    cwd: env.CWD ?? process.cwd(),
  }
}

function toolForLockfile(lockfile) {
  const name = basename(lockfile)
  return Object.keys(LOCKFILES).find((tool) => LOCKFILES[tool] === name)
}

/** Find the one lockfile in the working directory. Returns { tool } or { error }. */
function detectLockfile(cwd) {
  const found = Object.keys(LOCKFILES).filter((tool) =>
    existsSync(resolvePath(cwd, LOCKFILES[tool])),
  )
  if (found.length === 1) return { tool: found[0], lockfile: LOCKFILES[found[0]] }
  const names = Object.values(LOCKFILES).join(', ')
  if (found.length === 0) {
    return { error: `no lockfile found in ${cwd}; looked for ${names}` }
  }
  const present = found.map((tool) => LOCKFILES[tool]).join(', ')
  return {
    error: `found more than one lockfile (${present}); set 'lockfile' or 'install' to choose one`,
  }
}

/**
 * Decide the package manager and the lockfile path.
 * Returns { tool, lockfile } or { error }. `tool` is undefined for `install: none`
 * with an explicit lockfile of any name.
 */
export function resolvePlan({ install: mode, lockfile, cwd }) {
  if (!INSTALL_VALUES.includes(mode)) {
    return {
      error: `install must be 'auto', 'npm', 'pnpm', 'yarn' or 'none', got '${mode}'`,
    }
  }
  if (mode === 'none') {
    if (lockfile) return { lockfile }
    const detected = detectLockfile(cwd)
    return detected.error ? detected : { lockfile: detected.lockfile }
  }
  if (mode !== 'auto') return { tool: mode, lockfile: lockfile || LOCKFILES[mode] }
  if (!lockfile) return detectLockfile(cwd)
  const tool = toolForLockfile(lockfile)
  if (!tool) {
    return {
      error:
        `cannot choose a package manager for lockfile '${lockfile}'; ` +
        `use one of ${Object.values(LOCKFILES).join(', ')} or set 'install'`,
    }
  }
  return { tool, lockfile }
}

/** Run one command with inherited output. Resolve with its exit code. */
function runCommand(command, args, { cwd, env }, spawnFn) {
  return new Promise((resolveRun) => {
    let child
    const spawnOptions = env ? { cwd, env, stdio: 'inherit' } : { cwd, stdio: 'inherit' }
    try {
      child = spawnFn(command, args, spawnOptions)
    } catch (err) {
      console.log(`could not start ${command}: ${err.message}`)
      resolveRun(1)
      return
    }
    child.on('error', (err) => {
      console.log(`could not start ${command}: ${err.message}`)
      resolveRun(1)
    })
    child.on('close', (code) => resolveRun(code ?? 1))
  })
}

/** Run `yarn --version`. Resolve with { stdout } or { error }. */
function readYarnVersion(cwd, spawnFn) {
  return new Promise((resolveRun) => {
    let child
    try {
      child = spawnFn('yarn', ['--version'], { cwd, stdio: ['ignore', 'pipe', 'inherit'] })
    } catch (err) {
      resolveRun({ error: err.message })
      return
    }
    let stdout = ''
    child.stdout?.on('data', (chunk) => {
      stdout += chunk
    })
    child.on('error', (err) => resolveRun({ error: err.message }))
    child.on('close', (code) =>
      resolveRun(code === 0 ? { stdout } : { error: `yarn --version exited with code ${code}` }),
    )
  })
}

/** Classify a yarn version: 'classic', 'berry' or an error. */
function classifyYarn(result) {
  if (result.error) return { error: `could not run yarn --version: ${result.error}` }
  const version = result.stdout.trim()
  const match = /^(\d+)\.\d+\.\d+/.exec(version)
  if (!match) return { error: `yarn --version printed '${version}', not a version number` }
  return { kind: match[1] === '1' ? 'classic' : 'berry' }
}

/** Install through the AuPM registry, then through the public registry on failure. */
async function installWithFallback({ tool, endpoint, workDir }, spawnFn) {
  const args = FROZEN_ARGS[tool]
  if (endpoint) {
    const url = registryUrl(endpoint)
    const code =
      tool === 'npm'
        ? await runCommand(tool, [...args, '--registry', url], { cwd: workDir }, spawnFn)
        : await runCommand(
            tool,
            args,
            { cwd: workDir, env: { ...process.env, npm_config_registry: url } },
            spawnFn,
          )
    if (code === 0) return 0
    warn('AuPM registry install failed; installing from the npm registry instead.')
  } else {
    warn('no endpoint configured; installing from the npm registry instead.')
  }
  return runCommand(tool, args, { cwd: workDir }, spawnFn)
}

function writeOutputs(file, values) {
  if (!file) return
  appendFileSync(
    file,
    Object.entries(values)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  )
}

/** Install with yarn. Berry installs without AuPM and sets skipCheck. */
async function installYarn({ endpoint, workDir, outputFile }, spawnFn) {
  const yarn = classifyYarn(await readYarnVersion(workDir, spawnFn))
  if (yarn.error) {
    fail(yarn.error)
    return 1
  }
  if (yarn.kind === 'classic') {
    return installWithFallback({ tool: 'yarn', endpoint, workDir }, spawnFn)
  }
  warn('AuPM does not support yarn berry yet; installing without AuPM and skipping the check.')
  writeOutputs(outputFile, { 'skip-check': 'true' })
  return runCommand('yarn', ['install', '--immutable'], { cwd: workDir }, spawnFn)
}

/**
 * Install the project's dependencies. Returns an exit code and never calls
 * process.exit, so tests can inspect the result.
 *
 * - An unknown `install` value, a missing or ambiguous lockfile, and a lockfile
 *   of an unknown name with `install: auto` return 1.
 * - The resolved lockfile path goes to `outputFile` as `lockfile=<path>`.
 * - `install: none` installs nothing and returns 0.
 * - A command that fails through the AuPM registry falls back to the same command
 *   against the public registry. A failing fallback returns its failure.
 * - yarn berry installs with `yarn install --immutable`, without AuPM, and writes
 *   `skip-check=true`.
 */
export async function install(
  options,
  { spawnFn = spawn, outputFile = process.env.GITHUB_OUTPUT } = {},
) {
  const plan = resolvePlan(options)
  if (plan.error) {
    fail(plan.error)
    return 1
  }
  writeOutputs(outputFile, { lockfile: plan.lockfile })
  if (!plan.tool) return 0

  const workDir = dirname(resolvePath(options.cwd, plan.lockfile))
  if (plan.tool === 'yarn') {
    return installYarn({ endpoint: options.endpoint, workDir, outputFile }, spawnFn)
  }
  return installWithFallback({ tool: plan.tool, endpoint: options.endpoint, workDir }, spawnFn)
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  process.exitCode = await install(resolveOptions(process.env))
}
