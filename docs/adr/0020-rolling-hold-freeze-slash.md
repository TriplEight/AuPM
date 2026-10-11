# Pool money unlocks on a rolling hold. Disputes freeze it, rulings slash it

Status: accepted (2026-10-11). Uses the credit batches of ADR 0005.

Each accrual in a package pool (ADR 0019) unlocks H days after its settlement. H is a tunable.
The start value is 30 days. On day 30 only the day-1 accruals unlock. On day 35 the accruals of
days 1 to 5. The nightly job credits every matured share that is not frozen in the next credit
batch. A credited share goes to the identity balance on chain, and the payee claims it with
`claim()`. Payout is pull only: no push payout, no new contract method. The off-the-top shares
(treasury `cut`, ops) are not held. They go into the next batch.

A batch then mixes shares of different ages, and frozen shares stay out of it. A per-batch
ratio check in the contract (today: auditor entries are exactly 30% of `attributedTotal`) cannot
hold. The new contract must check the split another way, for example on cumulative totals. This
is a design item for the new contract.

Locked money is USDC at `payTo` that is not yet credited. The crediter controls the timing, so the
hold needs no contract change. A contract migration does not move it: `payTo` stays the same
account, and the admin rekeys it to the new app.

## Freeze, release, slash, forfeit

- An **admitted** challenge of a review freezes the reviewer-line shares of that review in that
  pool. A verified S1 or higher finding on a version freezes the maintainer share in that pool.
  A freeze touches only the uncredited shares of the affected role. Other shares never freeze
  and unlock on schedule.
- Waiting never moves money. Only an explicit event does:
  - Challenge upheld: the frozen reviewer share goes to treasury (`slash`).
  - Challenge rejected: the frozen share unlocks.
  - Fix verified by a delta review of a later version before the deadline: the frozen
    maintainer share unlocks.
  - Deadline passed and no verified fix: the frozen maintainer share goes to treasury
    (`forfeit`). A forfeit needs a verified finding (independent verification or an arbiter
    ruling). An unverified finding never forfeits anything.
- Each freeze has a deadline: the dispute deadlines and the embargo deadline of ADR 0024.
- A challenge freezes money only after triage admits it: reproducible evidence, the minimum
  severity, an onboarded challenger identity, one open dispute per version.

## Forward-only after unlock

A credited share is out of reach. Nobody slashes a credited or claimed balance in hindsight, so
no payee has an incentive to claim early. H is therefore the security window. H must exceed the
usual time to detect a missed S1 finding. Calibrate it after Wave 2 data. A miss found after
unlock costs the auditor reputation and future income, not past payouts.

## Ledger

The ledger records treasury income in four separate kinds: `cut` (the 20% off the top),
`unallocated` (a role with no payee), `slash` and `forfeit`. The ledger gets an unlock time per
accrual and a freeze state per role share.

We rejected unlocking at the end of the audit, fix and merge loop: a clean version has no loop
end, and one loop spans two pools (the finding on V, the fix in V'). We rejected hindsight
clawback: claimed funds cannot be recovered (`claim()` pays the whole balance), and the threat
pushes payees to claim as early as possible.
