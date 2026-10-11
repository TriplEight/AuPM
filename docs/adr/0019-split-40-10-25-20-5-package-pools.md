# Split 40/10/25/20/5: treasury and ops off the top, a pool per package version

Status: accepted (2026-10-11). Supersedes the target split of ADR 0011. Amends ADR 0002.

Each payment for a reviewed resource splits in two steps.

1. Off the top: treasury 20% (200 µUSDC per 1,000) and ops 5% (50).
2. The rest (75%, 750) goes to the **package pool** of the exact `name@version` that the payment
   is for. The pool pays the reviewer line 40% (400), the contributor 10% (100) and the
   maintainer 25% (250).

This split removes the adversarial reviewer pool (25% in ADR 0011). Treasury pays challengers a
fixed bounty per upheld challenge, arbiters a flat fee per ruling, and spot-checkers a flat fee per
spot-check. Nobody is paid from a pool for a challenge, so no challenger has a stake in a pool.

A role share that has no payee in that pool goes to treasury, never to ops. Examples: no fix
contributor in this version, a maintainer who is not onboarded, no reviewer left after a slash.
Ops gets only its 5% maintenance fee. Ops never gets money from an absent role, so the operator
has no incentive to keep a role empty or to slash.

## Why `name@version`

The payment, the review record, the finding and the dispute all refer to one exact tarball.
A pool per `name@version` makes each split and each slash local to one version: a dispute on one
version cannot touch the money of another version. Other dimensions are lookups, not pools: the
maintainer and contributor per package or repository, the saturation cap summed per package,
and conflict bans per repository. The repository key of ADR 0002 depends on the self-declared
`repository` field of a package, so a package can claim a popular repository.

Pools exist only in the off-chain ledger. On chain the balance stays per identity (ADR 0002,
amended), so each payee claims once for all pools, with one fee and one `MIN_CLAIM` floor.

## Wash trading

An actor who controls the donor, the auditor, the maintainer and the contributor of one package
recovers at most 75% of a self-paid payment (fix versions) and 65% on clean versions, where the
contributor share goes to treasury. Each wash payment therefore loses 25% to 35%. Wash volume buys
nothing else. Reputation counts outcomes, not volume. Exposure for lease priority comes from
public npm counts, not from AuPM traffic. A higher payout share lowers the lease priority of the
auditor. Treasury bounties need findings that an arbiter approves. Rule: no reward scales with
AuPM-observed volume except the pool payouts themselves.

## Consequences

- The current PaymentRouter asserts that auditor entries are exactly 30% of `attributedTotal`.
  The new split needs a new contract version (ADR 0010 migration). The old app drains to zero.
  Until then the contract pays the MVP split: auditor 30%, ops 70%.
- `treasury` must be a mapped identity before the new contract credits it.
- Public texts show the target split and the split that the live contract pays (invariant 8).
- Hold, freeze and slash rules for pool money: ADR 0020. Who is a payee of a pool: ADR 0021.
