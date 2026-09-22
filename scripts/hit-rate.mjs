#!/usr/bin/env node
// scripts/hit-rate.mjs
//
// Measures the seed-list hit rate against real package-lock.json files
// (SPEC.md §11.2). This script never writes to any database and never
// creates a review record — it only reads lockfiles and prints a report.

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const USAGE = 'usage: node scripts/hit-rate.mjs <candidates.txt> <lockfile-or-dir>...'

/**
 * Parses a candidate list file into a distinct set of package names.
 * Blank lines and `#`-prefixed comments are ignored.
 * @param {string} text Raw file contents.
 * @returns {string[]} Distinct candidate names, in first-seen order.
 */
export function parseCandidates(text) {
  const seen = new Set()
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    seen.add(line)
  }
  return [...seen]
}

/**
 * Extracts the package name from a lockfileVersion 2/3 `packages` map key.
 * The name is the segment after the last `node_modules/`.
 * @param {string} key A key from the `packages` map.
 * @returns {string} The package name.
 */
function nameFromPackagesKey(key) {
  const idx = key.lastIndexOf('node_modules/')
  const tail = key.slice(idx + 'node_modules/'.length)
  return tail
}

/**
 * Extracts distinct package names from a lockfileVersion 2 or 3 `packages` map.
 * @param {Record<string, object>} packages The `packages` map.
 * @returns {Set<string>} Distinct package names.
 */
function namesFromPackagesMap(packages) {
  const names = new Set()
  for (const [key, entry] of Object.entries(packages)) {
    if (key === '') continue
    if (entry && entry.link === true) continue
    names.add(nameFromPackagesKey(key))
  }
  return names
}

/**
 * Recursively collects distinct package names from a lockfileVersion 1
 * `dependencies` map, which nests transitive dependencies under each entry.
 * @param {Record<string, object>} deps A `dependencies` map.
 * @param {Set<string>} names Accumulator set, mutated in place.
 */
function collectV1Names(deps, names) {
  for (const [name, entry] of Object.entries(deps)) {
    names.add(name)
    if (entry?.dependencies) {
      collectV1Names(entry.dependencies, names)
    }
  }
}

/**
 * Parses a package-lock.json document (already JSON-parsed) into the set
 * of distinct package names it contains.
 * @param {object} doc Parsed package-lock.json contents.
 * @param {string} filePath Path, used only for error messages.
 * @returns {Set<string>} Distinct package names.
 */
export function lockfileNames(doc, filePath) {
  if (doc == null || typeof doc !== 'object') {
    throw new Error(`${filePath}: not a valid package-lock.json object`)
  }
  const version = doc.lockfileVersion
  if (version === 2 || version === 3) {
    if (doc.packages == null || typeof doc.packages !== 'object') {
      throw new Error(`${filePath}: lockfileVersion ${version} missing "packages" map`)
    }
    return namesFromPackagesMap(doc.packages)
  }
  if (version === 1) {
    const names = new Set()
    if (doc.dependencies && typeof doc.dependencies === 'object') {
      collectV1Names(doc.dependencies, names)
    }
    return names
  }
  throw new Error(`${filePath}: unsupported or missing lockfileVersion (${String(version)})`)
}

/**
 * Computes the median of a numeric array. Even-length arrays average the
 * two middle values.
 * @param {number[]} values Numbers to summarize.
 * @returns {number} The median, or NaN for an empty array.
 */
export function median(values) {
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Recursively finds every `package-lock.json` file under a directory,
 * skipping any `node_modules` directory.
 * @param {string} dir Directory to search.
 * @returns {string[]} Absolute-relative paths of lockfiles found.
 */
function findLockfiles(dir) {
  const found = []
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name === 'node_modules') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      found.push(...findLockfiles(full))
    } else if (entry.isFile() && entry.name === 'package-lock.json') {
      found.push(full)
    }
  }
  return found
}

/**
 * Expands a list of CLI path arguments into a flat, sorted list of
 * lockfile paths. A directory contributes every `package-lock.json` found
 * directly or recursively inside it.
 * @param {string[]} paths File or directory paths.
 * @returns {string[]} Lockfile paths.
 */
function expandLockfilePaths(paths) {
  const files = []
  for (const path of paths) {
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files.push(...findLockfiles(path))
    } else {
      files.push(path)
    }
  }
  return files
}

/**
 * Reads and parses one lockfile into its distinct package name set.
 * @param {string} filePath Path to a package-lock.json file.
 * @returns {Set<string>} Distinct package names in the lockfile.
 */
function readLockfile(filePath) {
  let text
  try {
    text = readFileSync(filePath, 'utf8')
  } catch (err) {
    throw new Error(`${filePath}: cannot read file (${err.message})`)
  }
  let doc
  try {
    doc = JSON.parse(text)
  } catch (err) {
    throw new Error(`${filePath}: malformed JSON (${err.message})`)
  }
  return lockfileNames(doc, filePath)
}

/**
 * Measures candidate hit rate across a set of lockfiles.
 * @param {string[]} candidates Distinct candidate package names.
 * @param {string[]} lockfilePaths Lockfile file paths to measure.
 * @returns {{
 *   rows: {file: string, total: number, hits: number}[],
 *   hitsCounts: number[],
 *   frequency: Map<string, number>,
 * }} Per-file rows, the hits-per-file array, and per-candidate frequency.
 */
export function measure(candidates, lockfilePaths) {
  const rows = []
  const hitsCounts = []
  const frequency = new Map(candidates.map((name) => [name, 0]))
  for (const filePath of lockfilePaths) {
    const names = readLockfile(filePath)
    let hits = 0
    for (const candidate of candidates) {
      if (names.has(candidate)) {
        hits += 1
        frequency.set(candidate, frequency.get(candidate) + 1)
      }
    }
    rows.push({ file: filePath, total: names.size, hits })
    hitsCounts.push(hits)
  }
  return { rows, hitsCounts, frequency }
}

function formatMedian(value) {
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

function printReport(rows, hitsCounts, frequency, lockfileCount) {
  console.log('file\ttotal_packages\thits')
  for (const row of rows) {
    console.log(`${row.file}\t${row.total}\t${row.hits}`)
  }
  const med = median(hitsCounts)
  const min = hitsCounts.length ? Math.min(...hitsCounts) : Number.NaN
  const max = hitsCounts.length ? Math.max(...hitsCounts) : Number.NaN
  console.log('')
  console.log(`files: ${lockfileCount}`)
  console.log(`median hits: ${formatMedian(med)}`)
  console.log(`min hits: ${min}`)
  console.log(`max hits: ${max}`)
  console.log('')
  console.log('candidate frequency (lockfiles containing it, descending):')
  const sortedFreq = [...frequency.entries()].sort((a, b) => b[1] - a[1])
  for (const [name, count] of sortedFreq) {
    console.log(`${count}\t${name}`)
  }
  if (lockfileCount < 20) {
    console.log(`WARNING: only ${lockfileCount} lockfiles given; SPEC.md §11.2 asks for 20`)
  }
  if (med < 5) {
    console.log('VERDICT: seed list too weak (median < 5)')
  } else {
    console.log('VERDICT: median >= 5')
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.length < 2) {
    console.error(USAGE)
    process.exit(2)
  }
  const [candidatesPath, ...lockfileArgs] = args
  let candidatesText
  try {
    candidatesText = readFileSync(candidatesPath, 'utf8')
  } catch (err) {
    console.error(`error: cannot read ${candidatesPath}: ${err.message}`)
    process.exit(1)
  }
  const candidates = parseCandidates(candidatesText)

  let lockfilePaths
  try {
    lockfilePaths = expandLockfilePaths(lockfileArgs)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }
  if (lockfilePaths.length === 0) {
    console.error('error: no package-lock.json files found in the given arguments')
    process.exit(1)
  }

  let result
  try {
    result = measure(candidates, lockfilePaths)
  } catch (err) {
    console.error(`error: ${err.message}`)
    process.exit(1)
  }

  printReport(result.rows, result.hitsCounts, result.frequency, lockfilePaths.length)
  process.exit(0)
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
