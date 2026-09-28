# Repo pools with a trusted crediter replace role-pool distribute()

PaymentRouter keeps a balance per repository and role in contract state, and payees claim
from it (pull-based). The facilitator accepts only a plain USDC transfer to `payTo`, so the
contract cannot see which repository a payment is for. A crediter key on the server therefore
calls `credit(settleTxid, total, entries)` after settlement. The contract asserts that the
auditor entries sum to exactly 40% of `total` and credits the rest to ops, so the split is
enforced on-chain for each payment and only the pro-rata rounding happens off-chain. It rejects
a repeated txid and any `total` above the unallocated balance. This replaces the permissionless
`distribute()` to five role-pool accounts. The trade-off: the attribution of a payment to a
repository now depends on a trusted key, and in return per-repo funds stay on-chain and every
payee withdraws without a manual payout. Phase 2 replaces the admin-written claimant mapping
with an oracle-signed identity binding.

Amended by ADR 0005: `credit()` takes numbered batches, not one `settleTxid`.

Amended: balances are per identity, not per repository. A `MIN_CLAIM` floor per repo pool
would strand small pools below the floor, and paying one identity through many repo pools
would cost one fee per pool instead of one fee per identity. The per-repo breakdown stays in
the off-chain ledger (§13.2); the contract sees only an identity and an amount.

Amended by ADR 0011: the contract asserts the auditor entries sum to exactly 30% of `total`,
not 40%.

Amended by docs/TASK.md P8d: TestNet moves to a new app from the rebuilt 30% contract; the
earlier TestNet app, which still asserted 40%, is retired.
