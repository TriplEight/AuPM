# AuPM

AuPM is an npm-compatible registry overlay. Unreviewed packages pass through for free.
Human-reviewed packages cost a USDC micropayment, and the revenue funds the people who review
and maintain them.

## Language

### Review status

**Tier**:
The single review level of one package version: who looked at it.
Values: `UNREVIEWED`, `AUTO_SCANNED`, `COMMUNITY_REVIEWED`, `PEER_REVIEWED`,
`MISSION_CRITICAL_SAFE`.
_Avoid_: status, audit level

**Flag**:
A fact about one package version that is independent of its tier: what is known.
A version can have many flags (`cve:<id>`, `autoscan:no-known-issues@<sources,date>`,
`findings:open`, `adversarial:challenged`, `review:refuted`). A flag never says "safe" or
"clean".
_Avoid_: status value, label

**COMMUNITY_REVIEWED**:
The tier for a package version where at least one accepted auditor read that exact tarball
and signed a review.
_Avoid_: REVIEWED, audited

**Review anchor**:
The on-chain transaction, signed by the auditor, that records one review of one exact tarball.
_Avoid_: attest call, on-chain review

**Review lineage**:
The chain of reviews of one package inside one major version, where each later review checks
only the diff from the previous reviewed version. The tier never carries forward along a
lineage; only payments are shared along it.
_Avoid_: version range review, inherited review

**Review record**:
One signed statement by an auditor about one exact tarball: an audit, a delta review, a
challenge, a rebuttal or a ruling. Records are never edited; a later record supersedes an
earlier one.
_Avoid_: report, audit file

**Finding**:
One issue that a review record states about a version, with a severity class (S0 to S3) and
evidence. A finding is confirmed after independent verification or a ruling.
_Avoid_: bug, vulnerability (when not yet confirmed)

**Embargo**:
The period after the maintainer is told about a finding and before AuPM publishes it. Its length
depends on the severity class.
_Avoid_: grace period

### Disputes

**Challenge**:
A dispute of a review, per finding, by an auditor who did not write it. Only a challenge that
triage admits has an effect on money.
_Avoid_: adversarial review (when it means the act), appeal

**Rebuttal**:
The maintainer's answer to a finding, published beside the audit.
_Avoid_: reply, counter-claim

**Arbiter**:
The person who rules on a challenge or a rebuttal, per finding. Never the challenger, never the
original auditor. In the pilot the owner rules as `admin-interim`.
_Avoid_: judge, moderator

### People

**Donor**:
A caller who opts in to pay for a reviewed resource.
_Avoid_: payer, customer, user-donor

**Donation opt-in**:
The signal in a request that the caller is willing to pay for a reviewed tarball. Without it, a
reviewed tarball is free. The aupm CLI can send it on every run: the env var `AUPM_DONATE=true`
or the config file `donate = true` (`~/.config/aupm/config.toml`). `--no-donate` overrides both.
_Avoid_: paywall, payment mode

**Partial attestation**:
A free signed attestation that withholds the reviewed entries of a lockfile and states how many
it withholds. It always lists integrity mismatches and unresolvable entries.
_Avoid_: free attestation, preview

**Accepted lockfile formats**:
The formats that `POST /v1/attest/lockfile` attests: `package-lock.json`, `pnpm-lock.yaml`
(lockfileVersion '9.0') and the yarn classic (v1) `yarn.lock`. Yarn berry (v2 and later) is not
accepted (ADR 0018).
_Avoid_: supported lockfiles

**Free user**:
A caller who uses only the free paths: any tarball without donation opt-in, unreviewed
attestations, partial attestations, and lockfiles with no reviewed package.
_Avoid_: anonymous user

**Auditor**:
A person who reviews one exact package version and signs the review.
_Avoid_: reviewer (when it means the primary auditor), security researcher

**Auditor identity**:
The stable id `aud:<id>` of an auditor. It survives key rotation and token loss. Reputation and
the payout binding attach to it. A forge login is a linked claim, never the identity.
_Avoid_: GitHub login (as identity), account

**Key assurance**:
How much AuPM trusts that an auditor's signing key exists only on one device:
`hardware-attested` (full rights) or `software` (probation only).
_Avoid_: key level, trust level

**Review lease**:
A time-limited, exclusive right of one auditor to review one package version. It prevents two
auditors from racing for the same version.
_Avoid_: claim (that word is for payouts), lock, reservation

**Reputation**:
The standing of one auditor identity per role, computed only from outcomes of review records.
It decides lease eligibility, never pay.
_Avoid_: score, karma

**Maintainer**:
The onboarded owner of an npm package. Paid from the package pools of versions with no
confirmed open S1 or higher finding.
_Avoid_: author, publisher

**Ops**:
The operator of the AuPM service. Ops receives the ops role share, off the top. In the MVP
contract, ops also receives, as income, the shares of roles that are not yet onboarded. With the
target split those shares go to treasury.
_Avoid_: admin (when it means the revenue role)

**Treasury**:
The global role that receives its share off the top, plus the shares with no payee, slashes and
forfeits. It pays challenger bounties, arbiter and spot-check fees, and fix and delta-review
bounties.
_Avoid_: reserve, fund

### Revenue

**Role share**:
The fixed percentage of each payment that goes to one role.
_Avoid_: cut, fee

**Package pool**:
The ledger account of one exact `name@version` that receives the pool part of each payment for
that tarball and splits it among the reviewer line, the contributor and the maintainer. It
never holds an on-chain balance of its own.
_Avoid_: pool (without a qualifier), repo pool, escrow, role pool

**Reviewer line**:
The pool share for the reviews of one version: the audit or delta review, peer reviews, and the
finding credit of an auditor whose findings that version fixes. Split equally per live review.
_Avoid_: auditor share (when it means the whole line)

**Hold period**:
The time (H) after which one accrual in a package pool unlocks and can be credited. Each accrual
has its own unlock time.
_Avoid_: vesting, lock-up

**Freeze**:
The state of an uncredited pool share that waits for a ruling or a fix. Waiting never sends the
money anywhere.
_Avoid_: hold (that is the hold period), suspension

**Slash**:
A ruling that sends a frozen reviewer share to treasury. Never applies to credited money.
_Avoid_: clawback, penalty

**Forfeit**:
The move of a frozen maintainer share to treasury when a confirmed finding is not fixed by its
deadline.
_Avoid_: slash (that is for reviewers), fine

**Unallocated balance**:
The USDC that has arrived at `payTo` and is not yet credited to any payee balance.
_Avoid_: float, pending funds

**Credit batch**:
One numbered credit of many settled payments at once, grouped by repository and identity. Each
settled payment belongs to exactly one credit batch.
_Avoid_: per-payment credit, distribution

**Donor account**:
A dedicated, low-balance Algorand account that a donor uses only to pay AuPM. Its balance is the
donor's real spending limit. `aupm donor init` creates it. The key goes to a key file, never to
the screen.
_Avoid_: wallet (when it means the donor's main holdings)

**Contributor**:
The author of a merged fix PR that references an audit.
_Avoid_: developer, committer

### Migration

**Announce release**:
The admin step that records a migration target address and the current round, and starts the
delay window before `executeRelease` can run.
_Avoid_: propose release, queue release

**Execute release**:
The admin step, runnable only after the delay and before the execute window that follows it
closes, that sweeps the old app's unclaimed
balance to treasury, retires the old app, and rekeys `payTo` to the new address.
_Avoid_: finalize release, migrate

**Treasury sweep**:
The one-time inner transfer of `creditedUnclaimed` from `payTo` to the address mapped to
identity `"treasury"`, run by `executeRelease`.
_Avoid_: bailout, rescue
