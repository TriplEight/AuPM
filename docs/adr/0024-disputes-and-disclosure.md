# An independent arbiter rules on disputes. Findings follow a fixed disclosure policy

Status: accepted (2026-10-11). The severity classes and embargo lengths are draft tunables, not
verified policy values.

## Disputes

1. A challenge or a maintainer rebuttal is per finding. The challenger is an onboarded
   `aud:<id>`. A maintainer authenticates with a signed record or with npm or forge ownership
   proof.
2. Triage admits a challenge only with reproducible evidence and the minimum severity. Only an
   admitted challenge freezes money (ADR 0020). One open dispute per package version.
3. A rebuttal is due within 14 days. AuPM publishes it beside the audit and never replaces the
   audit with it.
4. An independent arbiter rules per finding within 14 days. The arbiter is never the challenger
   and never the original auditor. Treasury pays the arbiter a flat fee, whatever the outcome.
   In the pilot the owner rules, and the record says `admin-interim`. Later a 3-member panel,
   then a governance council.
5. One appeal to a different panel within 7 days.
6. Effects: an open challenge sets `adversarial:challenged` and does not change the tier. An
   upheld S1 or higher finding, or a missed S0, sets `review:refuted` and drops the tier to
   `UNREVIEWED`. An upheld rebuttal sets `finding:rejected`. The auditor gets a penalty only when
   the finding had no evidence.
7. Every outcome is a new signed record that supersedes the earlier status.

The challenger never rules, because the challenger has a stake in an upheld challenge. Slashed
money goes to treasury, never to the arbiter or to ops, so no ruler gains from a slash.

Abuse limits: a rebuttal without evidence carries no weight. Nobody can dispute an S0 after its
deadline. A rejected challenge costs the challenger reputation. A challenger bond is an open
decision.

## Severity and embargo (draft)

| Class | Meaning | Embargo |
|---|---|---|
| S0 | Malicious intent or active exploitation | None for the flag. Report to npm security at once. Publish `malicious:suspected` with the evidence hash. |
| S1 | Critical or high, exploitable | 45 days, plus 14 if a fix is in progress |
| S2 | Medium | 90 days |
| S3 | Low or hardening | 7 days notice, then publish |

## Disclosure

- The maintainer gets the details first. For S1 and for any "malicious" claim, an independent
  reviewer verifies the finding before publication, except under active exploitation.
- AuPM never makes the release of details depend on a payment.
- npm unpublish is not available for popular packages. AuPM asks for `npm deprecate` with a
  security message or a fix release. AuPM shows `findings:open`, and `aupm` warns. Refusing the
  install is opt-in only, never the default.
- AuPM contacts an unresponsive maintainer on days 0, 7 and 14 over different channels (private
  vulnerability reporting, `SECURITY.md`, the npm maintainer contact, a repository issue that
  asks only for a security contact). AuPM publishes at the deadline. Early publication: active
  exploitation, independent public discovery, or a fix already released.
- The proxy stores an embargoed audit as an OpenPGP-encrypted blob for the auditor, the
  arbiters and each other recipient with a key. AuPM holds the ciphertext and the registry keys,
  and says so.
- AuPM requests a CVE or GHSA through the maintainer's advisory flow where possible, and else
  publishes an OSV-shaped record. S0 goes to npm security and the OpenSSF malicious-packages
  repository.
- No automated issues or pull requests on third-party repositories (SPEC §13.4).
