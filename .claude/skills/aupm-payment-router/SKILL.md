---
name: aupm-payment-router
description: >
  PaymentRouter AVM contract: USDC accrues at a payTo account that is later rekeyed to
  the app, a crediter key credits auditor and ops balances in numbered batches, payees
  claim, admin methods, the delayed release, and the contract-test limits. Use when you
  read, edit, or test the PaymentRouter contract under contracts/smart_contracts/.
---
# PaymentRouter

Status: built. Source: `contracts/smart_contracts/payment_router/contract.algo.ts`
(Puya-TS, ARC-4). Specified in `SPEC.md` §10.1–10.2a. Build runbook:
`docs/RUNBOOK-contract-build.md`.
Decisions: `docs/adr/0002-repo-pools-with-trusted-crediter.md`,
`docs/adr/0004-payto-rekeyed-account.md`, `docs/adr/0005-credit-batches.md`,
`docs/adr/0007-auditor-anchors-review.md`, `docs/adr/0010-contract-change-policy.md`,
`docs/adr/0011-split-30-10-20-25-10-5.md`.
The source is the ground truth. If this file and the source disagree, trust the source and
fix this file.

## Money flow

WARNING: never split per payment. The facilitator accepts only a plain USDC asset
transfer to `payTo`. The contract is not called at settlement. Never say "in the same
transaction". Never call `credit()` permissionless.

1. A donor pays through the facilitator. USDC lands at `payTo`, unallocated. This works
   before the contract exists: qualification does not need PaymentRouter.
2. After the rekey, the nightly job calls `credit(batchSeq, …)` with the crediter key, once
   per batch. One call holds at most 6 `bal:` boxes ("ops" included), so the job splits a
   larger backlog into several batches in one run (`planCreditChunk` in
   `proxy/src/claims/credit.ts`). A batch holds whole paid packages, never part of one.
3. The auditor and ops call `claim(identity)` from the address the admin mapped to that identity.

## payTo (Variant B)

- `payTo` is a plain account, not the app address.
- Order: `payTo` opts into USDC 31566704 FIRST, takes payments, then is rekeyed to the app
  before the first claim. Never reverse opt-in and rekey. A rekeyed account cannot sign its
  own opt-in.
- Until the rekey, the `payTo` key stays cold and offline. It signs only the opt-in and the
  rekey.
- `scripts/rekey-payto.mjs` refuses to rekey unless the app's approval and clear programs
  equal the committed ARC-56 `byteCode`, `extraProgramPages` is 0, and the creator is the
  2-of-3 admin multisig from `AUPM_ADMIN_MSIG_ADDRS`.
- Inner axfers use `sender = payTo`.
- `executeRelease()` hands `payTo` to a later authorizer. `payTo`'s address never changes
  after the first USDC arrives. It is the leaderboard key.

## Split

- Target: 30 auditor / 10 contributor / 20 maintainer / 25 adversarial / 10 treasury / 5 ops.
- MVP on-chain: auditor 300, ops 700 per 1,000 microUSDC (`AUDITOR_SHARE_NUM`). The 70% is
  ops income.
- Every attributed price is 1,000 microUSDC per reviewed package, so
  `attributedTotal × 300 / 1000` is exact. No rounding, no remainder.

## Methods

| Method | Caller | Effect |
|---|---|---|
| `credit(batchSeq, attributedTotal, unattributedTotal, entries)` | crediter key only | `entries` = auditor `(repo, identity, amount)`, summed per `(repo, identity)` over the batch. `repo` is not stored on-chain. Asserts the app is not retired. Asserts `batchSeq == last + 1`. Asserts sum(entries) == `attributedTotal × 300 / 1000`. Asserts `attributedTotal + unattributedTotal` ≤ unallocated balance. Credits `balances[identity]` for each entry; credits `attributedTotal − sum + unattributedTotal` to `balances["ops"]`. Needs no identity mapping, so an unmapped identity never stalls a batch. |
| `claim(identity)` | the address mapped to `identity` | Asserts the app is not retired, the identity is mapped, and `Txn.sender` equals its address. Pays the whole `balances[identity]` to the sender and deletes the box. Requires balance ≥ `MIN_CLAIM` (100,000 microUSDC). Inner fee 0; asserts outer fee ≥ 2,000 microALGO. A remap sends later claims to the new address. |
| `setIdentity(identity, addr)` | admin | Maps an identity (`github:<login>`, `"ops"`, or `"treasury"`) to the address that claims its balance. Takes effect at once. |
| `setCrediter(addr)` | admin | Authorises the crediter key. Takes effect at once. |
| `announceRelease(to)` | admin | Records `to` and the current round. A new call overwrites both and restarts the delay. |
| `executeRelease()` | admin | Runs only from `announcedRound + 216,000` up to, not including, `announcedRound + 432,000` (delay, then a 216,000-round window). Sweeps `creditedUnclaimed` to the `"treasury"` address, zeroes it, marks the app retired, rekeys `payTo` to `to`. After the window, it fails until the admin announces again. |

The admin is `Global.creatorAddress`, a 2-of-3 multisig. There is no update or delete route.

WARNING: the release delay does not limit the admin. `setIdentity` and `setCrediter` take
effect at once, so the multisig can redirect every balance and the unallocated USDC with no
delay. Never describe the delay as protection against the admin. A timelock on those methods
is a v7 candidate (`SPEC.md` §21).

Unallocated balance = USDC balance of `payTo` − `creditedUnclaimed` (global state). The
contract is amount-agnostic: it never asserts a fixed payment amount. There is no `attest()`
and no `setAttestationKey()`: the auditor anchors each review with a note transaction (ADR 0007).

## Keys

- Crediter (`CREDITER_MNEMONIC`): hot, on the server, can call only `credit()`. Never the
  deployer, the admin, the donor or `payTo`.
- Admin: the 2-of-3 multisig from `AUPM_ADMIN_MSIG_ADDRS`. Signers sign offline. Never on the
  server. A single-key deployer (`DEPLOYER_MNEMONIC`) is for the TestNet rehearsal only.
- `payTo` key: cold, offline; opt-in and rekey only.
- Donor (`AUPM_DONOR_MNEMONIC`): client-side only.
- Env: `PAY_TO_ADDRESS`, `PAYMENT_ROUTER_APP_ID`.

## Test vectors

- Batch of one tarball payment 1,000 → auditor 300, ops 700.
- Batch of one lockfile payment with 3 reviewed packages (3,000) → entries 300 / 300 / 300,
  ops 2,100.
- Batch of two payments for the same `(repo, identity)` → one entry of 600.
- `unattributedTotal` 5,123, `attributedTotal` 0 → ops 5,123, no entries.
- Entries that do not sum to `attributedTotal × 300 / 1000` → `credit()` fails.
- `batchSeq` not equal to last + 1 → fails. Totals above the unallocated balance → fails.
- Balance 99,999 → `claim()` fails. 100,000 → succeeds.
- `executeRelease()` at `announcedRound + 215,999` fails; at `+ 216,000` and `+ 431,999`
  succeeds; at `+ 432,000` fails.

## Tests

- Contract tests run under `@algorandfoundation/algorand-typescript-testing`, in JavaScript.
- CAUTION: they do not prove the contract compiles under Puya.
- CAUTION: inner transactions do not move ledger balances in that harness.
  Balance assertions after `claim()` are arithmetic, not balance reads.
- CAUTION: Puya rejects `for (const x of abiArray)` over a mutable ABI array argument.
  Iterate `clone(abiArray)` or use an index loop. The JavaScript tests do not catch this;
  only the Puya build does.
- Each new `balances` box needs minimum balance on the app account, not on `payTo`.
  The deploy step funds the app account.
- After any contract change, run `pnpm -C contracts run build` with the Bash sandbox
  disabled (inside the sandbox it prints `error: fetch failed` and writes nothing). Commit
  the regenerated artifacts under `contracts/smart_contracts/artifacts/`.
- Amounts are integer micro-units. Never use floats.
