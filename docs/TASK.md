# Task — MVP to SPEC.md v6 and MainNet qualification

This is the single "what next" document. `NOTES.md` is the log. Update both after each unit of
work (`/handoff`).

## Role

You are the orchestrator for the AuPM project. You plan, delegate and verify.
You never write production code yourself. Sonnet subagents do all
implementation (`model: "sonnet"`). Follow `CLAUDE.md` § Orchestration.

## Goal

Bring the code to SPEC.md v6 and qualify on MainNet. There are two tracks:

- **Track Q (qualification, first real MainNet payment by Sept 25).** It does not need
  PaymentRouter. `payTo` is a plain account that is opted into USDC and takes payments. The
  ledger accrues from the first payment.
- **Track R (PaymentRouter, done before the first claim).** It replaces SplitRouter, passes
  the TestNet rehearsal, then `payTo` is rekeyed on MainNet and the nightly job credits the
  backlog.

The deadline is Sept 29. The form is submitted on Sept 27.

## Inputs

Read these before you plan:

- `CLAUDE.md` (invariants, canonical facts).
- `SPEC.md` §9.2 (timeline), §10 (constraints), §11 (routes, pricing, opt-in), §12
  (attestations), §13 (ledger, nightly job, claims), §14 (review flow), §15 (do-not-build),
  §17 (work sequence).
- `CONTEXT.md` (terms) and `docs/adr/0001`–`0008`.

Decided in v6 (do not reopen): SQLite stays; credit batches; tarball 402 only with
`X-SPM-Donate: 1`; partial attestation on `X-SPM-Donate: 0`; the auditor anchors each review
with a note transaction; 1,000 µUSDC per reviewed package with no discount.

## Setup

1. `git fetch origin`. Create branch `spm-mvp-v6` from `origin/master` after the v6 spec PR is
   merged.
2. Worktree subagents start from `master`. A new worktree cannot check out a commit that
   changes `.claude/settings.json`. `git reset --hard` is denied in a subagent. Use
   `git merge --ff-only <sha>` when a worktree must sync.
3. Merge each subagent branch into `spm-mvp-v6` in the main tree.
4. Run `scripts/verify.sh` and proxy tests with the Bash sandbox disabled.

## Work items

Each item states the result and the acceptance checks. Put the acceptance checks in the
subagent prompt. Run them again yourself before you accept an item.

### H1. prek replaces `.githooks` (first) — DONE 87c9ef0

Result:
- A prek config at the repo root. On `pre-commit`: `bash scripts/guard.sh`,
  `pnpm exec biome ci .`, `pnpm typecheck`, a secret scan (gitleaks, pinned), `actionlint`
  and `zizmor` on `.github/`. On `pre-push`: the unit tests of the four packages and
  `node --test scripts/*.test.mjs`.
- `prek install` for both hook types. Delete `.githooks/` (replace, do not deprecate).
- CI runs `prek run --all-files` in place of its separate guard, Biome and typecheck steps.
  CI keeps its test steps.
- `verify.sh` calls `prek run --all-files` for its lint part, then runs tests and e2e.
- `CLAUDE.md` § Commands lists `prek run --all-files`.
- Justify each hook repository and pin it to a full commit SHA or an exact version.

Acceptance:
- A commit with a planted Biome error fails at the hook. A planted fake mnemonic fails the
  secret scan.
- `prek run --all-files` passes on a clean tree. CI is green.

### H2. Claude Code hooks — DONE ff2553b

Approved by the user on 2026-09-22. The edit still needs the permission prompt.

The sandbox write-protects `.claude/settings.json` and `.claude/hooks/`. Draft the change;
the user applies or approves it.

Result:
- `PostToolUse` on `Edit|Write`: `pnpm exec biome check --write <file>` for files Biome
  covers.
- `PreToolUse` on `Bash`: block a command that prints a `*_MNEMONIC` value, and block
  `git push` to `master`.
- No `Stop` hook that runs `verify.sh` (slow; a failing Stop hook loops the agent).

Acceptance: each hook fires once in a manual test. Log the change in
`.claude/HARNESS-CHANGELOG.md`.

### H3. Remove unused skills — DONE 1c0b701

Approved by the user on 2026-09-22. The deletion still needs the permission prompt.

Delete `.claude/skills/{algorand-python,algorand-x402-python,algokit-utils-py,
algorand-frontend,algorand-ecosystem}`. Remove their rows from `AGENTS.md`. The sandbox
write-protects `.claude/skills`; use `trash` with the user's approval.

Acceptance: `rg -n 'algorand-python|x402-python|algokit-utils-py|algorand-frontend|algorand-ecosystem'
AGENTS.md CLAUDE.md .claude` is empty.

### Q1. Tarball: 402 only with donation opt-in — DONE ac1f1e1

Result (SPEC §10.4, ADR 0006): the `onProtectedRequest` hook grants access to an unreviewed
tarball, and to a reviewed tarball unless the request sends `X-SPM-Donate: 1`. Every tarball
response carries `X-SPM-Tier`. A free reviewed tarball carries `X-SPM-Donate-Hint: 1000`.

Acceptance: tests for unreviewed → 200; reviewed, no header → 200 with `X-SPM-Tier`;
reviewed, `X-SPM-Donate: 1` → 402; unreviewed, `X-SPM-Donate: 1` → 200.

Owner: `x402-proxy-engineer`.

### Q2. Attestation routes: partial attestation and statement changes — DONE 90a2f73

Result (SPEC §11.2, §12.3):
- `X-SPM-Donate: 0` on `/v1/attest` or `/v1/attest/lockfile` returns a free partial
  attestation, before the payment middleware. It withholds reviewed entries whose integrity
  matches. `predicate.withheld` = the count; `absentMeans: "UNREVIEWED_OR_WITHHELD"`.
  `INTEGRITY_MISMATCH` and `UNRESOLVABLE` entries are always listed.
- A full attestation has `predicate.withheld: 0`.
- Remove `predicate.registryAppId`. Rename `attestTxid` to `anchorTxid` everywhere.
- The partial path shares the per-IP rate limit of the zero-coverage path.

Acceptance: tests for a partial lockfile with 2 reviewed, 1 mismatch, 1 unresolvable →
withheld 2, mismatch and unresolvable listed; no header → 402; `spm verify` accepts a partial
attestation.

Owner: `x402-proxy-engineer`.

### Q3. Lockfile price per reviewed package — DONE bda3a0d

Result (SPEC §11.2, ADR 0008): the lockfile route price is a `DynamicPrice` function of
1,000 µUSDC × N, where N counts reviewed entries whose integrity matches. N comes from the
same code that builds the attestation. The Bazaar description says "$0.001 per reviewed
package". Attribution writes exact role shares per reviewed package; delete the pro-rata
remainder rule.

Acceptance: a lockfile with 3 reviewed entries → the decoded `PAYMENT-REQUIRED` amount is
`"3000"`; accruals sum to exactly 3,000; `validateDiscoveryExtension(decl.bazaar).valid`
stays true.

Depends on Q2. Owner: `x402-proxy-engineer`.

### Q4. Clients: opt-in header and spend cap — DONE cafba88

Result (SPEC §11.4):
- CLI, MCP and Action send `X-SPM-Donate: 1` with the opt-in and `X-SPM-Donate: 0` without it.
- Spend cap: 1,000 µUSDC × the lockfile entries sent (1,000 for a tarball or one package),
  USDC only. Remove the fixed 20,000 cap.
- Without opt-in: the CLI prints the withheld count and exits 0; the MCP tool returns the
  partial attestation with `status: 'donation_required'`; the Action passes and prints the
  count.

Acceptance: tests for both header values; a 402 above the cap is refused; a lockfile with 25
reviewed entries is paid.

Owner: `mcp-payer-engineer`.

### Q5. Delete claim registration, GitHub proofs, `seed.ts`, `payout.ts` — DONE e6ef9c3

Result: delete `POST /api/v1/claims`, `proxy/src/claims/github.ts`, the `claims` table,
`proxy/src/seed.ts` and `scripts/payout.ts`, and every reference to them (`package.json`,
docs, `demo.sh`, `e2e.mjs`, `CLAUDE.md` repo map). Keep `GET /api/v1/earnings/github/:login`.

Acceptance: `rg -n 'api/v1/claims|seed\.ts|payout\.ts' proxy cli mcp scripts CLAUDE.md` is
empty; tests pass.

Owner: `x402-proxy-engineer`.

### Q6. Review anchor and `record-review` — DONE 5ca4fe7

Result (SPEC §14, ADR 0007):
- `scripts/anchor-review.mjs <name> <version> --reviewer <login> --scope <scope>
  --key-file <path>`: run by the auditor on their own machine. It fetches `dist.integrity`,
  prints the fields, requires an interactive `yes`, and sends the 0-ALGO self-payment with the
  ARC-2 note `spm:j{...}`. It prints the txid. `NETWORK` selects TestNet or MainNet.
- `scripts/record-review.mjs <anchorTxid>`: run by the operator on the server. It reads the
  anchor from the indexer, checks the sender against `AUDITORS` (`github:<login>=<address>`,
  in `.env.example`), checks the integrity against npm for that exact version, resolves the
  repo key (§13.1), prints all fields, requires an interactive `yes`, and writes the row with
  `anchor_txid` and `review_scope`.
- Neither tool runs in CI, a fixture or a seed path. With no TTY, both refuse.
- Repo key parsing: GitHub `owner/repo`, else `npm:<name>`. Remove the maintainer attribution
  code (`proxy/src/app.ts` `maintainer: null`, the missing packument parser in
  `attribution-rules.ts`).

Acceptance:
- Unit tests for the note encode/decode, a wrong sender, an integrity mismatch, no TTY, and
  these `repository` shapes: a string, an object, `git+https`, `git+ssh`,
  `github:owner/repo`, GitLab, missing, malformed.
- `guard.sh` fails when any non-test file other than `record-review.mjs` writes a reviewed
  status.

Owner: `x402-proxy-engineer`.

### Q7. Ledger and nightly job — DONE 7fc8082

Result (SPEC §13.2, ADR 0001, ADR 0005):
- SQLite schema: `accruals` gets `batch_seq`; new `batches` table; money columns `INTEGER`.
- One nightly entry point replaces `reconcile-main.ts`: reconcile → `VACUUM INTO` a dated
  copy and move it to `BACKUP_DIR` (the operator mounts off-host storage there) → credit. The
  credit step stops with a clear log line when `PAYMENT_ROUTER_APP_ID` is unset or `payTo` is
  not rekeyed. A failed backup stops the job before the credit.
- Unmatched inflows are ledgered as `unassigned` ops income and go into
  `unattributedTotal`.
- Replace `deploy/systemd/spm-reconcile.*` with `spm-nightly.*`, which runs
  `docker compose run --rm spm <nightly command>`.

Acceptance: tests for a backup failure (no credit), an unset app id (no credit, exit 0), a
batch whose txid is recorded (never re-sent), and batch totals equal to the ledger sums.

Credit call depends on R1. Owner: `x402-proxy-engineer`.

### Q8. Docker Compose deploy — DONE 5e52f93

Result (SPEC §10.3): a `proxy/Dockerfile` and a root `compose.yaml` with one service, the
SQLite file on a named volume, and `.env` from the host. No database container.

Acceptance: `docker compose up` serves `/api/v1/status/ms/2.1.3`; the volume keeps the file
across a restart.

### Q9. Key separation and env — DONE efdf4aa

Result:
- Deploy and admin scripts read `DEPLOYER_MNEMONIC`. The crediter reads `CREDITER_MNEMONIC`.
  `SPM_DONOR_MNEMONIC` is client-side only. `optin-usdc.mjs` takes the account as an argument.
- `PAY_TO_ADDRESS` replaces `SPLIT_APP_ADDRESS` everywhere; the app id is
  `PAYMENT_ROUTER_APP_ID`.
- `.env.example` lists `SPM_KEY_VALID_FROM` (default from `proxy/src/config.ts`), `AUDITORS`,
  `BACKUP_DIR`.

Acceptance: `rg SPM_DONOR_MNEMONIC contracts scripts proxy` shows no server-side use;
`rg SPLIT_APP_ADDRESS` is empty outside `NOTES.md`.

### Q10. Deploy and check tooling for both networks — DONE efdf4aa

Result: `NETWORK` (`testnet` | `mainnet`) selects the asset and algod endpoint for every
script. A MainNet action refuses without `--confirm-mainnet`. Fix the macOS `sed -i ''` in
`scripts/deploy-testnet.sh` (rename it if it serves both networks). `check-402.mjs` takes
`--network`.

Acceptance: `shellcheck` is clean; tests for both networks; the existing MainNet tests of
`check-402.mjs` pass unchanged.

### Q11. Public texts and donor guide — DONE c5a173d

Result: README, `og:description` and the Bazaar descriptions show both splits (SPEC §6.2)
and "$0.001 per reviewed package". README gets a donor section (SPEC §11.4): a fresh donor
account, about 0.3 ALGO plus a few dollars of USDC, the USDC opt-in, a wallet with an in-app
USDC purchase. README stops saying the store is anything but SQLite and stops stating a
20,000 cap.

Acceptance: `rg -n '50/20/15/10/5|20% (goes )?to maintainers|20,000|\$0\.02' README.md proxy/src`
is empty.

### Q12. Guard rules for v6 — DONE d893834

Result: `guard.sh` fails on any tracked reference to `SplitRouter`, `distribute(` or
`attest(` in contract code outside `docs/` and `NOTES.md`; a `REAL` money column; a Postgres
or Drizzle import; a review-row write outside `record-review.mjs` (Q6).

Acceptance: each rule fails on a planted violation and passes when you remove it.

### R1. PaymentRouter replaces SplitRouter — DONE 60d1b90

Result (SPEC §10.1, skill `spm-payment-router`): the contract with
`credit(batchSeq, attributedTotal, unattributedTotal, entries)`, `claim()`, the admin
identity map, the crediter key setter and `releaseAuthority(to)`. No `attest()`, no
`setAttestationKey()`. Delete SplitRouter entirely: source, spec, tests, typed client,
deploy config.

Acceptance: the test vectors in SPEC §17 R0 pass. Tell the user that a human must run
`algokit project run build`.

Owner: `algorand-contract-engineer`.

### R2. Contract deploy and rekey tooling — DONE 012cf58

Result: deploy PaymentRouter, set the crediter key and the auditor map, then rekey `payTo`.
The rekey step refuses when `payTo` is not opted into USDC. It works when `payTo` already
holds USDC.

Acceptance: unit checks for both refusals and the MainNet guard. Depends on R1 and Q10.

### R3. On-chain e2e step — DONE 8b948ca

Result: when the app id, `payTo`, the crediter key and a funded donor key are set, the e2e
step pays, runs the nightly job and claims against the real network. It reports PASS or FAIL,
never a false PASS. Without them, it SKIPs with its reason. Merge the useful part of
`demo.sh` into this step, or delete `demo.sh`.

Depends on R1, R2, Q7.

### R3a. Self-contained rehearsal — DONE 8c9e0b2

Result: each rehearsal run makes its own `payTo`, claimants, PaymentRouter app and proxy with a
throwaway ledger, so a run never meets another ledger's batch sequence. It needs only the
deployer (about 1.72 ALGO per run), crediter and donor (0.25 USDC) keys. No script loads `.env`
on import; tests prove it without opening the real file. Step 8 sends the donation opt-in.
Commits `faa59b2` (rehearsal) and `8c9e0b2` (tests never touch the real `.env`).

### R3b. Fixes from the first live run — DONE 6740615

Result: the offline attestation check parses `ATTEST_SIGNING_KEY` with the proxy's own parser
(mnemonic or hex seed). The paid-install check reads the txid from the indexer with a bounded
retry, not from the algod pool. Precondition errors name the account address.

### R3c. Genesis guard and deployer budget — DONE cb15d02

Result: the e2e and the nightly job check the algod and indexer genesis against `NETWORK`
before any on-chain step, and stop with the endpoint and env var in the message. The
rehearsal's deployer budget includes the creator's app min-balance increase, computed from the
ARC-56 schema (2,007,500 µALGO per run).

### R3d. Unique rehearsal app; guarded operator deploy — DONE 95e3f27

Result: each rehearsal run creates an app named `PaymentRouter-e2e-<ms>` and fails unless the
deploy created it. The operator deploy keeps the name "PaymentRouter" and refuses, before any
admin call, when the existing app's stored payTo or asset differs from `.env`.
Also fixed with R3c: the indexer genesis comes from `/v2/blocks/1` (`8465742`), not `/health`.

### R3e. Operator deploy entry point — DONE f9bfe38

Result: `pnpm run deploy:ci` (and `algokit project deploy`) runs in `contracts/`; the client
reads `INDEXER_URL` with per-network defaults; a failed deploy exits non-zero. Found in R4
part 2 (see `NOTES.md`). Owner: `algorand-contract-engineer`.

### R4. TestNet rehearsal (before the MainNet rekey) — DONE 07ccce4

Result, in two parts:
1. Claim rehearsal — DONE 2026-09-24 (txids in `NOTES.md`):
   `NETWORK=testnet bash scripts/demo.sh` PASSes. One lockfile payment with
   250 reviewed entries (250,000 µUSDC) → nightly job credits batch 1 → `claim()` for the
   auditor (100,000) and for ops (150,000). One tarball payment credits only 400 / 600, below
   `MIN_CLAIM`, so the rehearsal uses 250 entries. The contract stays unchanged.
2. Persistent TestNet deploy — DONE 2026-09-25, as on MainNet: the operator's `payTo`
   opt-in → deploy PaymentRouter → rekey → Compose at the TestNet domain → one real anchored
   review → one payment through GoPlausible → nightly job (backup, credit batch 1). Deployed
   app 772553842; the step guide is in `NOTES.md`.

Acceptance: the txid of each step is in `NOTES.md`.

### M0. Move the TestNet deployment (human, before the MainNet deploy) — DONE 2026-09-26

TestNet and MainNet run on separate hosts, one instance per host. The current TestNet host
becomes the MainNet host. Before the MainNet deploy, the operator moves TestNet to its own host:
1. Copy `audit.db` from the old volume, or run `record-review` again for each anchor.
2. Set a new `SPM_ISSUER_URL` and a new `SPM_KEY_VALID_FROM`.

Check: the status route on the new TestNet host shows the recorded reviews.

### N1. Nightly scheduler inside the proxy — DONE c4d07d4

The proxy process runs the nightly job. The host systemd timer is removed. One process stays the
only writer (ADR 0001).
1. The server entry point schedules `runNightly()` every day at 03:17 UTC.
2. At start, if the last successful run is more than 24 hours old, or no run exists, the server
   runs the job once.
3. A failed run logs `spm-nightly: failed — <reason>` and never stops the server.
4. A lease in SQLite stops two runs from overlapping. `nightly-main.ts` stays as the operator's
   manual entry point and takes the same lease. A second run exits with a clear message.
   A lease older than one hour counts as released.
5. SQLite records each run: start, end, result, error, batch, credit txid.
6. `GET /api/v1/health` (free) returns the last run and the last success. It returns 200 when the
   last success is at most 26 hours old, else 503.
7. `SPM_NIGHTLY` (default `on`) turns the scheduler off. The proxy test that boots the server and
   the e2e rehearsal proxy set `off`. Another value refuses to boot.
8. Delete `deploy/systemd/`. Update every reference to it. Update SPEC §13.2 and add ADR 0009.

Acceptance: tests for the next-run time, the start-up catch-up, the lease overlap, the lease
expiry, a failed run that does not stop the server, and the health route (200 and 503).
Owner: `x402-proxy-engineer`.

### N2. CI image — DONE b971d8a

A GitHub Actions workflow builds `proxy/Dockerfile`. On a `v*` tag it pushes
`ghcr.io/tripleight/spm:<tag>` (public package). On a pull request it builds without a push.
Actions are pinned to commit SHAs. `actionlint` and `zizmor` pass. Permissions are least
privilege (`packages: write` only on the push job).

### N3. Compose for Portainer — DONE 61dbb8a

One `compose.yaml` for the local machine and for Portainer:
1. `image:` pins `ghcr.io/tripleight/spm:<version>`. `build:` stays for a local build.
2. The environment comes from `.env` or from Portainer's `stack.env`. Each file is optional.
3. The nightly job needs no `docker compose run` (N1). The backup bind mount stays.

Check: `docker compose config` passes with only `.env`, and with only `stack.env`.
Owner: `x402-proxy-engineer`. After N1 and N2.

### T1. Stray test processes — DONE c086ac2

`proxy/src/index.test.ts` spawns the server through `pnpm` → `tsx` → `node`. `SIGKILL` stops only
the top process. The `node` child can stay alive and hold a fixed test port in the next run.
Result: the test starts the server so that one kill stops the whole tree (for example `node
--import tsx/esm` directly, or a process group), and each test uses a free port.
Check: after `pnpm -C proxy test`, `ss -ltnp` shows no listener on the test ports.
Owner: `x402-proxy-engineer`.

### D1. Rewrite the operator docs (last) — DONE e64157e

After the tracks are merged and `verify.sh` passes:
1. Rewrite `docs/RUNBOOK-mainnet-launch.md` from the new code. It still describes SplitRouter
   and `distribute()`.
2. Rewrite `docs/DEPLOY-GUIDE.local.md` (not committed; `.git/info/exclude`). Keep its
   structure: role table, TestNet phases, MainNet delta, cleanup, gaps. Do not name the
   production host or domain.
3. Rewrite `docs/RUNBOOK-contract-build.md` for PaymentRouter: contract name, method list,
   on-chain checks.
4. ASD-STE100 style. Every command must exist in the repository. Every step has a "Check:"
   line.
5. Remove the WARNING banners from both runbooks.
6. Backup (decided: the host's restic/Backrest plan, no status check in SPM).
   `SPM_BACKUP_HOST_DIR` is a local directory owned by uid 1000. The Backrest plan includes it,
   runs daily after the nightly job (03:17 UTC), excludes `.audit-*.db.tmp`, and alerts the
   operator on a snapshot error. Check: after one night, the newest `audit-*.db` is in the
   latest snapshot.
7. One instance per host. TestNet runs behind traefik, MainNet behind cloudflared. Document the
   Portainer stack (N3), the reverse-proxy rule for each, and the M0 move. Do not name a domain.
8. The donor guide sets the donor key from a secret manager for one command only. The key
   never sits in a `.env` file.

### Q13. Issuer URL and key date required on every network — DONE c65edd5

Result: on every network, the server refuses to boot when `SPM_ISSUER_URL` is not an
`https://` origin or `SPM_KEY_VALID_FROM` is not an ISO-8601 UTC time. Neither has a default.
They come only from `.env` or `stack.env`; a shell export does not change them (F2). TestNet
tests the same config as MainNet. The team does not own the placeholder domain.
Every signed statement carries the issuer, so a wrong value cannot be corrected later.

Acceptance: tests for unset, malformed and valid values on both networks. Owner: `x402-proxy-engineer`.

### F1. Compose pins the published image — DONE 68ed80d

The `v0.1.0` image build failed, and the `v0.1.0` tag is deleted. The first published image is
`ghcr.io/tripleight/spm:v0.1.1`. `compose.yaml` and the MainNet runbook §3 name `v0.1.1`.

Acceptance: `rg 'v0\.1\.0' compose.yaml docs/` finds nothing. Owner: `x402-proxy-engineer`.

### F2. Issuer and key date come only from the env file — DONE e3d349c

Compose interpolation lets a shell export override `.env`. `compose.yaml` no longer interpolates
`SPM_ISSUER_URL` or `SPM_KEY_VALID_FROM`; they come only from `env_file`. The server still refuses
to boot without valid values (Q13). `SPM_BACKUP_HOST_DIR` and `PORT` stay interpolated.

Acceptance: with a shell export of `SPM_ISSUER_URL`, `docker compose config` has no
`environment:` entry for it. Owner: `x402-proxy-engineer`.

### F4. Clean shutdown on SIGTERM — DONE e9aa06f..c34839f

The proxy runs as PID 1 and had no SIGTERM handler, so every stop ended in SIGKILL. Now SIGTERM or
SIGINT stops the scheduler, starts the server close, and waits up to 8 s for an in-flight nightly
run. The database closes only when that run is idle; else the process exits 1 and the lease
expiry reclaims the run. A second signal exits 1 at once. ADR 0009 records this.

Acceptance: tests for idle, busy, a server close that never ends, a failed server close and a
second signal. Owner: `x402-proxy-engineer`.

### V1. The verify e2e proxy runs on a free port — DONE 9de186e

`scripts/verify.sh` started its e2e proxy on the fixed port 4873. With a live stack on that port,
e2e tested the live stack and failed. The e2e proxy now takes a free port from the OS, and the
readiness check confirms that the started process is still alive.

Acceptance: with another process on 4873, `verify.sh` prints `VERIFY: PASS`. Owner:
`x402-proxy-engineer`.

## Wave 7 — production readiness before the MainNet launch

Goal: before the MainNet deploy, the project reads as a product, a donor and an auditor can
start from the README alone, and the contract's trust model is written down. The MainNet
deploy is final: PaymentRouter cannot be updated after it is created, and `payTo` is the
leaderboard key (invariant 1). So P1 comes first.

### N0. Rename SPM to AuPM (first) — DONE c11224c

Decided by the user, 2026-09-28: "SPM" is an occupied name. The new name is AuPM (audited
package manager). The rename covers every name, the wire names included. Only TestNet runs
today, so no dual-read shim: the old names stop working.

Result:
1. Product text: `SPM` becomes `AuPM` in code, comments, docs, `SPEC.md`, ADRs, `CONTEXT.md`,
   `CLAUDE.md`, `AGENTS.md`, the Action, the agents in `.claude/agents/`.
2. Packages: `cli/` is npm package `aupm`, `mcp/` is `aupm-mcp`. The CLI command (`bin`) is
   `aupm`. The root and proxy package names use `aupm`. No doc or config names `spm-cli` or
   `spm-mcp`.
3. Wire names: headers `X-AuPM-Donate`, `X-AuPM-Donate-Hint`, `X-AuPM-Tier`; env vars `AUPM_*`
   (for example `AUPM_DONOR_MNEMONIC`, `AUPM_ISSUER_URL`, `AUPM_KEY_VALID_FROM`); key list
   `/.well-known/aupm-keys.json`; default output `aupm-attestation.json`; ARC-2 note prefixes
   `aupm:j` (review anchor) and `aupm:credit:` (credit batch); the Action directory
   `.github/actions/aupm-attest/` and workflow `aupm-attest.yml`; the Compose service and volume
   `aupm-db`; the image `ghcr.io/tripleight/aupm`. The Compose `image:` tag stays at the
   published tag until a human releases a new image.
4. History stays: past `NOTES.md` entries, past `.claude/HARNESS-CHANGELOG.md` entries and the
   text of items marked DONE keep "SPM". One `NOTES.md` line records the rename.
5. `scripts/guard.sh` passes, and its rules match the new names.

Not in scope (human): the GitHub repo name, the local directory, `.claude/skills/spm-*`
(sandbox-protected; the user renames them), the host `.env` and the volume migration, a new
image release, a new TestNet anchor for `ms@2.1.3` with the `aupm:j` note, the npm publish.

Check: `git grep -il 'spm'` lists only history files, `.claude/skills/`, the Compose image tag
and `.gitleaks.toml` entries that match old fixtures. `bash scripts/verify.sh` prints
`VERIFY: PASS`.

### P1. Contract change policy (analysis, first) — DONE 7c1f182

Question: after the MainNet deploy, which changes force a new PaymentRouter? A contract that
its operator replaces at will undermines trust.

Facts found on 2026-09-28 (check each against the code before you use it):
- `contract.algo.ts` sets no `allowActions` for update or delete. Confirm with a contract test
  that `UpdateApplication` and `DeleteApplication` are rejected.
- Compiled-in values: the auditor share `400/1000`, `MIN_CLAIM`, `MIN_CLAIM_FEE`, the `ops`
  identity, and the two-role `credit()` shape. The target six-way split (ADR 0003) needs a new
  contract.
- `releaseAuthority(to)` lets the creator key rekey `payTo` to any address. USDC stays in
  `payTo` until a claim. So the creator key controls every credited, unclaimed balance.

Result:
1. A list of change triggers. For each trigger: a new contract, an admin call, or no change.
   Include the six-way split, a new role, a changed `MIN_CLAIM`, a lost crediter key, a lost
   admin key, a bug.
2. Options to limit `releaseAuthority`, with tradeoffs. Examples: only to an application
   address; a delay with a public announcement; a multisig creator; a rule to credit and let
   payees claim before a migration. Also state what an old app keeps doing after a migration.
3. The user picks the options. Then: a new ADR 0010, the matching SPEC §10 text, and one
   contract item if the user picks a contract change. A contract change needs
   `algokit project run build` by a human and a new TestNet rehearsal before MainNet.

Owner: `algorand-contract-engineer` (analysis and tests). Decision: human.

### P2. `aupm` as a drop-in for npm

Main use case (user, 2026-09-28): a regular user runs AuPM in place of npm, with as little
friction as possible. Today `aupm install <pkg> <version>` takes a fixed argument shape and is
not npm-compatible. Donation needs a separate `aupm attest --donate`.

Facts (check each against the code first):
- A user who only sets `npm config set registry https://<domain>/` never gets a 402 and never
  sees a donation prompt. A reviewed tarball returns 200 free without `X-AuPM-Donate: 1`
  (invariant 4, ADR 0006). The proxy sets a hint header, but npm does not show response
  headers. A 402 to plain npm would break `npm install`, so this stays.
- npm fetches tarballs itself and cannot pay a 402. So a donation from an npm install goes
  through the lockfile route: one payment, 1,000 microUSDC per reviewed entry (ADR 0008).

Result:
1. `aupm <npm args>` runs `npm <npm args>` with the AuPM registry, and passes every argument and
   the exit code through unchanged. Output and behavior are npm's. AuPM adds only its own flags
   (`--donate`, and a flag to write the attestation file). AuPM flags never reach npm.
2. After a successful install, `aupm` prints one summary line: how many lockfile entries are
   `COMMUNITY_REVIEWED`, and the donation amount in dollars. Without `--donate` it signs
   nothing and adds one hint line: how to donate.
3. With `--donate` (or a persistent opt-in in the AuPM config), `aupm` runs the lockfile
   attestation with donation after the install. A failed donation never fails the install:
   it logs one line and keeps npm's exit code.
4. `aupm attest` and `aupm verify` stay, for CI and offline checks. A regular user does not need
   them.
5. pnpm: check if `POST /v1/attest/lockfile` parses `pnpm-lock.yaml`. If yes, `aupm pnpm <args>`
   behaves the same way. If no, write down the gap as a later item. npx: out of scope for
   wave 7; write it down as planned.
6. Walk the path as a new user on TestNet, from the README only. Cover: the one-line registry
   config, `aupm install --donate`, the MCP `attest_lockfile` with `allowDonation`, and the
   Action with `donate: 'true'`. Record every step that needs a repo clone, a hidden env var, or
   a guess, and fix it or list it.
7. Examples in every doc use `ms@2.1.3`. It is the package with a real anchored review.

Tests: argument pass-through (flags, `--`, positional args), exit code pass-through, AuPM flags
removed, donation failure keeps npm's exit code, summary line with 0 and with N reviewed
entries. Owner: `mcp-payer-engineer`.

### P2a. Package names (decision first) — decided 2026-09-28: `aupm`, `aupm-mcp` (N0)

The npm names `spm-cli` and `spm-mcp` belong to unrelated authors (`spm-cli`: "the awesome
style project manager"; `spm-mcp`: a product-document tool). A user who runs `npx spm-cli`
gets a stranger's code. For a security product this blocks the launch.

Candidates for the human to pick from, after a registry check at the start of the session
(`curl -s -o /dev/null -w '%{http_code}' https://registry.npmjs.org/<name>`, 404 = free):
- Unscoped: `spm` (probably taken; "SPM" also names the Swift Package Manager), `snpm`,
  `spm-proxy`.
- Scoped under an npm org that the team owns, for example `@<org>/spm` and `@<org>/spm-mcp`.
  A scope cannot be squatted per package and makes the publisher visible. Recommended.
- The command name (`bin`) is separate from the package name. `spm` as the command works with
  any package name. Check for a clash with a common global command.

Result: the chosen names in `cli/package.json`, `mcp/package.json`, the Action and all docs. No
doc or config names the foreign packages. Publish is a human step (npm login, 2FA,
provenance).

### P3. Amounts in dollars

User-facing text shows amounts in US dollars: 1,000 microUSDC is $0.001 per reviewed package.
USDC on Algorand stays the named settlement asset. Scope: README, docs, CLI and MCP output,
the 402 `description` text, the Action log lines. Code, SQLite columns and on-chain values stay
integer micro-units (invariant 7). One helper formats micro-units as dollars; test it at 0, 1,
999, 1,000 and 1,000,000.

Owner: `x402-proxy-engineer` (proxy text) and `mcp-payer-engineer` (CLI, MCP, Action).

### P4. Tier filter — planned (decided 2026-09-28)

The MVP has two tiers (`UNREVIEWED`, `COMMUNITY_REVIEWED`, SPEC §4.1) and no filter in any
client. The README describes filtering by tier as planned (SPEC §8), not as built. Donations
already go only to reviewed versions; the README states that as built.

### P8. New split: 30 / 10 / 20 / 25 / 10 / 5 (MainNet contract only)

Decided by the user, 2026-09-28:
- Target: auditor 30, contributor 10, maintainer 20, adversarial reviewer 25, treasury 10,
  ops 5 (per 1,000: 300 / 100 / 200 / 250 / 100 / 50).
- MVP: auditor 30, ops 70 (per 1,000: 300 / 700).
- TestNet keeps app 772553842 with the 40 / 60 split. No TestNet redeploy. The docs say so.

Result:
1. `contract.algo.ts`: `AUDITOR_SHARE_NUM` 300. Contract tests for the new amounts, including
   the rounding of odd totals. Bundle any P1 contract change into the same build.
1a. P1 contract change (ADR 0010, SPEC §10.2a): `announceRelease(to)` and `executeRelease()`
   replace `releaseAuthority(to)`. The delay is 216,000 rounds, compiled in. `executeRelease`
   sends `creditedUnclaimed` USDC from `payTo` to the address mapped to `treasury` (it fails if
   `treasury` is not mapped), sets `creditedUnclaimed` to 0, marks the app retired (`credit()`
   and `claim()` fail after that), then rekeys `payTo`. The deploy tooling creates the app from
   a 2-of-3 multisig creator. Tests: an early execute fails; execute without an announcement
   fails; execute without `treasury` fails; the sweep amount; credit and claim fail when
   retired; a non-admin caller fails on both methods.
2. SPEC §6.1, §6.2 and every place that states the split; a new ADR that supersedes ADR 0003;
   `CLAUDE.md` (overview and the canonical facts table); README; public texts; `guard.sh` rules
   that check split text. Invariant 8 still holds.
3. Because TestNet is not redeployed, rehearse the new build on LocalNet: deploy, rekey a
   `payTo`, credit one batch, claim. Record the result.
4. A human runs `algokit project run build` and commits the artifacts.
Owner: `algorand-contract-engineer` (contract, tests, LocalNet) and a docs subagent (texts).

### P5. README as a product page

The README describes the product, not the repo. Source text (the user's draft, 2026-09-28):

> Many companies use open source and audit their dependencies internally. These findings
> never get back to open source. AuPM creates an opportunity for security auditors, open-source
> supporters and repository maintainers to improve security and get paid for their labour.
> Users and their agents donate to the products and dependencies they use, as they go.

Sections: the problem and the product; the review tiers (filtering is planned, P4); what a
donation pays for, in dollars, with the P8 target split and MVP split (invariant 8); "For users
and donors" (`aupm` as a drop-in for npm, P2); "For auditors" (next paragraph); verify offline;
links. All examples use `ms@2.1.3`.
- Auditor path: an Algorand account opted in to USDC; the admin maps the identity
  (`setIdentity`); the auditor reads the exact tarball; the review anchor (a 0-ALGO
  self-payment with an ARC-2 `aupm:j{...}` note, ADR 0007); the operator runs `record-review`;
  the nightly batch credits; the auditor claims at `MIN_CLAIM` or more. State that onboarding
  is manual in the MVP (item A1).
- Move development setup, the repository layout and all deploy text to `docs/DEVELOPMENT.md`
  and the runbooks. The README links to them.
- ASD-STE100 style. Never name the production domain or host provider (use `<domain>`).
Owner: docs subagent after P2, P3 and P4. `bash scripts/guard.sh` must pass (split text rules).

### P6. Operator doc fixes carried from wave 6

- M0 text: a new attestation key gets a new `AUPM_KEY_VALID_FROM`; a reused key keeps its date.
- Local deploy guide: Compose prefixes the volume name with the project (`spm_aupm-db`), and the
  backup directory is owned by uid 1000.

### P7. Production review pass — DONE (findings, 2026-09-28)

A read-only review of `proxy/`, `cli/`, `mcp/` and the Action for launch risks: secrets in logs,
error text that leaks internals, request size limits, timeouts on upstream fetches,
`pnpm audit --audit-level=moderate`, the image user and pinned versions. Output: a ranked
finding list. Each accepted finding becomes one item. Owner: `code-reviewer`.

**Result (2026-09-28).** The review found no secret in logs, exact pins everywhere, a non-root
image, and body and entry caps on the lockfile route. The user accepted three findings as items
P7a, P7b and P7c. Not accepted: timeouts on algod and indexer calls in the nightly job (low),
Action stderr in `::warning::` (low, no secret on that path), the Compose image tag (human
release), and the `elliptic` dev advisory (no patch).

### P7a. Rate limit before the lockfile parse — DONE e62666c

`POST /v1/attest/lockfile` reads up to 5 MB and parses up to 10,000 entries before any rate
limit. The per-IP limiter guards only the free branch (`proxy/src/routes/attest.ts`). A caller
can post lockfiles with one reviewed entry and use server CPU at no cost.
Result: a second per-IP limiter runs on every lockfile request before `analyzeLockfile`,
120 requests per hour per IP (a compiled-in constant next to the free-path limit), 429 beyond.
The free-path limiter (20 per hour) stays. SPEC §12.3 states both limits. Tests: the 121st
request in the window gets 429 before the body is parsed; the free-path limit still applies.
Owner: `x402-proxy-engineer`.

### P7b. Generic text for an unhandled error — DONE 5a5e613

`app.onError` in `proxy/src/app.ts` returns `err.message` to the client. A SQLite error can
show the database path. Result: the handler logs the error on the server and returns
`{ "error": "internal error" }` with status 500. Test: a thrown error with a path in its message
does not reach the response body. Owner: `x402-proxy-engineer`.

### P7c. Timeout on the npm upstream fetch — DONE 8cd5b5f

`proxyToNpm` in `proxy/src/proxy.ts` calls `fetch` with no timeout. Result: the fetch has an
`AbortSignal.timeout` (30 s, a compiled-in constant); a timeout returns 504 with a short JSON
error. Test: a stalled upstream returns 504. Owner: `x402-proxy-engineer`.

## Order

- **Wave 1 (parallel worktrees):** H1; Q1; Q5; Q9 + Q10; R1.
- **Wave 2:** Q2 → Q3; Q4; Q6; Q8; H3.
- **Wave 3:** Q7; Q11; Q12; R2. H2 when the user is present.
- **Qualification (human, by Sept 25):** SPEC §17 Q steps 1–6 on MainNet.
- **Wave 4:** R3 → R3a → Q13 → R3b → R3c → R3d → R3e → R4 → S1 → (N1 ‖ N2) → N3 → D1 → M0
  → MainNet rekey and first credit.
- **Wave 6:** release `v0.1.1` → F1 → M0 → F2 → F4 → V1.
- **Wave 7:** N0 ‖ P1 (analysis) first; P2a is settled by N0 → P8 (with P1's contract change)
  ‖ P7 → P2 → P3 → P5 → P6 → MainNet launch (human steps, checked by the orchestrator). P4 is
  decided (planned).

### S1. Dependency advisories — DONE 349de5c

`pnpm audit --audit-level=moderate` reports 47 advisories on `master` (for example `hono`,
`@hono/node-server`, `brace-expansion`, `fast-uri`). `hono` and `@hono/node-server` are proxy
production dependencies. Result: triage each advisory, upgrade with exact pins, and re-run the
proxy tests. Check: no moderate-or-higher advisory in a production dependency.

**Result.** The proxy's direct `hono` and `@hono/node-server` were not affected; the advisories
came from transitive dependencies. `mcp/package.json` pins
`@modelcontextprotocol/sdk@1.30.1` (was 1.29.0). `pnpm-workspace.yaml` adds exact-pinned
`overrides` for the transitive packages that carried the remaining advisories: `ws` 8.21.0,
`fast-uri` 3.1.6, `ip-address` 10.3.1, `qs` 6.16.0, `tar` 7.5.21, `brace-expansion@1` 1.1.18,
`brace-expansion@5` 5.0.9, `nanoid` 3.3.18, `postcss` 8.5.23, `esbuild` 0.28.1, and
`body-parser` 2.3.0. Each pin is the lowest patched version inside the major version the
parent package already declares; no `@x402-avm/*` package changed. Check:
`pnpm audit --prod --audit-level=moderate` exits 0 — no moderate-or-higher advisory in any
production dependency. One dev advisory is left: `elliptic` (low severity, pulled by
`@algorandfoundation/algorand-typescript-testing`), because the advisory database lists no
patched version.

## After the MVP

- **A1. Auditor onboarding at run time.** Adding or removing an auditor needs no `.env` edit,
  no redeploy and no restart. Today the list lives in `AUDITORS` (read by
  `scripts/record-review.mjs` and the deploy), and only the deploy calls `setIdentity()`.
  Result: one admin command maps the identity on-chain (`setIdentity`), checks the USDC
  opt-in, and records the auditor where `record-review` reads it.

## Human-only items

- P0 donor recruitment (SPEC §17 P0).
- MainNet provisioning of `payTo` (opt-in only, key cold) and the auditor addresses.
- Public hosting and the domain.
- Real package reviews and their anchors.
- The first real payment; the form and the Electric Capital submission.
- `algokit project run build` after a contract change.
- Wave 7 decisions: the contract change policy (P1), the package names and publisher (P2a).
- Wave 7 human steps: `algokit project run build` for P8, the npm publish.
- Legal read before any payout to a third party (SPEC §13.4).

## Definition of done

### Per work item

The orchestrator accepts an item only when all of these are true. Check each one with a
tool call on raw output, never on a subagent report or on `rtk`-filtered output.

1. Each acceptance check of the item passes when the orchestrator runs it.
2. Each new behavior and each handled error path has a test.
3. At least one new test fails when the orchestrator reverts the item's main code change.
   Restore the change after the check.
4. `pnpm typecheck`, `pnpm exec biome ci .` and `bash scripts/guard.sh` pass with zero
   warnings (`prek run --all-files` after H1).
5. `git diff --stat` shows only files that the item owns, plus tests and docs it names.
6. No assertion was weakened, skipped or deleted to make a check pass.
7. The eight invariants in `CLAUDE.md` hold. No code, fixture or seed creates a review record.
8. The item is one commit: imperative subject, 72 characters or fewer, no AI attribution.
9. If the code clarified the spec, the matching `SPEC.md` section or ADR is updated in the
   same commit.
10. The item heading in this file ends with `— DONE <short-sha>`.

An item that fails a check goes to a fix subagent with the raw error output. After two failed
fix attempts, stop that item. Report the item, both attempts and the log paths to the user.

### Per session

1. `bash scripts/verify.sh` prints `VERIFY: PASS`. Sandbox disabled.
2. `prek run --all-files` passes.
3. The user has been told that a human must run `algokit project run build`.
4. `NOTES.md` and this file are updated (`/handoff`).
5. The branch is pushed and a PR into `master` is open. Do not merge it.
6. Report to the user: each item with its commit SHA, the decisions taken, and any gaps.

A session can end before all items are done. It is still done when items 1, 2, 4 and 6 are
true for the merged items, and the report lists the open items with their blocker.
