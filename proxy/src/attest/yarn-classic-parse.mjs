// proxy/src/attest/yarn-classic-parse.mjs
//
// Hand-written parser for the yarn classic (v1) `yarn.lock` format. Linear
// time, no dependency. It runs in the parse worker (ADR 0018) and returns
// plain data; the main thread classifies the entries. Plain JavaScript on
// purpose, as yaml-worker.mjs is: a worker needs no TypeScript loader.
//
// Throws a YarnParseError whose message names the 1-based line number.

export class YarnParseError extends Error {}

const FIELD_KEYS = new Set(['version', 'resolved', 'integrity'])

function fail(lineNo, text) {
  throw new YarnParseError(`yarn.lock line ${lineNo}: ${text}`)
}

/** Reads a double-quoted string that starts at `start`. Returns the value and the next index. */
function readQuoted(line, start, lineNo) {
  let i = start + 1
  while (i < line.length) {
    const ch = line[i]
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === '"') {
      try {
        return { value: JSON.parse(line.slice(start, i + 1)), next: i + 1 }
      } catch {
        return fail(lineNo, 'invalid escape in quoted string')
      }
    }
    i += 1
  }
  return fail(lineNo, 'unterminated quote')
}

/** Splits a block header (without the trailing colon) into selectors. */
function parseSelectors(text, lineNo) {
  const selectors = []
  let i = 0
  while (i <= text.length) {
    while (text[i] === ' ') i += 1
    if (text[i] === '"') {
      const { value, next } = readQuoted(text, i, lineNo)
      selectors.push(value)
      i = next
      while (text[i] === ' ') i += 1
      if (i < text.length && text[i] !== ',')
        fail(lineNo, 'unexpected text after a quoted selector')
    } else {
      let end = text.indexOf(',', i)
      if (end === -1) end = text.length
      selectors.push(text.slice(i, end).trim())
      i = end
    }
    i += 1
  }
  return selectors
}

/** `@scope/name@^1` -> `@scope/name`; `name@^1` -> `name`. Null when there is no version part. */
function selectorName(selector) {
  const at = selector.indexOf('@', 1)
  return at <= 0 ? null : selector.slice(0, at)
}

function parseHeader(line, lineNo, seenSelectors) {
  const selectors = parseSelectors(line.slice(0, -1), lineNo)
  let name = null
  for (const selector of selectors) {
    const own = selectorName(selector)
    if (own === null) fail(lineNo, `selector "${selector}" has no version part`)
    if (name !== null && own !== name)
      fail(lineNo, 'selectors in one block name different packages')
    if (seenSelectors.has(selector)) fail(lineNo, `duplicate block header "${selector}"`)
    seenSelectors.add(selector)
    name = own
  }
  return { name, headerLine: lineNo, version: null, integrity: null, resolved: null }
}

/** Parses `key value` from a two-space-indented field line. */
function parseField(content, lineNo) {
  const space = content.indexOf(' ')
  if (space === -1) return fail(lineNo, 'expected a field with a value')
  const key = content.slice(0, space)
  const rest = content.slice(space + 1).trimStart()
  if (rest.startsWith('"')) {
    const { value, next } = readQuoted(rest, 0, lineNo)
    if (rest.slice(next).trim() !== '') fail(lineNo, 'unexpected text after a quoted value')
    return { key, value }
  }
  return { key, value: rest.trim() }
}

function applyField(block, content, lineNo) {
  const { key, value } = parseField(content, lineNo)
  if (!FIELD_KEYS.has(key)) return
  if (block[key] !== null) fail(lineNo, `duplicate "${key}" field in one block`)
  block[key] = value
}

function finishBlock(block) {
  if (block.version === null || block.version === '') {
    fail(block.headerLine, 'block has no "version" field')
  }
  return {
    name: block.name,
    version: block.version,
    integrity: block.integrity,
    resolved: block.resolved,
  }
}

/** Returns the line indent: the count of leading spaces. A tab is an error. */
function indentOf(line, lineNo) {
  let n = 0
  while (line[n] === ' ') n += 1
  if (line[n] === '\t') fail(lineNo, 'a tab is not valid indentation')
  return n
}

/**
 * Parses the body of a yarn classic lockfile.
 * @param {string} text the lockfile text (any BOM already removed)
 * @returns {{ name: string, version: string, integrity: string | null, resolved: string | null }[]}
 */
export function parseYarnClassic(text) {
  const entries = []
  const seenSelectors = new Set()
  let block = null
  const lines = text.split('\n')
  for (let index = 0; index < lines.length; index += 1) {
    const lineNo = index + 1
    const line = (lines[index] ?? '').replace(/\r$/, '')
    if (line.trim() === '' || line.startsWith('#')) continue
    const indent = indentOf(line, lineNo)
    if (indent === 0) {
      if (block !== null) entries.push(finishBlock(block))
      if (!line.endsWith(':')) fail(lineNo, 'expected a block header that ends with a colon')
      block = parseHeader(line, lineNo, seenSelectors)
    } else if (block === null) {
      fail(lineNo, 'field outside a block')
    } else if (indent === 2) {
      // A sub-section such as `dependencies:` ends in a colon and has no value.
      if (!line.endsWith(':')) applyField(block, line.slice(2), lineNo)
    } else if (indent !== 4) {
      fail(lineNo, 'unexpected indentation')
    }
  }
  if (block !== null) entries.push(finishBlock(block))
  return entries
}
