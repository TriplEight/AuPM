// cli/src/auditor-note.ts
//
// The review anchor note and the scope string (SPEC §14, ADR 0007, ADR 0012). The note bytes
// equal what scripts/review-anchor.mjs encodeReviewNote() produces for the same fields.

export const NOTE_PREFIX = 'aupm:j'
export const MAX_NOTE_BYTES = 1024

const UNREAD_SCOPE = /^\s*unread\b/i

export interface ReviewFields {
  name: string
  version: string
  integrity: string
  reviewer: string
  scope: string
}

export interface ScopeAnswers {
  coverage: string
  installScripts: string
  findings: string
  changes: string
}

export const FIRST_REVIEW = 'first review'

/** The ARC-2 note bytes of one review anchor: `aupm:j` and the JSON of the fields. */
export function encodeReviewNote(fields: ReviewFields): Uint8Array {
  const { name, version, integrity, reviewer, scope } = fields
  const note = { v: 1, name, version, integrity, reviewer, scope }
  return new TextEncoder().encode(NOTE_PREFIX + JSON.stringify(note))
}

/** The scope string. `previous` is the last reviewed version of this package, or null. */
export function buildScope(answers: ScopeAnswers, previous: string | null): string {
  const head = `read: ${answers.coverage}; install scripts: ${answers.installScripts}; findings: ${answers.findings};`
  if (previous !== null && answers.changes !== FIRST_REVIEW) {
    return `${head} since ${previous}: ${answers.changes}`
  }
  return `${head} ${answers.changes}`
}

/** Throws when the note is over the ARC-2 limit. The message says how many bytes to cut. */
export function assertNoteFits(note: Uint8Array): void {
  if (note.length > MAX_NOTE_BYTES) {
    throw new Error(
      `The review note is ${note.length} bytes. The limit is ${MAX_NOTE_BYTES} bytes. ` +
        `Cut ${note.length - MAX_NOTE_BYTES} bytes from your answers and run the command again.`,
    )
  }
}

/** Throws for an unread review anywhere except TestNet (ADR 0012). */
export function assertReadAllowed(coverage: string, scope: string, testnet: boolean): void {
  if (!testnet && (UNREAD_SCOPE.test(coverage) || UNREAD_SCOPE.test(scope))) {
    throw new Error(
      'Refused. An unread review is allowed on TestNet only (ADR 0012). ' +
        'Read the package, then describe what you read.',
    )
  }
}
