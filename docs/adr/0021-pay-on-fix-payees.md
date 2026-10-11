# Pool payees: pay on fix

Status: accepted (2026-10-11).

The payees of the package pool of version V (ADR 0019) follow from the review records of V:

- **Reviewer line (40%)**: split equally among the live, unrefuted reviews that cover V: the
  review or delta review of V (1 share), each peer reviewer of V (1 share each), and the auditor
  whose findings V fixes, when a delta review verifies the fix ("finding credit", 1 share).
  The weights are tunables. Reputation never changes a payout weight. It gates review leases
  only (ADR 0025).
- **Contributor (10%)**: the author of a merged fix that a delta review of V verifies. A version
  that fixes no finding has no contributor, and the share goes to treasury.
- **Maintainer (25%)**: the onboarded maintainer of the package, from the date of onboarding,
  for versions with no verified open S1 or higher finding. Several maintainers per package are
  not designed yet.

The roles differ on purpose. The maintainer is paid for as long as the code holds up, which
rewards quality code without removing the need for audits. The contributor is paid for one
accepted fix. Auditors are paid per review and must keep their reviews right.

## Rules that follow from per-version pools

- An unreviewed version never returns 402 (invariant 4), so its pool gets no money. A clean V
  pays its reviewers for as long as people install V. A new release of the maintainer cannot cut
  the pay of V's auditor. It only moves installs away from V.
- AuPM asks for no donation for a version with a verified open S1 or higher finding. AuPM shows
  the flag `findings:open`. This extends "never charge for a security warning" (SPEC §12.3).
- For an S1 or higher finding, "fixed" needs the signature of a second, independent reviewer,
  because the original auditor gains from accepting the fix.
- When the maintainer does not fix a verified finding by the embargo deadline, AuPM publishes the
  audit and treasury opens a fix bounty. The maintainer cannot stop the auditor's pay by
  ignoring a finding: treasury pays a severity-based finding bounty at publication.

## Fix-farming rules

- No contributor payout for code that the contributor wrote in the 12 months before the audit
  (git blame test).
- The vulnerable code must exist in the audited tarball.
- Payment only after AuPM publishes the audit.
- When the maintainer and the contributor overlap (same person or same payout address), the
  contributor share goes to treasury.
