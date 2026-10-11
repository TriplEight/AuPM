# Review records are DSSE envelopes signed with OpenPGP

Status: accepted (2026-10-11). The format is frozen only after an external cryptography review
and published test vectors (Wave 1 gate).

A review record is an in-toto Statement v1 in a DSSE envelope. The auditor signs the DSSE PAE
bytes with the OpenPGP key of ADR 0022. The review anchor of ADR 0007 stays required. A record
can list more witnesses (for example a Rekor entry or a signed git tag) in `witnesses[]`.

We keep DSSE because `payloadType` is inside the signed bytes. This gives domain separation and
stops cross-protocol replay. The auditor never sees PAE: the `aupm` CLI builds and signs it.

## Verifier

DSSE is algorithm-agnostic, so an OpenPGP signature over the PAE bytes is valid DSSE. No known
DSSE verifier accepts OpenPGP keys, and `gpg` cannot output a raw Ed25519 signature (an OpenPGP
signature covers the data plus a trailer). AuPM therefore ships its own verifier on an OpenPGP
implementation. The library choice is open.

Verifier rules:

1. Accept Ed25519 keys only.
2. Pin keys to the signed `auditors.json`. Enforce validity windows and revocation.
3. The record ID is the sha256 of the payload bytes, not of the signature, so signature
   malleability does not change the ID.
4. Treat the OpenPGP creation time as unauthenticated. Take time only from witnesses.
5. The subject digest and `kind` are inside the signed payload.
6. No JSON canonicalisation: sign and verify the exact bytes.

## Shape

- Subject: `pkg:npm/<name>@<version>` with the `sha512` digest from `dist.integrity`.
- Predicate fields: `kind`, `reviewer` (`id`, `fingerprint`, `keyAssurance`), `source` (forge,
  repo, commit, `tarballMatchesCommit`), `scope`, `methodology`, `tools` (free text, not
  verified), `findings` (id, severity, affected range, evidence hashes, summary), `conflicts`,
  `refs`, `createdAt`, `witnesses`.
- Kinds: `audit`, `delta`, `adversarial`, `rebuttal`, `ruling` (role `arbiter` or
  `admin-interim`), `supersession`, `key-event`.
- Records form an append-only graph. Edges: `challenges`, `rebuts`, `rules-on`, `delta-of`,
  `supersedes`, with a stance per finding (`agree`, `partial`, `disagree`). The effective status
  comes from a walk of the graph. AuPM edits and deletes nothing.
- A verified vulnerability also gets an OSV record. A malicious package also gets an OpenSSF
  malicious-packages report.

## Verification levels

- L1 offline: the signature against the pinned `auditors.json`, and the subject digest against
  the tarball.
- L2 online: witnesses, key status, supersession and revocation.

## Hosting

The proxy is canonical at `/audits/<sha256>`. A public git repository mirrors the records as an
append-only log. Markdown is a view, not the signed artifact. IPFS comes later. Radicle is not
used for private material: its private repositories are not encrypted at rest.
