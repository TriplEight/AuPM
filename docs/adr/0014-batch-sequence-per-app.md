# The ledger numbers credit batches per PaymentRouter app

`credit()` requires `batchSeq` to be exactly one more than the app's `lastBatchSeq` (ADR 0005).
A new PaymentRouter app (ADR 0010 migration) starts at 0. The ledger numbered batches in one
global sequence, so the first credit to a new app sent the wrong number and failed. Now the
key of `batches` is `(app_id, batch_seq)`, and an accrual refers to its batch by `batch_app_id`
and `batch_seq`. The next batch for the configured app is the highest `batch_seq` of that app
plus one, so a new app starts at batch 1. The local number stays equal to the on-chain number,
and the `aupm:credit:<batchSeq>` note lookup searches only the configured app. The schema
upgrade runs in place at boot. It assigns every existing batch and every batched accrual to the
configured app id, because one app received every credit before this change. One app is
configured at a time. A rollback to an earlier app continues that app's own sequence, because
its rows keep their app id. We rejected a
separate local batch id with the on-chain number in its own column: it breaks the equality of
the local and on-chain numbers that the crash recovery in `credit.ts` relies on.
