# Contract admin is a multisig; migration announces, then delays

## Context

`contract.algo.ts` defines no `updateApplication()` or `deleteApplication()` method. The ARC-56
spec routes no method and no bare call to `UpdateApplication` or `DeleteApplication`. A deployed
bug, a new on-chain split, or a changed constant (`AUDITOR_SHARE_NUM`, `MIN_CLAIM`,
`MIN_CLAIM_FEE`) all need a new contract, not an in-place update.

A new contract needs `releaseAuthority(to)` to rekey `payTo` away from the old app. Today,
`releaseAuthority` checks only `Txn.sender.bytes === Global.creatorAddress.bytes`
(`contract.algo.ts:171`). `to` is unconstrained: no check that it is an application, no delay,
no second signer. One leaked or coerced creator key can rekey `payTo` to any address at once,
and from that address move the whole USDC balance, including every identity's credited but
unclaimed balance. A lost creator key blocks every admin method forever, since Algorand does not
let an app rotate `Global.creatorAddress`.

After a rekey, the old app's `balances` and `creditedUnclaimed` do not move or clear. `claim()`
on the old app then fails: its inner axfer no longer has signing power over `payTo`. A payee who
did not claim before the rekey is stuck with a box that says it is owed money, on an app that can
no longer pay it.

The following changes need a new contract: a new on-chain split (any target beyond the current
two-identity 300/1000 auditor share, ADR 0011), a changed `MIN_CLAIM` or `MIN_CLAIM_FEE`, a new role with
an on-chain percentage, a contract bug, or a changed USDC asset id. The following do not: a lost
crediter key (`setCrediter`), a lost identity key (`setIdentity`), a new identity credited
off-chain through `entries` or `unattributedTotal`, or a facilitator change (the contract never
reads the facilitator).

## Decision

**C — multisig admin.** `Global.creatorAddress` is a 2-of-3 Algorand multisig address, not one
key. The deploy tooling signs the `createApplication` call as that multisig. No single lost or
leaked key can call `setCrediter`, `setIdentity`, `announceRelease`, or `executeRelease` alone.
The contract needs no change for this: it already just compares `Txn.sender.bytes` to
`Global.creatorAddress.bytes`. The change is in key management and the signing ceremony.

**B — announce, then execute after a delay.** Planned for the MainNet build (P8).
`releaseAuthority(to)` is replaced by two admin methods:
- `announceRelease(to)` records `to` and the current round in global state.
- `executeRelease()` runs only after a compiled-in delay of about 7 days (216,000 rounds) from
  the announced round, and only within the next 216,000 rounds (the execute window). After the
  window, the announcement expires: `executeRelease()` fails until the admin announces again,
  which restarts the delay and warns payees again. It then, in order: (1) issues one inner USDC transfer of
  `creditedUnclaimed` from `payTo` to the address mapped to identity `"treasury"` — it fails if
  `"treasury"` is not mapped; (2) sets `creditedUnclaimed` to 0; (3) marks the app retired, so
  `credit()` and `claim()` fail on it from then on; (4) rekeys `payTo` to `to`.

  `payTo`'s address does not change (invariant 1 holds): the rekey changes the authorizer, not
  the address.

**D — a runbook step before every migration.** Before `announceRelease`: run one final credit
batch; announce the migration to payees; tell payees to claim within the delay window; stop the
nightly job against the old app id before `executeRelease` runs.

**Onboarding.** Public texts say the treasury role is onboarded only once `"treasury"` is mapped
with `setIdentity` (invariant 8). Before that, `executeRelease` cannot run, since the sweep has
nowhere to send `creditedUnclaimed`.

## Consequences

- A payee who does not claim within the announce-to-execute window loses the ability to claim
  from the old app. The swept balance moves to treasury, which then pays each swept balance to
  its payee off-chain, on request. The old app's balance boxes stay in place as proof of the
  amount owed; nothing deletes them.
- The old app is marked retired after `executeRelease`: `credit()` and `claim()` both fail on it
  from then on. A crediter that keeps calling `credit()` against a retired app fails loudly,
  instead of silently growing a balance nothing can pay.
- A lost admin key, without the multisig in place, still means `payTo` can never migrate: no
  quorum can sign `announceRelease` or `executeRelease`, and Algorand does not let an app rotate
  `Global.creatorAddress`. The multisig lowers the chance of this, it does not remove it — losing
  2 of 3 key shares has the same effect as losing the one key does today.
- The 7-day delay is public: any observer can see an announced migration and its target address
  before it executes. It gives payees a warning window; it does not stop a determined multisig
  from migrating.
- The delay does not limit the admin at all. `setIdentity` and `setCrediter` take effect at
  once: the multisig can remap any identity to its own address and claim, or set itself as
  crediter, credit the unallocated USDC to an identity it maps, and claim, with no announcement
  (pre-MainNet audit finding H1). The admin is trusted. Public texts say so and never present
  the delay as protection against the admin. A timelock on those methods is a v7 candidate
  (`SPEC.md` §21).
- The execute window stops an old announcement from staying executable for good (pre-MainNet
  audit finding L1). An expired announcement needs a new `announceRelease`, a new delay, and
  so a new warning to payees.
- The operator runbook (not published) gets the D procedure as a checklist.

## Options rejected

- **A — restrict `to` to an application address.** Would stop the admin handing `payTo` to a
  plain key it holds, but a determined admin can still deploy a trivial pass-through app and name
  that; it does not close the loophole, and Puya cannot cleanly assert "is an application
  account" today. Not pursued.
- **E — require the target contract to prove it preserves `creditedUnclaimed` accounting before
  the rekey runs.** Removes the rug-pull risk structurally, but it is real migration engineering
  on both the old and the new contract, sized like a new PaymentRouter version, not a policy
  change. Deferred to a v7 candidate (`SPEC.md` §21).

## Amendment 2026-10-01: release timing is a deploy-time template value

What changed:
- The release delay and the execute window are no longer literals in the contract.
  `executeRelease()` reads them as template variables `TMPL_RELEASE_DELAY_ROUNDS` and
  `TMPL_RELEASE_WINDOW_ROUNDS` (`TemplateVar<uint64>` in Puya-TS). The deploy step
  replaces them before it compiles the TEAL.
- The rules of the release path do not change. The call order is `announceRelease`, wait
  the delay, then `executeRelease` inside the window. A new announcement restarts the delay.
  `payTo`, the split and the `credit()` permission do not change.

Why:
- With both values compiled as 216,000 rounds (about 7 days each), nobody could rehearse
  the release path on TestNet. A path that is never run before MainNet is an unverified path.

Values per network (source of truth: `releaseRounds()` in `scripts/network.mjs`):

| Network | Delay (rounds) | Window (rounds) | Override |
|---|---|---|---|
| MainNet | 216,000 | 216,000 | None. |
| TestNet | 20 | 200 | `RELEASE_DELAY_ROUNDS`, `RELEASE_WINDOW_ROUNDS` |
| LocalNet and tests | Any | Any | Set by the test. |

MainNet guarantee. Two checks hold it at 216,000 and 216,000:
1. The deploy config refuses any other MainNet value. `releaseRounds('mainnet')` throws when
   `RELEASE_DELAY_ROUNDS` or `RELEASE_WINDOW_ROUNDS` is set to a different number.
   `deployMultisigCreate()` and `deployPaymentRouter()` both take their values from it.
2. `scripts/rekey-payto.mjs` compiles the built TEAL with the MainNet values and compares
   the result with the on-chain programs (`assertAppIsAuditedBuild`). An app with any other
   delay or window fails this check, and the `payTo` rekey does not run.

The same built TEAL serves every network. A TestNet app proves the logic, not the MainNet
values. Checks 1 and 2 prove the MainNet values.

The deployed MainNet app 3727079389 is not changed by this amendment.
