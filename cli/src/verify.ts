// cli/src/verify.ts
//
// Offline verifier for SPM DSSE + in-toto Statement v1 attestations.
// See SPEC-v3.md section 6 for the envelope format.
//
// This module implements the DSSE Pre-Authentication Encoding (PAE)
// independently from SPEC-v3.md. It does not import proxy/src/attest/dsse.ts.
// An independent verifier proves the envelope is standard DSSE, not just
// that this codebase agrees with itself.
//
// WARNING: the signature is raw ed25519 over the PAE. It is not produced
// by algosdk's MX-prefixing byte signer. Never verify with algosdk.
//
// CAUTION: this module makes no network request. Verification level is L1
// (offline) only: signature plus optional lockfile digest. L2 (fetching
// each on-chain attestTxid) is out of scope.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import * as ed from '@noble/ed25519'

const PAE_PREFIX = 'DSSEv1'
const SP = ' '
const encoder = new TextEncoder()

/** A DSSE envelope: base64 payload plus one or more ed25519 signatures. */
export interface Envelope {
  payloadType: string
  payload: string
  signatures: { keyid: string; sig: string }[]
}

/** A resolved verification key: a keyid and its raw ed25519 public key bytes. */
export interface KeyEntry {
  keyid: string
  publicKey: Uint8Array
}

/** One entry of the published `spm-keys.json` key list. */
interface PublishedKeyEntry {
  keyid: string
  publicKey: string
  validFrom: string
  validUntil: string | null
}

/** One in-toto Statement v1 subject: a named artifact plus its digest(s). */
interface StatementSubject {
  name: string
  digest: Record<string, string>
}

/** An in-toto Statement v1, only the fields this verifier reads. */
interface Statement {
  subject: StatementSubject[]
}

/**
 * Builds the DSSE Pre-Authentication Encoding, independently from the
 * SPEC-v3.md text:
 *   "DSSEv1" SP len(type) SP type SP len(payload) SP payload
 * SP is a single ASCII space. len() is the byte length in ASCII decimal.
 * payload is the raw Statement bytes, not the base64 form.
 */
export function pae(payloadType: string, payload: Uint8Array): Uint8Array {
  const typeBytes = encoder.encode(payloadType)
  const header = encoder.encode(
    `${PAE_PREFIX}${SP}${typeBytes.length}${SP}${payloadType}${SP}${payload.length}${SP}`,
  )
  const out = new Uint8Array(header.length + payload.length)
  out.set(header, 0)
  out.set(payload, header.length)
  return out
}

/** Parses and shape-checks a DSSE envelope from raw JSON. Throws on any malformed field. */
export function parseEnvelope(json: unknown): Envelope {
  if (typeof json !== 'object' || json === null) {
    throw new Error('envelope is not a JSON object')
  }
  const candidate = json as Record<string, unknown>
  if (typeof candidate.payloadType !== 'string') {
    throw new Error('envelope.payloadType must be a string')
  }
  if (typeof candidate.payload !== 'string') {
    throw new Error('envelope.payload must be a base64 string')
  }
  if (!Array.isArray(candidate.signatures) || candidate.signatures.length === 0) {
    throw new Error('envelope.signatures must be a non-empty array')
  }
  const signatures = candidate.signatures.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`envelope.signatures[${index}] is not an object`)
    }
    const sigCandidate = entry as Record<string, unknown>
    if (typeof sigCandidate.keyid !== 'string') {
      throw new Error(`envelope.signatures[${index}].keyid must be a string`)
    }
    if (typeof sigCandidate.sig !== 'string') {
      throw new Error(`envelope.signatures[${index}].sig must be a base64 string`)
    }
    return { keyid: sigCandidate.keyid, sig: sigCandidate.sig }
  })
  return { payloadType: candidate.payloadType, payload: candidate.payload, signatures }
}

/** Parses a single `--key <keyid>:<base64 pubkey>` argument. */
export function parseKeyArg(spec: string): KeyEntry {
  const separator = spec.indexOf(':')
  if (separator <= 0 || separator === spec.length - 1) {
    throw new Error(`invalid --key argument, expected "<keyid>:<base64 pubkey>": ${spec}`)
  }
  const keyid = spec.slice(0, separator)
  const publicKey = Buffer.from(spec.slice(separator + 1), 'base64')
  if (publicKey.length !== 32) {
    throw new Error(`invalid --key argument, public key must decode to 32 bytes: ${spec}`)
  }
  return { keyid, publicKey: new Uint8Array(publicKey) }
}

/** Parses the published `spm-keys.json` shape into verification keys. */
export function parseKeyListJson(json: unknown): KeyEntry[] {
  if (!Array.isArray(json)) {
    throw new Error('key list must be a JSON array')
  }
  return json.map((entry, index) => {
    if (typeof entry !== 'object' || entry === null) {
      throw new Error(`key list entry [${index}] is not an object`)
    }
    const candidate = entry as Record<string, unknown>
    if (typeof candidate.keyid !== 'string' || typeof candidate.publicKey !== 'string') {
      throw new Error(`key list entry [${index}] must have string keyid and publicKey`)
    }
    const publicKey = Buffer.from(candidate.publicKey, 'base64')
    if (publicKey.length !== 32) {
      throw new Error(`key list entry [${index}] public key must decode to 32 bytes`)
    }
    return { keyid: candidate.keyid, publicKey: new Uint8Array(publicKey) }
  })
}

function findKey(keys: KeyEntry[], keyid: string): KeyEntry | undefined {
  return keys.find((key) => key.keyid === keyid)
}

/** Result of a single named check: one clear pass/fail line. */
export interface CheckResult {
  ok: boolean
  line: string
}

/**
 * Verifies every signature on the envelope against the supplied key list.
 *
 * WARNING: a signature whose keyid is absent from `keys` is a failure, not
 * a skip. Never trust a key carried inside the envelope itself — only
 * `keys` (from --key or --keys) is a trust root.
 */
export async function verifySignatures(
  envelope: Envelope,
  keys: KeyEntry[],
): Promise<CheckResult[]> {
  const payloadBytes = new Uint8Array(Buffer.from(envelope.payload, 'base64'))
  const message = pae(envelope.payloadType, payloadBytes)
  const results: CheckResult[] = []

  for (const signature of envelope.signatures) {
    const key = findKey(keys, signature.keyid)
    if (!key) {
      results.push({
        ok: false,
        line: `signature (keyid ${signature.keyid}): FAIL - keyid not in supplied key list`,
      })
      continue
    }
    const sigBytes = new Uint8Array(Buffer.from(signature.sig, 'base64'))
    const valid = await ed.verifyAsync(sigBytes, message, key.publicKey)
    results.push({
      ok: valid,
      line: valid
        ? `signature (keyid ${signature.keyid}): OK`
        : `signature (keyid ${signature.keyid}): FAIL - signature does not verify`,
    })
  }
  return results
}

/**
 * Checks the sha256 of `lockfileBytes` (the raw file bytes) against the
 * subject digest in the envelope's Statement. Fails if no subject carries
 * a sha256 digest, or if the digests differ.
 */
export function verifyLockfileDigest(envelope: Envelope, lockfileBytes: Uint8Array): CheckResult {
  let statement: Statement
  try {
    const payloadBytes = Buffer.from(envelope.payload, 'base64')
    statement = JSON.parse(payloadBytes.toString('utf8')) as Statement
  } catch {
    return { ok: false, line: 'lockfile digest: FAIL - envelope payload is not valid JSON' }
  }
  const subject =
    statement.subject?.find(
      (entry) => entry.name === 'package-lock.json' && typeof entry.digest?.sha256 === 'string',
    ) ?? statement.subject?.find((entry) => typeof entry.digest?.sha256 === 'string')
  if (!subject) {
    return { ok: false, line: 'lockfile digest: FAIL - statement has no sha256 subject digest' }
  }
  const expected = subject.digest.sha256
  const actual = createHash('sha256').update(lockfileBytes).digest('hex')
  if (actual !== expected) {
    return {
      ok: false,
      line: `lockfile digest: FAIL - sha256 mismatch (expected ${expected}, got ${actual})`,
    }
  }
  return { ok: true, line: 'lockfile digest: OK (sha256 matches)' }
}

interface ParsedArgs {
  envelopePath?: string
  lockfilePath?: string
  keyArgs: string[]
  keysPath?: string
}

function parseArgv(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { keyArgs: [] }
  let index = 0
  while (index < argv.length) {
    const arg = argv[index]
    if (arg === '--lockfile') {
      result.lockfilePath = argv[index + 1]
      index += 2
    } else if (arg === '--key') {
      if (argv[index + 1] !== undefined) result.keyArgs.push(argv[index + 1]!)
      index += 2
    } else if (arg === '--keys') {
      result.keysPath = argv[index + 1]
      index += 2
    } else if (result.envelopePath === undefined && arg !== undefined && !arg.startsWith('--')) {
      result.envelopePath = arg
      index += 1
    } else {
      index += 1
    }
  }
  return result
}

/**
 * Runs `spm verify` end to end: parses argv, loads the envelope and keys
 * from disk, prints one line per check, and returns the process exit code.
 * Exit 0 only when every check passes.
 */
export async function runVerify(argv: string[]): Promise<number> {
  const args = parseArgv(argv)
  if (!args.envelopePath) {
    console.log(
      'Usage: spm verify <attestation.json> [--lockfile <path>] [--key <keyid>:<base64pubkey>]... [--keys <spm-keys.json>]',
    )
    return 1
  }

  let envelope: Envelope
  try {
    const raw = JSON.parse(readFileSync(args.envelopePath, 'utf8'))
    envelope = parseEnvelope(raw)
  } catch (error) {
    console.log(`envelope: FAIL - ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  console.log('envelope: OK (parsed DSSE envelope)')

  const keys: KeyEntry[] = []
  try {
    if (args.keysPath) {
      const raw = JSON.parse(readFileSync(args.keysPath, 'utf8')) as PublishedKeyEntry[]
      keys.push(...parseKeyListJson(raw))
    }
    for (const spec of args.keyArgs) {
      keys.push(parseKeyArg(spec))
    }
  } catch (error) {
    console.log(`keys: FAIL - ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
  if (keys.length === 0) {
    console.log('keys: FAIL - no verification keys supplied (use --key or --keys)')
    return 1
  }
  console.log(`keys: OK (${keys.length} verification key(s) loaded)`)

  let allOk = true
  const signatureResults = await verifySignatures(envelope, keys)
  for (const result of signatureResults) {
    console.log(result.line)
    if (!result.ok) allOk = false
  }

  if (args.lockfilePath) {
    const lockfileBytes = readFileSync(args.lockfilePath)
    const result = verifyLockfileDigest(envelope, new Uint8Array(lockfileBytes))
    console.log(result.line)
    if (!result.ok) allOk = false
  }

  console.log(allOk ? 'verify: PASS' : 'verify: FAIL')
  return allOk ? 0 : 1
}
