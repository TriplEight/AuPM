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
A version can have many flags (`cve:<id>`, `auto_scan:clean`, `auto_scan:findings`,
`adversarial:challenged`).
_Avoid_: status value, label

**COMMUNITY_REVIEWED**:
The tier for a package version where at least one registered auditor read that exact tarball
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

### People

**Donor**:
A caller who opts in to pay for a reviewed resource.
_Avoid_: payer, customer, user-donor

**Donation opt-in**:
The signal in a request that the caller is willing to pay for a reviewed tarball. Without it, a
reviewed tarball is free.
_Avoid_: paywall, payment mode

**Partial attestation**:
A free signed attestation that withholds the reviewed entries of a lockfile and states how many
it withholds. It always lists integrity mismatches and unresolvable entries.
_Avoid_: free attestation, preview

**Free user**:
A caller who uses only the free paths: any tarball without donation opt-in, unreviewed
attestations, partial attestations, and lockfiles with no reviewed package.
_Avoid_: anonymous user

**Auditor**:
A person who reviews one exact package version and signs the review.
_Avoid_: reviewer (when it means the primary auditor), security researcher

**Ops**:
The operator of the AuPM service. Ops receives the ops role share. In the MVP, ops also receives,
as income, the shares of roles that are not yet onboarded.
_Avoid_: admin (when it means the revenue role)

### Revenue

**Role share**:
The fixed percentage of each payment that goes to one role.
_Avoid_: cut, fee

**Repo pool**:
The balance that one repository accumulates from payments for its own packages. Payees claim
their role share from it.
_Avoid_: pool (without a qualifier), escrow, role pool

**Unallocated balance**:
The USDC that has arrived at `payTo` and is not yet credited to any payee balance.
_Avoid_: float, pending funds

**Credit batch**:
One numbered credit of many settled payments at once, grouped by repository and identity. Each
settled payment belongs to exactly one credit batch.
_Avoid_: per-payment credit, distribution

**Donor account**:
A dedicated, low-balance Algorand account that a donor uses only to pay AuPM. Its balance is the
donor's real spending limit.
_Avoid_: wallet (when it means the donor's main holdings)

**Contributor**:
The author of a merged fix PR that references an audit.
_Avoid_: developer, committer
