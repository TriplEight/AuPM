import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  checkIntegrityMatchesNpm,
  checkIsSelfZeroPayment,
  checkSenderIsMappedAuditor,
  decodeReviewNote,
  distIntegrityForVersion,
  encodeReviewNote,
  fetchNpmPackument,
  loginForAddress,
  NOTE_PREFIX,
  parseAuditors,
  repositoryForVersion,
  resolveRepoKey,
} from './review-anchor.mjs'

const FIELDS = {
  name: 'ms',
  version: '2.1.3',
  integrity: 'sha512-abc==',
  reviewer: 'github:alice',
  scope: 'source read, no build',
}

test('encodeReviewNote / decodeReviewNote round-trip', () => {
  const note = decodeReviewNote(encodeReviewNote(FIELDS))
  assert.deepEqual(note, { v: 1, ...FIELDS })
})

test('encodeReviewNote produces the ARC-2 "spm:j" prefix', () => {
  const text = new TextDecoder().decode(encodeReviewNote(FIELDS))
  assert.ok(text.startsWith(NOTE_PREFIX))
})

test('decodeReviewNote accepts a plain string, not only Uint8Array', () => {
  const text = new TextDecoder().decode(encodeReviewNote(FIELDS))
  const note = decodeReviewNote(text)
  assert.equal(note.name, 'ms')
})

test('decodeReviewNote throws on a missing ARC-2 prefix', () => {
  assert.throws(() => decodeReviewNote('not-an-arc2-note'), /ARC-2 prefix/)
})

test('decodeReviewNote throws on malformed JSON', () => {
  assert.throws(() => decodeReviewNote(`${NOTE_PREFIX}{not json`), /malformed/)
})

test('decodeReviewNote throws on a non-object JSON value', () => {
  assert.throws(() => decodeReviewNote(`${NOTE_PREFIX}"just a string"`), /not an object/)
})

test('decodeReviewNote throws when "v" is not 1', () => {
  const bad = { ...FIELDS, v: 2 }
  assert.throws(() => decodeReviewNote(`${NOTE_PREFIX}${JSON.stringify(bad)}`), /"v" must be 1/)
})

test('decodeReviewNote throws when a required string field is missing', () => {
  const { integrity, ...rest } = { v: 1, ...FIELDS }
  assert.throws(() => decodeReviewNote(`${NOTE_PREFIX}${JSON.stringify(rest)}`), /"integrity"/)
})

test('decodeReviewNote throws when "reviewer" lacks the "github:" prefix', () => {
  const bad = { v: 1, ...FIELDS, reviewer: 'alice' }
  assert.throws(() => decodeReviewNote(`${NOTE_PREFIX}${JSON.stringify(bad)}`), /"reviewer"/)
})

test('parseAuditors parses one or more "github:<login>=<address>" entries', () => {
  const auditors = parseAuditors('github:alice=ADDR1,github:bob=ADDR2')
  assert.equal(auditors.get('alice'), 'ADDR1')
  assert.equal(auditors.get('bob'), 'ADDR2')
  assert.equal(auditors.size, 2)
})

test('parseAuditors trims whitespace around entries and fields', () => {
  const auditors = parseAuditors(' github:alice = ADDR1 , github:bob=ADDR2 ')
  assert.equal(auditors.get('alice'), 'ADDR1')
  assert.equal(auditors.get('bob'), 'ADDR2')
})

test('parseAuditors returns an empty map for undefined or blank input', () => {
  assert.equal(parseAuditors(undefined).size, 0)
  assert.equal(parseAuditors('').size, 0)
  assert.equal(parseAuditors('   ').size, 0)
})

test('parseAuditors throws on an entry with no "="', () => {
  assert.throws(() => parseAuditors('github:alice-ADDR1'), /malformed AUDITORS/)
})

test('parseAuditors throws on a login missing the "github:" prefix', () => {
  assert.throws(() => parseAuditors('alice=ADDR1'), /malformed AUDITORS/)
})

test('parseAuditors throws on an empty address', () => {
  assert.throws(() => parseAuditors('github:alice='), /malformed AUDITORS/)
})

test('loginForAddress finds the login mapped to an address', () => {
  const auditors = parseAuditors('github:alice=ADDR1,github:bob=ADDR2')
  assert.equal(loginForAddress(auditors, 'ADDR2'), 'bob')
})

test('loginForAddress returns null for an address with no mapped login', () => {
  const auditors = parseAuditors('github:alice=ADDR1')
  assert.equal(loginForAddress(auditors, 'UNKNOWN'), null)
})

// -- checkSenderIsMappedAuditor: the two "wrong sender" shapes -------------

test('checkSenderIsMappedAuditor throws when the sender is not in AUDITORS at all', () => {
  const auditors = parseAuditors('github:alice=ADDR1')
  assert.throws(
    () =>
      checkSenderIsMappedAuditor({
        sender: 'SOMEONE_ELSE',
        note: { reviewer: 'github:alice' },
        auditors,
      }),
    /is not a mapped auditor address/,
  )
})

test('checkSenderIsMappedAuditor throws when the mapped login differs from the note reviewer', () => {
  const auditors = parseAuditors('github:alice=ADDR1,github:bob=ADDR2')
  assert.throws(
    () =>
      checkSenderIsMappedAuditor({
        sender: 'ADDR2', // bob's address
        note: { reviewer: 'github:alice' }, // but the note claims alice
        auditors,
      }),
    /does not match the login mapped to sender/,
  )
})

test('checkSenderIsMappedAuditor returns the bare login on a matching sender', () => {
  const auditors = parseAuditors('github:alice=ADDR1')
  const login = checkSenderIsMappedAuditor({
    sender: 'ADDR1',
    note: { reviewer: 'github:alice' },
    auditors,
  })
  assert.equal(login, 'alice')
})

// -- checkIntegrityMatchesNpm -----------------------------------------------

test('checkIntegrityMatchesNpm throws on a mismatch', () => {
  assert.throws(
    () => checkIntegrityMatchesNpm({ integrity: 'sha512-aaa' }, 'sha512-bbb'),
    /does not match npm dist\.integrity/,
  )
})

test('checkIntegrityMatchesNpm does not throw on a match', () => {
  assert.doesNotThrow(() => checkIntegrityMatchesNpm({ integrity: 'sha512-aaa' }, 'sha512-aaa'))
})

// -- checkIsSelfZeroPayment ---------------------------------------------

test('checkIsSelfZeroPayment accepts a confirmed 0-ALGO self-payment', () => {
  assert.doesNotThrow(() =>
    checkIsSelfZeroPayment({
      txType: 'pay',
      sender: 'ADDR1',
      paymentTransaction: { amount: 0n, receiver: 'ADDR1' },
      confirmedRound: 100n,
    }),
  )
})

test('checkIsSelfZeroPayment throws on a non-payment transaction', () => {
  assert.throws(
    () => checkIsSelfZeroPayment({ txType: 'axfer', sender: 'ADDR1', confirmedRound: 1n }),
    /not a payment transaction/,
  )
})

test('checkIsSelfZeroPayment throws on a non-zero amount', () => {
  assert.throws(
    () =>
      checkIsSelfZeroPayment({
        txType: 'pay',
        sender: 'ADDR1',
        paymentTransaction: { amount: 1n, receiver: 'ADDR1' },
        confirmedRound: 1n,
      }),
    /not a 0-ALGO payment/,
  )
})

test('checkIsSelfZeroPayment throws when receiver differs from sender', () => {
  assert.throws(
    () =>
      checkIsSelfZeroPayment({
        txType: 'pay',
        sender: 'ADDR1',
        paymentTransaction: { amount: 0n, receiver: 'ADDR2' },
        confirmedRound: 1n,
      }),
    /not a self-payment/,
  )
})

test('checkIsSelfZeroPayment throws when unconfirmed', () => {
  assert.throws(
    () =>
      checkIsSelfZeroPayment({
        txType: 'pay',
        sender: 'ADDR1',
        paymentTransaction: { amount: 0n, receiver: 'ADDR1' },
      }),
    /not confirmed/,
  )
})

// -- resolveRepoKey: the eight repository shapes ----------------------------

test('resolveRepoKey: a plain https string', () => {
  assert.equal(resolveRepoKey('ms', 'https://github.com/vercel/ms'), 'vercel/ms')
})

test('resolveRepoKey: an object with a url field', () => {
  assert.equal(
    resolveRepoKey('ms', { type: 'git', url: 'https://github.com/vercel/ms.git' }),
    'vercel/ms',
  )
})

test('resolveRepoKey: git+https', () => {
  assert.equal(resolveRepoKey('ms', 'git+https://github.com/vercel/ms.git'), 'vercel/ms')
})

test('resolveRepoKey: git+ssh', () => {
  assert.equal(resolveRepoKey('ms', 'git+ssh://git@github.com/vercel/ms.git'), 'vercel/ms')
})

test('resolveRepoKey: "github:owner/repo" shorthand', () => {
  assert.equal(resolveRepoKey('ms', 'github:vercel/ms'), 'vercel/ms')
})

test('resolveRepoKey: a non-GitHub host (GitLab) falls back to npm:<name>', () => {
  assert.equal(resolveRepoKey('ms', 'https://gitlab.com/vercel/ms.git'), 'npm:ms')
})

test('resolveRepoKey: a missing repository field falls back to npm:<name>', () => {
  assert.equal(resolveRepoKey('ms', undefined), 'npm:ms')
})

test('resolveRepoKey: a malformed repository value falls back to npm:<name>', () => {
  assert.equal(resolveRepoKey('ms', 42), 'npm:ms')
  assert.equal(resolveRepoKey('ms', {}), 'npm:ms')
  assert.equal(resolveRepoKey('ms', 'not a url at all'), 'npm:ms')
})

// -- npm packument helpers ----------------------------------------------

test('fetchNpmPackument percent-encodes a scoped name and returns the JSON body', async () => {
  let requestedUrl
  const fetchImpl = async (url) => {
    requestedUrl = url
    return { ok: true, json: async () => ({ name: '@babel/core' }) }
  }
  const packument = await fetchNpmPackument('@babel/core', fetchImpl)
  assert.equal(requestedUrl, 'https://registry.npmjs.org/@babel%2fcore')
  assert.deepEqual(packument, { name: '@babel/core' })
})

test('fetchNpmPackument throws on a non-ok response', async () => {
  const fetchImpl = async () => ({ ok: false, status: 404 })
  await assert.rejects(() => fetchNpmPackument('ms', fetchImpl), /npm registry returned 404/)
})

test('distIntegrityForVersion returns dist.integrity for the exact version', () => {
  const packument = { versions: { '2.1.3': { dist: { integrity: 'sha512-abc' } } } }
  assert.equal(distIntegrityForVersion(packument, 'ms', '2.1.3'), 'sha512-abc')
})

test('distIntegrityForVersion throws when the version is not published', () => {
  const packument = { versions: {} }
  assert.throws(
    () => distIntegrityForVersion(packument, 'ms', '2.1.3'),
    /no published version ms@2\.1\.3/,
  )
})

test('distIntegrityForVersion throws when dist.integrity is missing', () => {
  const packument = { versions: { '2.1.3': { dist: {} } } }
  assert.throws(
    () => distIntegrityForVersion(packument, 'ms', '2.1.3'),
    /dist\.integrity is missing/,
  )
})

test('repositoryForVersion prefers the version-level field over the top-level one', () => {
  const packument = {
    repository: 'https://github.com/top/level',
    versions: { '2.1.3': { repository: 'https://github.com/vercel/ms' } },
  }
  assert.equal(repositoryForVersion(packument, '2.1.3'), 'https://github.com/vercel/ms')
})

test('repositoryForVersion falls back to the top-level field', () => {
  const packument = {
    repository: 'https://github.com/top/level',
    versions: { '2.1.3': {} },
  }
  assert.equal(repositoryForVersion(packument, '2.1.3'), 'https://github.com/top/level')
})
