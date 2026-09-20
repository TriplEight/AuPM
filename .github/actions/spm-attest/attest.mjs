#!/usr/bin/env node
// spm-attest: posts a lockfile to the SPM attestation server and writes the
// signed envelope to disk. Fails open on every error except an explicit
// integrity-mismatch failure (see run()).

import { readFileSync, writeFileSync } from 'node:fs'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { pathToFileURL } from 'node:url'

const DEFAULT_LOCKFILE = 'package-lock.json'
const DEFAULT_OUTPUT = 'spm-attestation.json'
const REQUEST_TIMEOUT_MS = 15000

/** Print a GitHub Actions warning annotation. */
export function warn(message) {
  console.log(`::warning::${message}`)
}

/** Convert an input value (string or boolean) to a strict boolean. */
export function normalizeBool(value) {
  if (typeof value === 'boolean') return value
  return (
    String(value ?? '')
      .trim()
      .toLowerCase() === 'true'
  )
}

/** Parse `--flag value` pairs from an argv slice. */
export function parseArgs(argv) {
  const out = {}
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    out[key] = argv[i + 1]
    i += 1
  }
  return out
}

/**
 * Merge CLI args and environment variables into a single options object.
 *
 * CAUTION: this action never reads a wallet secret. It cannot perform an
 * x402 payment (that needs a signed payment payload, not a bare secret), so
 * it does not accept one. Any leftover WALLET_SECRET / INPUT_WALLET_SECRET /
 * --wallet-secret from an old workflow is intentionally ignored here — see
 * README.md "Paid attestation".
 */
export function resolveOptions(argv, env) {
  const cli = parseArgs(argv)
  return {
    endpoint: cli.endpoint ?? env.ENDPOINT ?? env.INPUT_ENDPOINT ?? '',
    lockfile: cli.lockfile ?? env.LOCKFILE ?? env.INPUT_LOCKFILE ?? DEFAULT_LOCKFILE,
    failOnMismatch:
      cli['fail-on-mismatch'] ?? env.FAIL_ON_MISMATCH ?? env.INPUT_FAIL_ON_MISMATCH ?? 'false',
    output: cli.output ?? env.OUTPUT ?? env.INPUT_OUTPUT ?? DEFAULT_OUTPUT,
  }
}

/**
 * POST raw bytes to an endpoint once. Never parses or re-serialises the
 * body — the server signs a digest of the exact bytes it receives.
 *
 * CAUTION: this takes no extra-headers parameter on purpose. This action
 * has no credential it is safe to put in a request header. Do not add one
 * back without re-reading the "Paid attestation" section of README.md.
 */
export function postOnce(endpoint, bodyBytes) {
  return new Promise((resolve, reject) => {
    let target
    try {
      target = new URL(endpoint)
    } catch (err) {
      reject(new Error(`invalid endpoint URL "${endpoint}": ${err.message}`))
      return
    }

    const requester = target.protocol === 'https:' ? httpsRequest : httpRequest
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(bodyBytes),
    }

    const req = requester(target, { method: 'POST', headers }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ statusCode: res.statusCode ?? 0, body: Buffer.concat(chunks) })
      })
      res.on('error', reject)
    })

    req.setTimeout(REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error(`request to ${endpoint} timed out`))
    })
    req.on('error', reject)
    req.write(bodyBytes)
    req.end()
  })
}

/**
 * Run the full attest flow. Returns an exit code — never calls
 * process.exit itself, so callers (including tests) can inspect the result.
 * Fails open: every caught error returns 0. The single exception is a
 * reported integrityMismatch above zero when failOnMismatch is true.
 */
export async function run(options) {
  const {
    endpoint,
    lockfile = DEFAULT_LOCKFILE,
    failOnMismatch = false,
    output = DEFAULT_OUTPUT,
  } = options

  try {
    if (!endpoint) {
      warn('no endpoint configured; skipping attestation')
      return 0
    }

    let bytes
    try {
      bytes = readFileSync(lockfile)
    } catch (err) {
      warn(`could not read lockfile "${lockfile}": ${err.message}`)
      return 0
    }

    let response
    try {
      response = await postOnce(endpoint, bytes)
    } catch (err) {
      warn(`request to ${endpoint} failed: ${err.message}`)
      return 0
    }

    if (response.statusCode === 402) {
      // This action never pays. Paying needs a signed x402 payment payload,
      // not a bare secret, and this action has no signer. Sending a secret
      // as a header would only leak it to whatever `endpoint` is configured
      // to — see README.md "Paid attestation" for the CLI / MCP path.
      warn(
        `paid route (${endpoint}) returned 402; this action does not pay. ` +
          'Use the spm CLI or the MCP server for paid attestation. Skipping.',
      )
      return 0
    }

    if (response.statusCode < 200 || response.statusCode >= 300) {
      warn(`server returned status ${response.statusCode}`)
      return 0
    }

    let parsed
    try {
      parsed = JSON.parse(response.body.toString('utf8'))
    } catch (err) {
      warn(`could not parse server response: ${err.message}`)
      return 0
    }

    const summary = parsed?.summary
    const attestation = parsed?.attestation
    if (!attestation) {
      warn('server response is missing an attestation envelope')
      return 0
    }

    try {
      writeFileSync(output, JSON.stringify(attestation, null, 2))
    } catch (err) {
      warn(`could not write output file "${output}": ${err.message}`)
      return 0
    }

    const mismatchCount = summary?.integrityMismatch ?? 0
    if (normalizeBool(failOnMismatch) && mismatchCount > 0) {
      warn(`integrityMismatch is ${mismatchCount}; failing per fail-on-mismatch`)
      return 1
    }

    return 0
  } catch (err) {
    warn(`unexpected error: ${err?.message ?? err}`)
    return 0
  }
}

function isMainModule() {
  const entry = process.argv[1]
  if (!entry) return false
  return import.meta.url === pathToFileURL(entry).href
}

if (isMainModule()) {
  const options = resolveOptions(process.argv.slice(2), process.env)
  const code = await run(options)
  process.exitCode = code
}
