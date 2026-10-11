# Autoscan flags state their source and never say "clean"

Status: accepted (2026-10-11). Applies when the `AUTO_SCANNED` pipeline lands (Phase 2).

The flag `auto_scan:clean` becomes `autoscan:no-known-issues@<sources,date>`. "Clean" claims a
safety that the data cannot support. A scan only knows what its sources know on that date.

Flags:

- `cve:<id>` from OSV (per-source licences, GHSA is CC-BY 4.0).
- `autoscan:malicious-package`: dataset-backed. It cites the OpenSSF malicious-packages `MAL`
  id (Apache-2.0, OSV format).
- `autoscan:typosquat-suspect`: AuPM's own heuristic. The label says "suspect", never
  "malicious".
- OpenSSF Scorecard is a health signal only, never shown as a security review.

Rules: each flag records its source, the snapshot date and the scanner version. A version that
was never scanned never shows `AUTO_SCANNED`. Autoscan never sets a human tier. Human-curated
advisories (GHSA, malicious-packages reports) are findings, not audits of clean packages: AuPM
links them and never imports them as reviews.
