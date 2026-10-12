// Pure logic used by scripts/record-review.mjs (the operator's machine) and
// its tests — SPEC §14, ADR 0007. The auditor's anchor is sent by
// `aupm auditor review` (cli/src/auditor*.ts).
//
// No I/O, no network, no chain: every function here takes plain data
// and either returns a value or throws a clear Error. This is what makes
// the review flow testable under plain `node --test`, with no TTY, no
// network and no facilitator involved (this is the auditor's own
// self-payment, sent by algod — never the facilitator, never the proxy).

// ARC-2 prefix for the review anchor's note (`aupm:j{...}`, SPEC §14).
export const NOTE_PREFIX = 'aupm:j'

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
 * ARC-2 `aupm:j{...}` shape — a malformed note must never resolve to a
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
 * The PaymentRouter identity for a GitHub login: "github:<login>", lower
 * case. GitHub logins are case-insensitive, so this is the only place that
 * builds or normalises such an identity. Accepts a bare login or an
 * identity that already has the "github:" prefix.
 *
 * @param {string} loginOrIdentity
 * @returns {string} e.g. "github:alice"
 */
export function githubIdentity(loginOrIdentity) {
  const login = loginOrIdentity.startsWith('github:')
    ? loginOrIdentity.slice('github:'.length)
    : loginOrIdentity
  return `github:${login.toLowerCase()}`
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
 * Throws unless `sender` equals the address that PaymentRouter maps to
 * `identity` (its identity box). `mappedAddress` is null when the box does
 * not exist.
 *
 * @param {{sender: string, identity: string, mappedAddress: string|null}} args
 */
export function checkSenderIsMappedAuditor({ sender, identity, mappedAddress }) {
  if (mappedAddress === null) {
    throw new Error(
      `${identity} is not mapped in PaymentRouter: the admin must run setIdentity for it first`,
    )
  }
  if (sender !== mappedAddress) {
    throw new Error(
      `anchor sender ${sender} is not the address mapped to ${identity} (${mappedAddress})`,
    )
  }
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

/** A scope that starts with the word "unread" marks a TestNet rehearsal review (ADR 0012). */
const UNREAD_SCOPE = /^\s*unread\b/i

/**
 * Throws when an unread rehearsal review would be recorded anywhere except TestNet
 * (ADR 0012, CLAUDE.md invariant 5). Any network value other than "testnet" counts as MainNet.
 *
 * @param {string} scope - the anchor note's review scope.
 * @param {string} network - the network the review is recorded for.
 */
export function checkScopeAllowedOnNetwork(scope, network) {
  if (network !== 'testnet' && UNREAD_SCOPE.test(scope)) {
    throw new Error(
      `refusing: scope "${scope}" marks an unread review, and unread reviews are ` +
        `TestNet-only (ADR 0012); network is ${network}`,
    )
  }
}
