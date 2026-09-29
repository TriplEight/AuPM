# Unread review records are allowed on TestNet only

A TestNet rehearsal needs 15–30 reviewed packages to measure the lockfile flow and the payment
loop. A human read of each package costs more than the rehearsal needs. On TestNet, an operator
may therefore anchor and record a review that no human read. Each such review uses the normal
path: a review anchor signed by the mapped auditor address, then `record-review.mjs` with its
TTY prompt. Its scope starts with the word `unread` (for example `unread: testnet rehearsal`),
and the status API shows that scope. `record-review.mjs` refuses an `unread` scope on any
network other than TestNet. No seed script enters the repo: the batch helper lives in the
operator's TestNet workspace.

The signed attestation does not carry the scope. A TestNet server that holds unread records
therefore uses a TestNet-only issuer origin, never the MainNet origin, so that no attestation
signed for such a record can pass for a MainNet one. Unread records never move to a MainNet
database. On MainNet, `COMMUNITY_REVIEWED` still means that a human read that exact tarball.
