// Pure logic shared by scripts/anchor-review.mjs (the auditor's machine)
// and scripts/record-review.mjs (the operator's machine) — SPEC §14, ADR
// 0007. No I/O, no network, no chain: every function here takes plain data
// and either returns a value or throws a clear Error. This is what makes
// the review flow testable under plain `node --test`, with no TTY, no
// network and no facilitator involved (this is the auditor's own
// self-payment, sent by algod — never the facilitator, never the proxy).

// ARC-2 prefix for the review anchor's note (`spm:j{...}`, SPEC §14).
export const NOTE_PREFIX = 'spm:j'

/**
 * Encodes one review's fields into the ARC-2 JSON note bytes the auditor's
 * anchor transaction carries.
 *
 * @param {{name: string, version: string, integrity: string, reviewer: string, scope: string}} fields
 *   `reviewer` must already be "github:<login>" — callers build that prefix
 *   themselves, never this function (mirrors status.ts's reviewerIdentity()
 *   convention: the prefix is applied at the boundary, not stored bare).
 * @returns {Uint8Array}
 */
export function encodeReviewNote({ name, version, integrity, reviewer, scope }) {
  const note = { v: 1, name, version, integrity, reviewer, scope }
  return new TextEncoder().encode(NOTE_PREFIX + JSON.stringify(note))
}

/**
 * Decodes and validates a review anchor's note bytes (or its plain string
 * form, for tests). Throws on anything that is not exactly the expected
 * ARC-2 `spm:j{...}` shape — a malformed note must never resolve to a
 * partially-trusted record (SPEC §14, §12.4).
 *
 * @param {Uint8Array|string} noteBytes
 * @returns {{v: 1, name: string, version: string, integrity: string, reviewer: string, scope: string}}
 */
export function decodeReviewNote(noteBytes) {
  const text = typeof noteBytes === 'string' ? noteBytes : new TextDecoder().decode(noteBytes)
  if (!text.startsWith(NOTE_PREFIX)) {
    throw new Error(`review note does not carry the "${NOTE_PREFIX}" ARC-2 prefix`)
  }
  let parsed
  try {
    parsed = JSON.parse(text.slice(NOTE_PREFIX.length))
  } catch {
    throw new Error('review note JSON is malformed')
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('review note JSON is not an object')
  }
  const { v, name, version, integrity, reviewer, scope } = parsed
  if (v !== 1) throw new Error(`review note "v" must be 1, got ${JSON.stringify(v)}`)
  for (const [key, value] of Object.entries({ name, version, integrity, scope })) {
    if (typeof value !== 'string' || value.length === 0) {
      throw new Error(`review note "${key}" must be a non-empty string`)
    }
  }
  if (typeof reviewer !== 'string' || !reviewer.startsWith('github:') || reviewer.length <= 7) {
    throw new Error('review note "reviewer" must be "github:<login>"')
  }
  return { v, name, version, integrity, reviewer, scope }
}

/**
 * Parses the `AUDITORS` env var (`github:<login>=<address>,...`) into a
 * Map keyed by the bare login (matches status.ts's `reviewer` column
 * convention — never "github:alice" as the map value's own identity, only
 * as its key's source string here).
 *
 * @param {string|undefined} envValue
 * @returns {Map<string, string>} login (bare, e.g. "alice") -> address
 */
export function parseAuditors(envValue) {
  const map = new Map()
  if (!envValue || envValue.trim().length === 0) return map
  for (const rawPair of envValue.split(',')) {
    const pair = rawPair.trim()
    if (pair.length === 0) continue
    const eq = pair.indexOf('=')
    if (eq === -1) throw new Error(`malformed AUDITORS entry (no "="): ${JSON.stringify(pair)}`)
    const loginField = pair.slice(0, eq).trim()
    const address = pair.slice(eq + 1).trim()
    if (!loginField.startsWith('github:') || loginField.length <= 7) {
      throw new Error(`malformed AUDITORS entry (login must be "github:<login>"): ${pair}`)
    }
    if (address.length === 0) {
      throw new Error(`malformed AUDITORS entry (empty address): ${pair}`)
    }
    map.set(loginField.slice('github:'.length), address)
  }
  return map
}

/**
 * The bare GitHub login mapped to `address` in `auditors`, or null when no
 * entry maps to it. Never the reverse of address-hiding: this is how
 * record-review.mjs turns an anchor's sender address into an identity to
 * check against the note's own claimed reviewer.
 *
 * @param {Map<string, string>} auditors
 * @param {string} address
 * @returns {string|null}
 */
export function loginForAddress(auditors, address) {
  for (const [login, mapped] of auditors) {
    if (mapped === address) return login
  }
  return null
}

/**
 * Resolves the repo-pool key for `name` from the npm packument's
 * `repository` field for the reviewed version (SPEC §13.1): the GitHub
 * `owner/repo`, when the field names a GitHub repo, else `npm:<name>`.
 *
 * @param {string} name
 * @param {unknown} repository - the packument version's `repository` field.
 * @returns {string}
 */
export function resolveRepoKey(name, repository) {
  const npmFallback = `npm:${name}`
  const url =
    typeof repository === 'string'
      ? repository
      : repository !== null && typeof repository === 'object' && 'url' in repository
        ? /** @type {{url?: unknown}} */ (repository).url
        : null
  if (typeof url !== 'string' || url.length === 0) return npmFallback

  const shorthand = url.match(/^github:([^/\s]+)\/([^/\s#]+?)(?:\.git)?$/)
  if (shorthand) return `${shorthand[1]}/${shorthand[2]}`

  const stripped = url.replace(/^git\+/, '')
  let parsed
  try {
    parsed = new URL(stripped)
  } catch {
    return npmFallback
  }
  if (parsed.hostname !== 'github.com') return npmFallback

  const parts = parsed.pathname
    .replace(/^\//, '')
    .replace(/\.git$/, '')
    .split('/')
  if (parts.length < 2 || !parts[0] || !parts[1]) return npmFallback
  return `${parts[0]}/${parts[1]}`
}

/**
 * Fetches the npm packument for `name` (registry.npmjs.org). Scoped names
 * (one `/`) are percent-encoded the way the registry expects.
 *
 * @param {string} name
 * @param {typeof fetch} [fetchImpl] - injectable for tests; defaults to the
 *   global fetch.
 * @returns {Promise<unknown>}
 */
export async function fetchNpmPackument(name, fetchImpl = fetch) {
  const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`
  const res = await fetchImpl(url)
  if (!res.ok) {
    throw new Error(`npm registry returned ${res.status} for ${name}`)
  }
  return res.json()
}

/**
 * The `dist.integrity` string npm published for `name@version`.
 *
 * @param {unknown} packument
 * @param {string} name
 * @param {string} version
 * @returns {string}
 */
export function distIntegrityForVersion(packument, name, version) {
  const versionDoc = /** @type {any} */ (packument)?.versions?.[version]
  if (!versionDoc) throw new Error(`npm has no published version ${name}@${version}`)
  const integrity = versionDoc.dist?.integrity
  if (typeof integrity !== 'string' || integrity.length === 0) {
    throw new Error(`npm dist.integrity is missing for ${name}@${version}`)
  }
  return integrity
}

/**
 * The `repository` field npm published for `name@version` — the
 * version-level field when present, else the packument's top-level field
 * (npm falls back the same way for a version that omits its own).
 *
 * @param {unknown} packument
 * @param {string} version
 * @returns {unknown}
 */
export function repositoryForVersion(packument, version) {
  const pkg = /** @type {any} */ (packument)
  return pkg?.versions?.[version]?.repository ?? pkg?.repository
}

/**
 * Throws unless `tx` is a confirmed, 0-microAlgo, self-to-self payment —
 * the shape a review anchor must have (SPEC §14). Accepts the indexer
 * Transaction shape (camelCase, as algosdk v3's Indexer client returns it).
 *
 * @param {{txType?: string, sender: string, paymentTransaction?: {amount: bigint|number, receiver: string}, confirmedRound?: bigint|number}} tx
 */
export function checkIsSelfZeroPayment(tx) {
  if (tx.txType !== 'pay' || !tx.paymentTransaction) {
    throw new Error('anchor is not a payment transaction')
  }
  if (Number(tx.paymentTransaction.amount) !== 0) {
    throw new Error('anchor is not a 0-ALGO payment')
  }
  if (tx.paymentTransaction.receiver !== tx.sender) {
    throw new Error('anchor is not a self-payment (sender must equal receiver)')
  }
  if (tx.confirmedRound === undefined || tx.confirmedRound === null) {
    throw new Error('anchor transaction is not confirmed')
  }
}

/**
 * Throws unless `sender` is a mapped auditor address whose login equals the
 * note's own claimed `reviewer`. Returns the bare login on success (for
 * status.ts's `reviewer` column, which never carries the "github:" prefix).
 *
 * @param {{sender: string, note: {reviewer: string}, auditors: Map<string, string>}} args
 * @returns {string} bare GitHub login
 */
export function checkSenderIsMappedAuditor({ sender, note, auditors }) {
  const login = loginForAddress(auditors, sender)
  if (!login) {
    throw new Error(`anchor sender ${sender} is not a mapped auditor address (AUDITORS)`)
  }
  const claimed = note.reviewer.slice('github:'.length)
  if (claimed !== login) {
    throw new Error(
      `note reviewer "github:${claimed}" does not match the login mapped to sender ${sender} ("github:${login}")`,
    )
  }
  return login
}

/**
 * Throws unless the note's claimed integrity equals npm's own
 * `dist.integrity` for that exact version (SPEC §14, §12.4) — the fact that
 * binds the review to one specific tarball.
 *
 * @param {{integrity: string}} note
 * @param {string} npmIntegrity
 */
export function checkIntegrityMatchesNpm(note, npmIntegrity) {
  if (note.integrity !== npmIntegrity) {
    throw new Error(
      `note integrity ${note.integrity} does not match npm dist.integrity ${npmIntegrity}`,
    )
  }
}
