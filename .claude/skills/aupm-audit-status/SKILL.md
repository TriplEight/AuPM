---
name: aupm-audit-status
description: >
  AuPM audit-status model: the MVP tiers, the auto-reset rule, the integrity rule, the
  review anchor, the SQLite schema, and the machine-readable status API. Use for the
  status store, the record-review tool, and the /api/v1/status endpoint.
---
# Audit status

Spec: `SPEC.md` §4 (model), §12.4 (integrity), §13.1 (repo key), §14 (review flow).
Terms: `CONTEXT.md` (Tier, Flag, COMMUNITY_REVIEWED, Review anchor, Review lineage).
Decisions: `docs/adr/0001-sqlite-status-store.md`, `docs/adr/0007-auditor-anchors-review.md`.

## Tiers (MVP builds two)
UNREVIEWED          default on publish                          FREE
COMMUNITY_REVIEWED  >=1 auditor read that exact tarball, signed  PAYABLE (see below)

`AUTO_SCANNED` (Phase 2), `PEER_REVIEWED` and `MISSION_CRITICAL_SAFE` (Phase 3) are the
product model. Do not build them in the MVP. CVEs are flags (`cve:<id>`), never a tier.
Flags are Phase 2.

When is COMMUNITY_REVIEWED paid (invariant 4, SPEC §11.2):
- Tarball: only with `X-AuPM-Donate: 1`. Plain npm gets it free.
- Attestation routes: 402 unless the request sends `X-AuPM-Donate: 0`, which gets a free
  partial attestation. Integrity warnings are never withheld.

## Auto-reset rule
A new package version starts at UNREVIEWED and must be re-reviewed. The store keys on
(pkg, version), so a version with no row is UNREVIEWED. A tier never carries forward, not
even inside one major version. This is the demo beat: "the version bump is exactly where
supply-chain attacks inject."

## Integrity rule
A paid-tier row with no stored `integrity` is an incomplete review. It resolves to
UNREVIEWED. Without this rule a signed statement would report `integrityMatch: true`
having compared nothing.

## Lifecycle (how a row gets its status)
1. Unknown version -> synthesize UNREVIEWED (free). Never store-then-block; just default.
2. A human auditor reviews that exact tarball.
3. The auditor sends the review anchor from their own machine: a 0-ALGO self-payment with
   the ARC-2 note `aupm:j{"v":1,"name",…,"version",…,"integrity",…,"reviewer",…,"scope",…}`.
   The auditor key never touches the server.
4. The operator runs `record-review <anchorTxid>`. It reads the anchor from the indexer,
   checks the sender against the auditor map (`AUDITORS`), checks the note integrity against
   npm `dist.integrity` for that exact version, resolves the repo key, prints all fields,
   asks for an interactive `yes`, and writes the row.
   WARNING: only this tool writes a review row. Never in code, a fixture, or a seed
   script (CLAUDE.md invariant 5).
5. Install and attest routes read SQLite and apply the payment rules above.
6. Version bump -> no row -> UNREVIEWED again.

## Storage (SQLite, `better-sqlite3`)
audit_status (
  pkg          TEXT NOT NULL,
  version      TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'UNREVIEWED',
  integrity    TEXT,          -- npm dist.integrity (sha512); null => resolves UNREVIEWED
  reviewer     TEXT,          -- bare GitHub login ("alice"), never "github:alice"
  repo         TEXT,          -- GitHub owner/repo, else npm:<name> (SPEC §13.1)
  review_scope TEXT,          -- e.g. full-source+install-scripts (SPEC §14)
  auditor_addr TEXT,          -- sender of the review anchor
  anchor_txid  TEXT,          -- the review anchor
  ts           INTEGER,
  PRIMARY KEY (pkg, version)
)

## API
GET /api/v1/status/:pkg/:version
GET /api/v1/status/@scope/:pkg/:version   (scoped names; separate route)
-> 200 { pkg, version, status, integrity, reviewer, auditor_addr, anchor_txid, ts }
-> unknown version => synthesize { status: "UNREVIEWED" } per the auto-reset rule.
