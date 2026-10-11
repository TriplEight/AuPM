# Review leases, anti-hunt rules and outcome-based quality

Status: accepted (2026-10-11). All numbers are tunables. Calibrate them after Wave 2 data.

Payout per package grows with downloads. First-come claiming with no limit turns review work
into a race for the most-downloaded stable packages: rent for early auditors, rushed reviews,
and sniping. These rules flatten that race.

## Leases

- An auditor takes a **review lease** on `(name, version, kind)` before the review. The proxy is
  the only SQLite writer, so a unique row makes leasing race-free.
- A lease lasts 72 hours and can be renewed once. It expires on its own. The same key cannot
  lease the same version again for 24 hours after expiry. At most 3 concurrent leases.
- Conflict bans apply at lease time: the auditor, a delta reviewer or an arbiter of a package
  cannot challenge it. A ban on the same repository applies when it publishes 5 packages or
  fewer, and else only within the workspace dependency closure. A delta reviewer cannot
  challenge their own delta. Each lease refreshes a signed conflict declaration.

## Anti-hunt

1. Exposure-weighted priority: E_a is the share of all reviewer-line payout that went to auditor
   a in the last 90 days. Lease priority = 1 / (1 + max(0, (E_a - e0) / e0)), with e0 about 3
   times the fair share. It is a weight, not a ban.
2. Saturation: a cap of m times the median per-package reviewer payout limits the earnings of
   one reviewer from one package in one period (start m = 5). The surplus goes to treasury.
3. Freshness decay: the reviewer line of an unchanged version halves every 12 months, down to a
   floor (start 20%). The difference goes to treasury. A cheap "still holds" re-attestation
   restores the full rate.
4. Lottery for hot packages: in the top exposure decile, a sealed lease window (for example 48
   hours) and a weighted lottery replace first-come leasing.
5. Above an exposure threshold a package needs two independent auditors (`PEER_REVIEWED`), and the
   reviewer line splits between them.
6. A fixed treasury bounty per delta review, scaled by the diff size, pays for work that is not
   popular.

Exposure comes from public npm download counts, never from AuPM traffic, and only sets caps and
weights. It never pays anyone directly.

## Reputation

Reputation is global per `aud:<id>` and per role. It counts outcomes only. Positive: challenges
survived, delta reviews that hold, verified fixes. Negative: upheld challenges (severity-weighted),
misses that a panel rules in scope, disclosure breaches. It shows counts and a standing level
(`probation`, `good`, `restricted`), decays with a half-life of about 180 days, and later clean
outcomes restore it. Reputation gates lease eligibility and lottery weight. It never changes a
payout weight, so nobody farms reputation for money. New auditors start on probation: small packages
only, and a random spot-check of every Nth review.

## Quality without AI policing

AuPM does not ban, detect or require disclosure of AI use. Quality comes from outcomes: an
evidence rule for each finding (a PoC, a transcript or a diff hunk, enforced by a template lint),
delta-review survival, random spot-checks paid by treasury, challenge outcomes, reputation
decay, forward-only forfeiture, and pair caps (the same auditor and challenger pair at most k
times per 90 days). AuPM allows the free-text `tools` field and does not check it.
