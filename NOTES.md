# SPM build log (two-dev handoff)

Use `/handoff <summary>` to append entries. Newest at top.

## 2026-09-21 Variant A decided — launch tooling added on `spm-launch-tooling`

- **Decision**: the user chose the `payTo` variant — Variant A. `payTo` is
  the SplitRouter application address. Call `setRecipients` only. Never call
  `setPayTo`. The app is not deployed yet.
- **Changed**: branch `spm-launch-tooling`, on top of `master` (`0be2758`,
  PR #18 `spm-spec-closeout` merged).
  - `b48d302` removes the TestNet pins (`USDC_ASA_ID`, `ALGOD_SERVER`) and
    the `npm:*`/`npx:*` allows from `.claude/settings.json`.
  - `scripts/check-402.mjs`, the step 3 attribution check (exits 0 only if
    tag, asset, network, and feePayer all PASS).
  - `scripts/hit-rate.mjs`, the SPEC.md §4.2 seed-list median measurement.
  - `deploy/systemd/spm-reconcile.{service,timer}` for the reconciliation
    timer. A human installs them.
  - `scripts/verify.sh` now also runs `unit:scripts`
    (`node --test scripts/*.test.mjs`).
- **State**: `bash scripts/verify.sh` prints `VERIFY: PASS` on this branch.
  e2e: 9 passed, 1 SKIP (the on-chain step — no funded wallet or deployed
  contract yet).
- **Quirk**: a worktree subagent cannot check out a commit that changes
  `.claude/settings.json` — the sandbox write-protects that file. Worktree
  agents must run from `master`, not from this branch.
- **Next**: push `spm-launch-tooling`, open a PR into `master`, and merge it.
  Then deploy with Variant A.

## 2026-09-21 Donation opt-in on every client; SPEC.md renamed; STATUS.md retired

- **Changed**: donation opt-in on every client — CLI `spm attest [--donate]`,
  MCP `attest_lockfile` with `allowDonation`, Action `donate` /
  `donor-mnemonic` inputs, shared client `mcp/src/donor.ts`. The Action now
  installs `spm-cli` and runs `spm attest` instead of posting only.
- **Decisions**: "donor"/"donate" replace "payer" (except literal
  `cat=payers`, `feePayer`). `SPM_DONOR_MNEMONIC` replaces `PAYER_MNEMONIC`.
  Spend cap 20,000 microUSDC, USDC ASA only, no config knob. `SPEC-v3.md` is
  now `SPEC.md`; `STATUS.md` is deleted in favour of
  `docs/HANDOFF-next-session.md`.
- **Next**: schedule `pnpm -C proxy reconcile` on the host.

## 2026-09-21 Contract artifacts regenerated; toolchain on pnpm 12

- **Changed**: SplitRouter artifacts regenerated with `puya-ts` 1.1.0 and `puya`
  5.3.2. The ABI has all seven methods and `pay` is gone. This is the first
  Puya compile of the current contract. AlgoKit commands run through pnpm.
  `allowBuilds` replaces `onlyBuiltDependencies`, which pnpm 11 removed. CI runs
  pnpm 12.5.1 on Node 22 through `pnpm/setup` v3.0.0. The stale
  `contracts/pnpm-lock.yaml` is deleted.
- **State**: `scripts/verify.sh` prints `VERIFY: PASS` on a networked host. The
  on-chain e2e step is SKIPPED until `PAYER_MNEMONIC`, `SPLIT_APP_ID` and
  `SPLIT_APP_ADDRESS` are set. CI and SPM Attest pass on GitHub.
- **Next**: `docs/HANDOFF-next-session.md` step 2, the `payTo` variant decision.

### Not MVP — do after launch

Each item is real, but none blocks MainNet.

1. Pin the actions in `.github/workflows/spm-attest.yml` to full commit SHAs.
   `actions/checkout@v4`, `actions/setup-node@v4` and
   `actions/upload-artifact@v4` are tag references. `ci.yml` is already pinned.
2. Add `actionlint` and `zizmor` to CI. Nothing lints the workflow files today.
3. Add a prek config. The repo has no pre-commit hooks.
4. Pin `contracts/package.json` exactly. It has 11 caret ranges, against the
   rule in `CLAUDE.md`. The lockfile holds `puya-ts` 1.1.0, but a global
   AlgoKit install may use 1.3.1. CAUTION: a `puya-ts` upgrade changes the
   TEAL. Regenerate the artifacts and rerun the contract tests with it, and
   never change it after the MainNet deploy without a redeploy.
5. Remove the npm-only fields from `contracts/package.json`. pnpm ignores the
   top-level `overrides` block: the lockfile has `esbuild@0.28.0`, not the
   0.25.0 it asks for. `engines.npm` does not apply either. If the esbuild pin
   is still needed, move it to `overrides` in `pnpm-workspace.yaml`.

## 2026-09-20 Handoff — ready for MainNet launch

- **Changed**: Attestation routes, claims ledger, `spm verify`, MainNet MCP payer,
  eager boot guard, published attestation keys route, Biome, invariant guard,
  git hooks, CI, and a rewritten verification harness. Twelve spec corrections.
  README rewritten for MainNet.
- **Files**: `proxy/src/{app,config}.ts`, `proxy/src/{attest,claims,x402,routes}/*`,
  `cli/src/verify.ts`, `contracts/.../contract.algo.ts`, `scripts/*`,
  `SPEC-v3.md`, `README.md`, `STATUS.md`.
- **State**: 147 proxy, 8 cli, 7 contracts, 5 mcp, 6 action tests pass.
  Typecheck, guard and `biome ci` all clean. `scripts/verify.sh` exits 0 with
  the e2e step SKIPPED, because this sandbox cannot reach the facilitator.
- **Blocked**: Nothing buildable. What remains needs a chain, a domain, or a
  human reviewer.
- **Next**: Follow `docs/RUNBOOK-mainnet-launch.md`. WARNING: read its section 1
  first. `distribute()` will not run below 100,000 microUSDC, so a single
  $0.001 payment cannot produce the five inner transfers the qualification
  checklist requires. Five lockfile calls, or a direct top-up, reach the floor.

## 2026-09-19 Contract artifacts stale — build needed on a Docker machine

- **Changed**: `SplitRouter` reworked for the v3 MainNet spec. `pay()` removed;
  `distribute()`, `releaseAuthority()`, `setAttestationKey()` added; `attest()`
  gained an `integrity` argument. Proxy migrated to the x402 middleware;
  `settle.ts` deleted. DSSE attestation signing added. `spm verify` added.
  Biome, an invariant guard, pre-commit hooks and CI added.
- **Files**: `contracts/smart_contracts/split_router/*`, `proxy/src/{app,config}.ts`,
  `proxy/src/x402/*`, `proxy/src/attest/*`, `cli/src/verify.ts`, `scripts/guard.sh`,
  `biome.json`, `.githooks/pre-commit`, `.github/workflows/ci.yml`.
- **State**: 45 proxy, 8 cli, 7 contracts, 5 mcp and 6 action tests pass.
  Typecheck passes. Guard is clean. Direct-dependency advisories are zero.
- **Blocked**: `contracts/smart_contracts/artifacts/` is STALE. The committed
  ARC-56 spec still lists `pay()` and lacks `distribute()`. The session that
  reworked the contract had no Docker and no AlgoKit CLI, so it could not
  compile with Puya or run LocalNet. WARNING: the JavaScript test harness does
  not prove the contract compiles or runs on the AVM.
- **Next**: Run `docs/RUNBOOK-contract-build.md` on a machine with Docker and
  the AlgoKit CLI. It lists the build commands, the ABI that must appear, the
  five constructs most likely to fail under Puya, the LocalNet rehearsal, and
  the irreversible opt-in-before-rekey ordering for `payTo`.

## 2026-06-07 EURD bonus track integrated

- **Changed**: Added `@ever_amsterdam/x402-euro-eurd@0.1.1` (zero prod deps) to MCP. Proxy 402 response now includes `exact+algorand:mainnet` EURD entry when `EURD_MAINNET_ASA_ID`+`EURD_PAY_TO` env vars set. `settle.ts` dispatches on proof type (USDC signed-group vs Quantoz bridge transactionCode). MCP `install_audited_package` uses `withEurPayment` wrapper when `QUANTOZ_API_KEY`+`QUANTOZ_ACCOUNT` present; falls back to USDC otherwise. Fixed pre-existing `MockAlgod` missing `getApplicationByID` in MCP test.
- **Files**: `mcp/src/tools/install.ts`, `mcp/src/tools/install.test.ts`, `mcp/package.json`, `proxy/src/app.ts`, `proxy/src/settle.ts`, `.env` (added EURD/Quantoz var stubs).
- **State**: `SPLIT_APP_ID=764063661` on TestNet. EURD vars blank — EURD path inactive until filled.
- **Blocked**: Need `EURD_MAINNET_ASA_ID` from Quantoz docs + a funded Quantoz account (`QUANTOZ_API_KEY`, `QUANTOZ_ACCOUNT`) for live EURD payment demo.
- **Next**: Get EURD ASA ID from https://docs.ai.quantozpay.com, set env vars, run `NETWORK=testnet bash scripts/demo.sh` to confirm EURD path end-to-end.

## 2026-06-07 G4 complete — verify.sh green

- **Changed**: G1–G4 all done; pure-JS contract tests (algorand-typescript-testing), Hono proxy + SQLite x402 gate, MCP install/check tools, e2e checks (status/gate/auto-reset) all pass.
- **Files**: `contracts/vitest.config.mts`, `contracts/vitest.setup.ts`, `contracts/smart_contracts/split_router/contract.algo.{ts,spec.ts}`, `proxy/src/**`, `mcp/src/tools/{install,check}.{ts,test.ts}`, `scripts/{verify,e2e}.{sh,mjs}`, `pnpm-workspace.yaml`.
- **State**: No deployed contract; `SPLIT_APP_ID` and `PAYER_MNEMONIC` unset — paid-install e2e check skips (requires LocalNet with Docker or TestNet).
- **Blocked**: Docker not available → no LocalNet → on-chain paid-install e2e skipped.
- **Next**: Deploy SplitRouter to TestNet via `algokit project deploy testnet`; fund payer wallet; set `SPLIT_APP_ID` + `PAYER_MNEMONIC`; run `NETWORK=testnet bash scripts/demo.sh` (G5).

## <date> bootstrap
- Repo scaffolded; Algorand agent skills + .mcp.json in place; SPM Claude config written.
- Next: Dev A -> proxy passthrough (hr1 sync); Dev B -> SplitRouter on LocalNet.

## 2026-09-19 W0 x402-avm research (no code changed)

- **Task**: Read installed @x402-avm packages, answer 5 questions with file:line citations.
- **Findings**: See `/tmp/claude-0/-home-user-SPM/49e092e2-974a-5c45-b1bb-a30d7a0befbf/scratchpad/w0-findings.md`.
- **Key answer**: Hono middleware DOES discard the handler body on settlement failure (returns a new Response built from the settlement error, not the handler's body) — `hono/dist/esm/index.mjs:176-182`.
- **Key answer**: Middleware skips settlement entirely when handler status >= 400 — `hono/dist/esm/index.mjs:164-166`.
- **Next**: Feed these findings into the proxy's x402 gate implementation (spm-x402-flow skill).

## 2026-09-21 — handoff to the Docker / AlgoKit / MainNet session

Branch `claude/spm-spec-orchestration-dlhhe2`, 35 commits, all pushed.

Implementation of SPEC-v3 is complete except the contract artifacts, which
need Docker and the AlgoKit CLI. Three code reviews ran after implementation
and found 25 defects the test suite did not. All are fixed except that one.

State: proxy 306, contracts 16, mcp 8, cli 16, Action 9. `pnpm typecheck`
passes, `scripts/guard.sh` is clean, `biome ci .` exits 0 with no warnings,
`scripts/verify.sh` prints `VERIFY: PASS` with an honest e2e SKIP, because the
facilitator is unreachable from this sandbox.

Read `docs/HANDOFF-next-session.md` first. Step 1 is regenerating the contract
artifacts; nothing else should happen before it. The committed ARC-56 spec
still lists the deleted `pay` and lacks `setPayTo`, `distribute` and
`releaseAuthority`.

Two decisions recorded this session:
- `payTo` may be corrected while it holds no USDC, and is immutable once any
  arrives. This replaced a write-once rule that made a typo unrecoverable.
- The CI Action no longer sends a wallet credential. That narrows spec §9 C3;
  third-party paid volume now comes from the CLI or the MCP server.

The defect worth carrying forward: the tarball path check broke four times.
The first three were spelling variants closed by adding decoder rules, and each
left the next one open. The fourth was structural, two predicates of different
width deciding the same question. `normalizeTarballPath` now replicates the
installed matcher's own steps and `isTarballRouteScope` mirrors the route key.
Any change to the route key must change both.

## 2026-09-22 — SPEC v6 review (docs only, no code changed)

An executive review of the spec, the harness and the skills. Decisions (ADRs 0001, 0005–0008):
- Qualification no longer waits for PaymentRouter. `payTo` is a plain account, opted into
  USDC, and takes payments before the rekey. The rekey and the first credit come before the
  first claim.
- SQLite stays. ADR 0001 now records SQLite; PostgreSQL, Drizzle and Redis are dropped.
- `credit(batchSeq, attributedTotal, unattributedTotal, entries)`: one call per nightly
  batch. A per-payment credit cost about 11% of a $0.001 payment plus a replay box.
- A reviewed tarball returns 402 only with `X-SPM-Donate: 1`. Plain `npm install` stays free.
  Attestation routes keep standard x402; `X-SPM-Donate: 0` gets a free partial attestation.
  Integrity warnings are never withheld.
- The auditor anchors each review with a 0-ALGO note transaction. `attest()` and
  `setAttestationKey()` leave the contract.
- Price: 1,000 µUSDC per reviewed package on every route. The lockfile route stays (one
  settlement per CI run) with no cap and no discount. The pro-rata remainder rule is gone.
- One nightly job: reconcile, `VACUUM INTO` off-host backup, credit.
- Donors need about 0.3 ALGO as well as USDC. SPEC §17 P0 now says so.
- Next version (SPEC §21): review lineage with delta review, `spm donor init`, reviews as a
  file in git, Litestream, PostgreSQL on a second instance.

Found: the `.githooks/pre-commit` hook was never active (`core.hooksPath` unset). No Dockerfile
or compose file exists yet. Both runbooks still describe SplitRouter; they carry a WARNING
banner until `docs/TASK.md` D1 rewrites them.

Next: `docs/TASK.md`, wave 1.

## 2026-09-23 — wave 1: H1, Q1, Q5, R1

- Done: Q1 `ac1f1e1` (tarball 402 only with `X-SPM-Donate: 1`), Q5 `e6ef9c3` (claims, seed, payout
  deleted), H1 `87c9ef0` (prek replaces `.githooks`), R1 `60d1b90` (PaymentRouter; no APP_ID yet).
- Decided: PaymentRouter balances are per identity; `claim(identity)` by the mapped address.
  SPEC §10.1 and ADR 0002 are amended. The `spm-payment-router` skill lines 53–54 still need it.
- Blocked (human): `pnpm exec biome format --write .claude/settings.json`; `prek install
  --hook-type pre-commit --hook-type pre-push`; `algokit project run build` for PaymentRouter.
- Q9 + Q10 `efdf4aa`: `PAY_TO_ADDRESS`, `PAYMENT_ROUTER_APP_ID`, split keys, `scripts/network.mjs`
  (`NETWORK`, `--confirm-mainnet`). `deploy-testnet.sh` and `finish-setup.mjs` are deleted.
  e2e fix for Q1 `d2df4f2`. `bash scripts/verify.sh`: VERIFY: PASS (on-chain step SKIP).
- Open: e2e on-chain step still imports the deleted `SplitRouterClient` (R3);
  `contracts/scripts/genaccounts.ts` makes SplitRouter-era roles (R2). Branch is not pushed.
- Next: push `spm-mvp-v6`, open the PR into `master`, then wave 2 (Q2 → Q3; Q4; Q6; Q8).
- 2026-09-23 later: Puya rejected `for…of` over the `entries` ABI array; `8478ab6` uses an
  index loop (`clone()` broke the JS harness). Human build passed; artifacts `e348d58`.
  Skill updated for `claim(identity)` `8d35560`.

## 2026-09-23 — wave 2 (branch `spm-mvp-v6-wave2`, from `master` e912431)
- Q2 `90a2f73`: `X-SPM-Donate: 0` gives a free partial attestation on both attest routes
  (`withheld`, `UNREVIEWED_OR_WITHHELD`); `registryAppId` removed; `attestTxid`/`attest_txid` →
  `anchorTxid`/`anchor_txid` (proxy, cli verify test, mcp check, e2e). No app id involved.
- Q8 `39fad03` (branch `wave2-q8`, not merged): Dockerfile, `compose.yaml`, `.dockerignore`.
- Blocked: Q8 needs `docker compose up` by a user in the `docker` group (`undead` is not).
  `proxy/seed.sql` still uses `attest_txid`; Q6 deletes it.
- Next: run Q3 ‖ Q4 from `spm-mvp-v6-wave2`.
- Q4 `cafba88`: clients send `X-SPM-Donate: 1`/`0`; spend cap = 1,000 × lockfile entries
  (`donationCapMicro`, `mcp/src/lockfile-entries.ts`); no opt-in → CLI prints withheld and exits 0,
  MCP `donation_required`, Action warns with the count. Gap: the CLI has no `install` command
  (pre-existing; `CLAUDE.md` repo map lists one). Next: accept Q3, then Q6.
- Q3 `bda3a0d`: lockfile price is a `DynamicPrice` (1,000 × reviewed entries with matching
  integrity), read from the pre-middleware analysis through the `HonoAdapter` `c` field
  (private in the 2.6.1 types; recheck on any `@x402-avm/hono` bump). Ledger records six roles
  per package: 400/100/200/150/100/50; maintainer is always `unassigned`, ops is `ops`.
  Next: Q6 (anchor-review, record-review, repo key, delete `proxy/seed.sql`).
- Q6 `5ca4fe7`: `scripts/anchor-review.mjs` (auditor, own machine) and `scripts/record-review.mjs`
  (operator; `proxy/node_modules/.bin/tsx scripts/record-review.mjs <anchorTxid>`); logic in
  `scripts/review-anchor.mjs`. `audit_status` gets `review_scope` and `repo`. Guard RULE 9: only
  `record-review.mjs` writes a reviewed status. `e2e.mjs` writes its fixture row only when
  `SQLITE_PATH` is inside `os.tmpdir()` (user decision). `proxy/seed.sql` deleted.
  Next: Q8 image must carry the record-review scripts; then the human Docker check.
- Q8 `5e52f93`: `proxy/Dockerfile`, `compose.yaml` (service `spm`, volume `spm-db` at `/data`,
  `SQLITE_PATH=/data/audit.db`), `.dockerignore`; the image carries `scripts/record-review.mjs`.
  Checked with podman-compose on TestNet config: status JSON 200, same `audit.db` inode after restart
  and down/up, `record-review` no-TTY refusal in the container. Host quirk: podman storage under
  `~` inherits a default ACL for `tripleight`, so apt fails with EINVAL; pass
  `--podman-args=--root=/var/tmp/spm-podman-1001/root` (+ `--runroot`, `--storage-driver=vfs`).
  Wave 2 is complete. Next: wave 3 (Q7; Q11; Q12; R2).

## 2026-09-23 — wave 3 (branch `spm-mvp-v6-wave3`, from `master` f664466)
- Q12 scope (user decision): `SplitRouter`/`distribute(` banned in `contracts/`, `proxy/`,
  `mcp/`, `cli/`, `scripts/`, `.github/`, `README.md`; `attest(` banned in `contracts/` only.
  Q12 deletes the dead SplitRouter step from `scripts/e2e.mjs`; R3 rebuilds the on-chain step.
- Q11 `c5a173d`: README shows both splits, $0.001 per reviewed package, donor setup section,
  PaymentRouter credit/claim text. `OG_DESCRIPTION` in `proxy/src/x402/routes.ts` is the canonical
  og:description text; no HTTP route serves it, the operator sets the meta tag at the domain root.
  The `20,000` test title in `attribution-rules.test.ts` is renamed inside Q7.
  Quirk: empty untracked `.claude/launch.json` and `.claude/scheduled_tasks.json` make
  `biome ci .` fail in the main tree; run biome over `git ls-files`.
- Q7 `7fc8082`: `accruals` gets `repo` and `batch_seq`; new `batches` table. Nightly job
  `proxy/src/claims/nightly-main.ts` (local: `pnpm -C proxy nightly`; host: `spm-nightly.timer`
  runs `docker compose run --rm spm node --import tsx/esm src/claims/nightly-main.ts`):
  reconcile → `VACUUM INTO` `/backup` → credit. `compose.yaml` bind-mounts
  `SPM_BACKUP_HOST_DIR` at `/backup`; compose refuses to start without it. Credit call uses algosdk
  and a hand-kept ABI signature (the image has no contract artifacts). Each credit txn carries note
  `spm:credit:<batchSeq>`; a pending batch already credited on chain is recovered by indexer note
  lookup, never resent. Limit: 8 foreign refs → at most 5 auditor identities + ops per batch; no
  batch-split tool exists yet. `docs/RUNBOOK-mainnet-launch.md` §6 still shows spm-reconcile (D1).
- R2 `012cf58`: `contracts/smart_contracts/payment_router/deploy-config.ts` deploys PaymentRouter,
  funds the app account (1 ALGO) for box MBR, sets the crediter, maps `AUDITORS` and `ops`
  (`OPS_ADDRESS`). It refuses: MainNet without `CONFIRM_MAINNET=1`; algod genesis id not matching
  `NETWORK`; crediter equal to deployer/admin/payTo; a mapped address not opted into USDC.
  `scripts/rekey-payto.mjs PAY_TO_MNEMONIC --network <net> [--confirm-mainnet]` refuses: payTo not
  opted in; already rekeyed; genesis mismatch; app's `pto`/`ast` not this payTo/USDC;
  `PAY_TO_ADDRESS` ≠ mnemonic address. Zero USDC balance does not block the rekey.
  `scripts/optin-usdc.mjs` now loads algosdk from `proxy/` (the mcp package has none).
  Contract unchanged; no Puya build needed for R2.
- Q12 `d893834`: guard RULE 10 (`SplitRouter`/`distribute(` in contracts/, proxy/, mcp/, cli/,
  scripts/, .github/, README.md), RULE 11 (`attest(` in contracts/), RULE 12 (REAL/FLOAT/DOUBLE
  column, also after `(`/`,`/`ADD COLUMN`), RULE 13 (pg/postgres/drizzle/@neondatabase import,
  subpath import, or dependency). RULE 9 already covers review-row writes. `scripts/e2e.mjs` lost
  its dead SplitRouter step; it SKIPs "on-chain: PaymentRouter credit/claim" until R3.
  Quirks: `rg -E` means `--encoding`; `grep` here is ugrep. `trash` works only outside the sandbox.
  Wave 3 is complete. `verify.sh` → VERIFY: PASS. Next: human qualification (SPEC §17 Q1–6), then
  wave 4 (R3 → R4 → MainNet rekey → D1). Human: set `SPM_BACKUP_HOST_DIR` and `OPS_ADDRESS`.

## 2026-09-23 — wave 4: R3 (branch `spm-mvp-v6-wave4`, from `master` 09a428e)
- R3 `8b948ca`: `scripts/claim.mjs` claims one identity. The e2e on-chain step pays one lockfile
  of 250 reviewed `express` versions, runs the nightly job, checks the credit deltas, and claims
  `github:spm-e2e-auditor` and `ops`. TestNet only. It SKIPs and names each missing variable.
- Decision (user): no contract change for `MIN_CLAIM`. 250 entries, one repo, one identity →
  auditor 100,000, ops 150,000. The R4 text in TASK.md is updated.
- Files: scripts/{claim,claim.test,e2e,e2e.test}.mjs, scripts/fixtures/e2e-lockfile-packages.json,
  scripts/demo.sh (single operator entry point), .env.example (two e2e claimant keys).
- State: no TestNet PaymentRouter, no `.env`. VERIFY: PASS. Quirk: `$TMPDIR` differs with the
  sandbox off.
- Blocked (human): funded TestNet keys for payTo, deployer, crediter, donor (≥0.25 USDC), and
  the auditor and ops claimants (opted into USDC). `AUDITORS` maps `github:spm-e2e-auditor`.
- Next: fill `.env` for TestNet, then R4: opt-in → deploy → rekey →
  `NETWORK=testnet bash scripts/demo.sh`. Record each txid here.

## 2026-09-24 — wave 4: Q13, and a verify.sh regression found
- Q13 `c65edd5`: `SPM_ISSUER_URL` (https origin) and `SPM_KEY_VALID_FROM` (ISO UTC) have no
  default; boot and `compose.yaml` refuse without them on every network. Verify uses
  `https://spm-verify.invalid`. `cli/src/verify.test.ts` still has `spm.dev` test data (harmless).
- Open bug (R3a): `scripts/rekey-payto.mjs` loads the root `.env` at import. `claim.mjs` imports
  it, so `verify.sh` inherits the real `.env` donor key. Step 8 then runs and FAILs
  ("expected paid, got free": `installTool.handler` has no `allowDonation`). With no `.env`,
  VERIFY: PASS.
- Decision pending (user): two TestNet payTo/app pairs. One app holds one ledger, and each e2e
  run starts at batch 1.
- Next: approve and run R3a (import side effect, step 8 opt-in, fresh-app precondition).

## 2026-09-24 — wave 4: R3a
- R3a `faa59b2` + `8c9e0b2`: self-contained rehearsal. Each run makes a new payTo, auditor and
  ops account, app and proxy. Keys: deployer (~1.72 ALGO/run), crediter, donor (0.25 USDC).
  The two e2e claimant keys are removed. `loadRootEnv()` runs only on the CLI path.
  `scripts/assert-no-env-import.mjs` proves it without opening `.env`.
- Rejected on the first try: the tests appended to the real root `.env` and restored it.
- Checked in the main tree with the real `.env`: 165 script tests, 39 contract tests,
  VERIFY: PASS, `.env` checksum unchanged.
- Decision (user): the domains changed; they live in `.env` only.
- Open: the backup via Backrest instead of sshfs (awaiting the user's confirmation; then
  SPEC §13.2, TASK D1 item 6, the backup comments).
- Next: R4 part 1, `NETWORK=testnet bash scripts/demo.sh` with the user.

## 2026-09-24 — wave 4: R4 part 1, first live run; R3b; backup decision
- First live `NETWORK=testnet bash scripts/demo.sh`: 9 PASS, 3 FAIL. Paid install settled:
  `OXDU66WBE3BX723ZOVU2Z4APEWP2PY4VQR7YSGVXND5AI5K26YMA` (round 67617382, 1,000 µUSDC to payTo).
  FAILs: indexer-less txid lookup (404), key parsing for a mnemonic `ATTEST_SIGNING_KEY`,
  deployer with 0 ALGO.
- R3b `6740615`: fixes the first two; precondition errors name the address.
- Backup `f51e01d` (user decision): the host's restic/Backrest plan ships `BACKUP_DIR` daily;
  SPM runs no status check. SPEC §13.2 and TASK D1 item 6 updated.
- Blocked (human): fund the TestNet deployer with ≥1.8 ALGO.
- Next: rerun R4 part 1; each rerun sends one more 1,000 µUSDC step-8 payment to payTo.

## 2026-09-24 — wave 4: R3c and R4 part 1 retries
- Run 2 FAIL: `.env` had MainNet `ALGOD_SERVER`/`INDEXER_URL` with `NETWORK=testnet` (fixed by
  the user). Step 8 paid `WR74UFPYIWOZWMHMVAE7LLWHUIOAVICF7COMZEA6R65HEPYEWSAA` (TestNet 67618437).
- Run 3 FAIL at `setIdentity`: the deployer budget missed the creator app MBR (short by 500
  µALGO). Step 8 paid `P6LJCYPS7XS4KDSI4RAA5H424TEXRCOPALZTHEWSFLIGRRESAJSA`. Stranded
  throwaway app 772548283 (create `Z5PRXVX2SCXSGY2EK4SUNPFMJU7DBHAOHE33QH7AOYLLTVPRATBA`).
- R3c `cb15d02`: genesis guard in the e2e and the nightly job; budget 2,007,500 µALGO/run.
- Next: fund the deployer (E3P6K5E5…) with ~5 TestNet ALGO, then rerun R4 part 1.
- Run 4 FAIL before any chain write: the indexer `/health` has no `genesis-id` (my brief was
  wrong). Fixed in `8465742` (`/v2/blocks/1?header-only=true`).
- Run 5 FAIL at rekey: the idempotent deploy reused app 772548283 (same deployer and name).
  Step 8 paid `TTU47ILEMH5MI7GFPL5WOFY2XX7Y4YB6BX7SWCCI475CKZ2YGCWA`. No donor USDC spent.
- R3d `95e3f27`: unique rehearsal app name; operator deploy refuses a payTo mismatch.
- Blocked (human): deployer E3P6K5E5… owns "PaymentRouter" 772548283 on TestNet (throwaway
  payTo). Use a new TestNet deployer (~7 ALGO) in `DEPLOYER_MNEMONIC` for R4.

## 2026-09-24 — R4 part 1 PASS on TestNet (run 6, E2E 22/22, DEMO: PASS)
New deployer `DFEMINAMFNQJ23WULKYQN4ARIJAQXU5PJQMPSTWN7PGJQPSW6XEY32ZP54`. Checked on the indexer:
- Step 8 paid install: `EJ7AVIRROA5VLBAJGSWLOCXVJVUU4AERZLEBQDPAWKZRM7ZN73UA` (1,000 µUSDC → operator payTo).
- Rehearsal payTo `MEIIAZ2R…` opt-in `QNZLYX7J6QJ5274HXHA6H4JFJAHHQ72NSZ36U5RSS6BCAWVUN3GQ` (67620520).
- Deploy app 772551142: `EZRMTRJSSVRIMCCVLRPMUYA34FUBFSLGNPKLAQEWRIA77WK7XOWA`; setCrediter
  `TXOBKNF72BQVRZXIE6FHLM3J4GMQ5HGIULLB23SDFPXIQD4PUE7A`.
- Rekey payTo → app: `KWUTV7VBCUDMITKQ4EU3YWIQO2UOOUM4SXQPW5CMASSKFCZ2X2ZA` (67620540).
- Lockfile payment, 250 reviewed entries: `UAZG6FXFG5UUOZ5X7EKOXV35MM3NMYFOYS4KVNS4XZ77C73UBC2A`
  (250,000 µUSDC, 67620544).
- Nightly credit, batch 1: `CGBHO2HHP3P2YQ442ULUAGT6TYJTGLRHQSNATPPPG2M6NEWINMVQ` (67620547).
- Claim auditor: `GWJXJRMI767QIEZYU2QAZ2ANK4ULVBDCENJB2PS6JA66SLPWPFCQ` (inner 100,000 → GGDELU…).
- Claim ops: `ZVQ2RVZ5OG7H3VO6PQXDTJAVVRFMNI7ZZSAVULM5W3CR23VMNHPQ` (inner 150,000 → IRLM4C…).
- Operator payTo `UXWBBW…` holds 5,000 µUSDC (checked): the step-8 payments of runs 1, 2, 3, 5
  and 6 (run 4 stopped before paying). Not rekeyed. Part 2's reconcile records them as
  `unassigned` ops income.
- Next: R4 part 2 — the persistent TestNet deploy (`spm-test` domain, Compose, anchored review).

## 2026-09-24 — R4 part 2 started; guide for the next session
- Deployed (local machine, deployer DFEMIN…): PaymentRouter **772553842**, app address
  `EFYLTVK44STQW6U4ZAROCKXLFBZDAC34FDOEGDZBWRDF37WXUJDSF7PHZU`. Create
  `QE64Q6MM6NPSZTFJX7KVBO3LAOHFWOBMFJT2PCPAGOTVBMEDNS5A`, setCrediter
  `2UFCSJ727SLCDOLSR3TGRR5TNJ4AZWZ5XU65OBBHZVEXW6KRZ33A`, mapped `github:heavyfailry` and `ops`.
- Workaround used (fixed by R3e `f9bfe38`; now `( set -a; . ./.env; set +a; cd contracts &&
  pnpm run deploy:ci )` works): `cd contracts && ../proxy/node_modules/.bin/tsx --tsconfig
  tsconfig.json smart_contracts/index.ts` with `INDEXER_SERVER=$INDEXER_URL`. Bugs:
  `deploy:ci` has no `tsx`; `fromEnvironment()` ignores `INDEXER_URL`; a failed deploy exits 0.

### Part 2 guide. Where each step runs matters: cold keys never touch the server.

**A. Rekey `payTo` (local machine, repo root).**
1. Set `PAYMENT_ROUTER_APP_ID=772553842` in the local `.env`.
2. `! node scripts/rekey-payto.mjs PAY_TO_MNEMONIC --network testnet`
3. Check: the payTo account's `auth-addr` is the app address `EFYLTVK4…`.

**B. Anchor one real review (local machine, the auditor's key).**
1. Read the exact tarball of one small package version (for example `ms@2.1.3`). A human must
   read it (invariant 5).
2. Put the auditor mnemonic in a file with an editor, one line: `~/.spm/auditor-testnet.key`,
   then `chmod 600` it. The script refuses a looser file.
3. `node scripts/anchor-review.mjs ms 2.1.3 --reviewer heavyfailry --scope "<what you read,
   e.g. full source>" --key-file ~/.spm/auditor-testnet.key --network testnet`, type `yes`.
4. Check: the script prints the anchor txid. Keep it for C.

**C. Server `.env` and Compose (host, `/opt/spm` for TestNet).** The server `.env` holds only:
`NETWORK=testnet`, TestNet `ALGOD_SERVER`/`INDEXER_URL`, `PAY_TO_ADDRESS`,
`PAYMENT_ROUTER_APP_ID=772553842`, `CREDITER_MNEMONIC`, `ATTEST_SIGNING_KEY`,
`SPM_ISSUER_URL` (the TestNet URL), `SPM_KEY_VALID_FROM`, `AUDITORS`,
`SPM_BACKUP_HOST_DIR=/var/backups/spm`. Never the payTo, deployer, donor or auditor keys.
1. `docker compose up -d`. Check: `curl -s https://<test domain>/api/v1/status/ms/2.1.3`.
2. `docker compose run --rm spm node --import tsx/esm ../scripts/record-review.mjs <anchorTxid>
   --network testnet`, type `yes`. Check: status for `ms/2.1.3` is `COMMUNITY_REVIEWED`.

**D. One paid request (local machine, donor key).**
1. `( set -a; . ./.env; set +a; SPM_PROXY_URL=https://<test domain> pnpm -C cli start install
   ms 2.1.3 --donate )`
2. Check: it prints a settle txid; 1,000 µUSDC arrives at payTo.

**E. Nightly job (host).**
1. `cd /opt/spm && docker compose run --rm spm node --import tsx/esm src/claims/nightly-main.ts`
2. Check: log line `credited batch 1, txid …`. Expected batch: attributed 1,000 (auditor 400),
   unattributed 5,000 (the earlier step-8 deposits) → ops 5,600. A new `audit-*.db` is in
   `/var/backups/spm`.
3. Install `deploy/systemd/spm-nightly.{service,timer}`.

Gap for D1: TestNet and MainNet share one host. Each needs its own directory, Compose project
name, port, volume and nightly unit (the unit hardcodes `WorkingDirectory=/opt/spm`), and its own
`cloudflared` ingress rule.
- R3e `f9bfe38`: `deploy:ci` has `tsx` (4.22.4, exact); the client reads `INDEXER_URL` with
  network defaults from `scripts/network.mjs`; a failed deployer exits 1. 60 contract tests.
- Found: `pnpm audit` shows 47 advisories on `master` too (hono, @hono/node-server among them).
  Logged as S1 in TASK.md. R3e adds none.
- PR #24 open (not merged).

## 2026-09-25 — R4 part 2 PASS on TestNet (branch `spm-mvp-v6-wave5`)
- Rekey payTo → app 772553842: `JKW6NFYEYACVABWOO3WOGZTXMZLR333JJOIOW5RG4YHOZ7KTT5ZA`.
- Review anchor `ms@2.1.3`: `4ABHLGBLN54YZMYIHIOVVITWGBJ4RUIJLLBOKGNFBRWZF36OTD3A`; recorded,
  status `COMMUNITY_REVIEWED`.
- Paid install, 1,000 µUSDC: `GWASUA3SLCJISQM73X4QLM5YQRKU2BRXUCQD75C4A2BZSGR35C2Q`.
- Nightly credit, batch 1 (attributed 1,000, unattributed 5,000):
  `ZXPQTM6VOOI7A7URDOJP2MF4HLJDM6OX2UKKDITLHSX43DVCQ5CQ`. Boxes: auditor 400, ops 5,600.
- Guide fix: from WORKDIR `/app/proxy`, use `../scripts/record-review.mjs` and
  `src/claims/nightly-main.ts`.
- Next: S1, then D1. Before the MainNet deploy, move the TestNet deployment to its own host (M0).
- S1 `349de5c`: `@modelcontextprotocol/sdk` 1.30.1; exact `overrides` in `pnpm-workspace.yaml`.
  `pnpm audit --prod` is clean. One low dev advisory is left (`elliptic`, no patch).
- N2 `b971d8a`: `.github/workflows/image.yml` builds the image on a PR and pushes
  `ghcr.io/tripleight/spm:<tag>` on a `v*` tag. Set the package public after the first push.
- N1 `c4d07d4`: the proxy runs the nightly job at 03:17 UTC and catches up at start. SQLite lease
  and run history; `GET /api/v1/health` (503 after 26 h without success). `SPM_NIGHTLY`
  (default on; tests and e2e set off). `deploy/systemd/` is deleted. ADR 0009.
- N3 `61dbb8a`: `compose.yaml` pins `ghcr.io/tripleight/spm:v0.1.0` and keeps `build:`.
  `.env` and `stack.env` are both optional; `stack.env` is ignored by git and Docker.
- T1 logged: `index.test.ts` can leave a `node` child on a fixed port.
- T1 `c086ac2`: `index.test.ts` spawns `node --import tsx/esm` directly and uses free ports.
- D1 `e64157e`: both runbooks and the local deploy guide rewritten for PaymentRouter, the nightly
  job in the proxy, Portainer, the `v*` image release and M0. The README donor guide reads the
  key from a secret manager for one command. Remaining gaps are in the local guide, §5.

## 2026-09-25 — session end: wave 5 (R4 part 2, S1, N1–N3, T1, D1)
- Done: R4 `07ccce4`, S1 `349de5c`, N2 `b971d8a`, N1 `c4d07d4`, N3 `61dbb8a`, T1 `c086ac2`, D1 `e64157e`.
- Files: `proxy/src/claims/{scheduler,nightly-wiring,nightly,schema}.ts`, `proxy/src/routes/health.ts`,
  `compose.yaml`, `.github/workflows/image.yml`, `pnpm-workspace.yaml`, runbooks, SPEC §13.2, ADR 0009.
- State: TestNet app 772553842; payTo rekeyed; batch 1 credited (auditor 400, ops 5,600).
- `VERIFY: PASS`; `prek run --all-files` passes. `algokit project run build` ran clean (no diff).
- Blocked (human): tag `v0.1.0` and set the GHCR package public; M0 TestNet move; MainNet rekey.
- Next: merge the wave-5 PR, then tag `v0.1.0`.

## 2026-09-25 — hermetic test env
- `scripts/vitest-clear-env.mjs` clears every `.env.example` key before proxy, mcp and cli tests.
  A shell that exports `.env` no longer fails the git hooks.

## 2026-09-25 — wave 6: release and F1
- Release: tag `v0.1.1` (`2a963e0`), image run 36173399798 success. Anonymous pull works.
  Digest `sha256:348ec591889f72ccf294be315bcc3e045b85d2cb80a009564647c0e874d13f4b`.
- Tag `v0.1.0` deleted; its image run failed and GHCR has no `v0.1.0`.
- F1 `68ed80d`: `compose.yaml` and the MainNet runbook pin `v0.1.1`.

## 2026-09-26 — M0: TestNet moved
- TestNet now runs on its own host (rootless podman-compose). `audit.db` copied from the old host.
- Checks over the public origin: health 200 (`lastRun` success), `ms@2.1.3`
  `COMMUNITY_REVIEWED` (anchor `4ABHLGBLN54YZMYIHIOVVITWGBJ4RUIJLLBOKGNFBRWZF36OTD3A`),
  `spm-keys.json` 200.
- Decision: the TestNet host reuses the attestation key, so `SPM_KEY_VALID_FROM` keeps the key's
  first date. Only `SPM_ISSUER_URL` changed.
