---
name: aupm-payment-router
description: >
  PaymentRouter AVM contract: USDC accrues at a payTo account that is later rekeyed to
  the app, a crediter key credits auditor and ops balances in numbered batches, payees
  claim, admin methods, and the contract-test limits. Use when you read, edit, or test
  the PaymentRouter contract under contracts/smart_contracts/.
---
# PaymentRouter

Status: specified in `SPEC.md` §10.1–10.2 (v6). Built by `docs/TASK.md`. Expected source:
`contracts/smart_contracts/payment_router/contract.algo.ts` (Puya-TS, ARC-4). Build runbook:
`docs/RUNBOOK-contract-build.md`.
Decisions: `docs/adr/0002-repo-pools-with-trusted-crediter.md`,
`docs/adr/0003-six-way-split.md`, `docs/adr/0004-payto-rekeyed-account.md`,
`docs/adr/0005-credit-batches.md`, `docs/adr/0007-auditor-anchors-review.md`.

## Money flow

WARNING: never split per payment. The facilitator accepts only a plain USDC asset
transfer to `payTo`. The contract is not called at settlement. Never say "in the same
transaction". Never call `credit()` permissionless.

1. A donor pays through the facilitator. USDC lands at `payTo`, unallocated. This works
   before the contract exists: qualification does not need PaymentRouter.
2. After the rekey, the nightly job calls `credit(batchSeq, …)` with the crediter key, once
   per batch. The first batch credits the whole backlog.
3. The auditor and ops call `claim(identity)` from the address the admin mapped to that identity.

## payTo (Variant B)

- `payTo` is a plain account, not the app address.
- Order: `payTo` opts into USDC 31566704 FIRST, takes payments, then is rekeyed to the app
  before the first claim. Never reverse opt-in and rekey. A rekeyed account cannot sign its
  own opt-in.
- Until the rekey, the `payTo` key stays cold and offline. It signs only the opt-in and the
  rekey.
- Inner axfers use `sender = payTo`.
- `releaseAuthority(to)` hands `payTo` to a later contract. `payTo` never changes after
  the first USDC arrives. It is the leaderboard key.

## Split

- Target: 40 auditor / 10 contributor / 20 maintainer / 15 adversarial / 10 treasury / 5 ops.
- MVP on-chain: auditor 400, ops 600 per 1,000 microUSDC. The 60% is ops income.
- Every attributed price is 1,000 microUSDC per reviewed package, so
  `attributedTotal × 400 / 1000` is exact. No rounding, no remainder.

## Methods

| Method | Caller | Effect |
|---|---|---|
| `credit(batchSeq, attributedTotal, unattributedTotal, entries)` | crediter key only | `entries` = auditor `(repo, identity, amount)`, summed per `(repo, identity)` over the batch. `repo` is not stored on-chain; the per-repo breakdown stays in the off-chain ledger. Asserts `batchSeq == last + 1` (global state, no box per payment). Asserts sum(entries) == `attributedTotal × 400 / 1000`. Asserts `attributedTotal + unattributedTotal` ≤ unallocated balance. Credits `balances[identity]` for each entry; credits `attributedTotal − sum + unattributedTotal` to `balances["ops"]`. Needs no identity mapping, so an unmapped identity never stalls a batch. |
| `claim(identity)` | the address mapped to `identity` (an auditor, or `"ops"`) | Asserts the identity is mapped and `Txn.sender` equals its address. Pays the whole `balances[identity]` to the sender and deletes the box. Requires balance ≥ `MIN_CLAIM` (100,000 microUSDC). Inner fee 0; asserts outer fee ≥ 2,000 microALGO (claimant pools the fee). A remap sends later claims to the new address. |
| admin: map identity → address | admin | Maps an identity (`github:<login>`, or the fixed `"ops"`) to the address that claims its balance, opted into USDC. |
| admin: set crediter key | admin | Authorises the crediter key. |
| `releaseAuthority(to)` | admin | Rekeys `payTo` away from the app. Disclose it publicly. |

Unallocated balance = USDC balance of `payTo` − the running total of credited, unclaimed
balances (global state). The contract is amount-agnostic: it never asserts a fixed payment
amount. There is no `attest()` and no `setAttestationKey()`: the auditor anchors each review
with a note transaction (ADR 0007).

## Keys

- Crediter (`CREDITER_MNEMONIC`): hot, on the server, can call only `credit()`. Never the
  deployer, the admin, the donor or `payTo`.
- Deployer/admin (`DEPLOYER_MNEMONIC`): never on the server at runtime.
- `payTo` key: cold, offline; opt-in and rekey only.
- Donor (`AUPM_DONOR_MNEMONIC`): client-side only.
- Env: `PAY_TO_ADDRESS`, `PAYMENT_ROUTER_APP_ID`.

## Test vectors (SPEC §17 R0)

- Batch of one tarball payment 1,000 → auditor 400, ops 600.
- Batch of one lockfile payment with 3 reviewed packages (3,000) → entries 400 / 400 / 400,
  ops 1,800.
- Batch of two payments for the same `(repo, identity)` → one entry of 800.
- `unattributedTotal` 5,123, `attributedTotal` 0 → ops 5,123, no entries.
- Entries that do not sum to `attributedTotal × 400 / 1000` → `credit()` fails.
- `batchSeq` not equal to last + 1 → fails. Totals above the unallocated balance → fails.
- Balance 99,999 → `claim()` fails. 100,000 → succeeds.

## Tests

- Contract tests run under `@algorandfoundation/algorand-typescript-testing`, in JavaScript.
- CAUTION: they do not prove the contract compiles under Puya.
- CAUTION: inner transactions do not move ledger balances in that harness.
  Balance assertions after `claim()` are arithmetic, not balance reads.
- CAUTION: Puya rejects `for (const x of abiArray)` over a mutable ABI array argument.
  Iterate `clone(abiArray)` or use an index loop. The JavaScript tests do not catch this;
  only `algokit project run build` does.
- Each new `balances` box needs minimum balance on the app account, not on `payTo`.
  The deploy step funds the app account.
- After any contract change, a human runs `algokit project run build` and commits
  the regenerated artifacts under `contracts/smart_contracts/artifacts/`.
- Amounts are integer micro-units. Never use floats.
