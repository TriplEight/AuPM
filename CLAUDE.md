# AuPM

AuPM is an npm-compatible registry overlay for the Global x402 Challenge on Algorand MainNet.
- Unreviewed packages pass through to npm for free.
- A human-reviewed package costs 1,000 µUSDC, paid by a donor through the GoPlausible
  facilitator. Clients donate only on opt-in (`--donate`, `allowDonation`, `donate: 'true'`),
  key `AUPM_DONOR_MNEMONIC`. Plain `npm install` stays free (ADR 0006).
- USDC accrues at one fixed `payTo`. It takes payments before it is rekeyed to `PaymentRouter`.
  A nightly job credits balances in numbered batches. The auditor and ops claim.
  Target split 30/10/20/25/10/5; MVP 30 auditor / 70 ops.
- `POST /v1/attest/lockfile` is the volume route: one signed attestation and one settlement per
  lockfile, 1,000 µUSDC per reviewed entry.

**Spec: `SPEC.md`.** Terms: `CONTEXT.md`. Decisions: `docs/adr/`.
Contract build procedure: `docs/RUNBOOK-contract-build.md`. `NOTES.md` is the public changelog.
Generic Algorand and AlgoKit guidance: `AGENTS.md` (read only when you need it).

## Invariants

WARNING: every change preserves these. A violation costs money or a false security claim.

1. `payTo` is the leaderboard key. It never changes after the first USDC arrives.
   `payTo` opts into USDC before the rekey to `PaymentRouter`. Never reverse this order.
2. Never split per payment. Never say "in the same transaction".
   Never call `credit()` permissionless.
3. `extra = { asset, feePayer, tag: "x402-global-challenge" }` on every paid route.
   `asset` is always explicit. An omitted asset can resolve to ALGO.
4. Unreviewed content never returns 402. A reviewed tarball returns 402 only with
   `X-AuPM-Donate: 1`. `X-AuPM-Donate: 0` on an attestation route gets a free partial
   attestation. Never withhold an `INTEGRITY_MISMATCH` or `UNRESOLVABLE` entry.
5. A `COMMUNITY_REVIEWED` record means a human read that exact tarball.
   Never create a review record in code, in a shipped fixture, or in a seed script.
   A review record needs a review anchor signed by that auditor's address.
   Exception, TestNet only (ADR 0012): an unread review goes through the same anchor and
   `record-review.mjs` path, with a scope that starts with `unread`, and a TestNet issuer origin.
6. The facilitator is mandatory. No local facilitator. No direct chain submission.
7. Money is integer micro-units. Never use floats. SQLite money columns are `INTEGER`.
8. Public texts show the target split and the MVP split. Never claim a share goes to a role
   that is not onboarded.

`bash scripts/guard.sh` enforces the invariants that grep can see.

## Canonical facts

| Fact | Value |
|---|---|
| Packages | `@x402-avm/{core,avm,hono,fetch,extensions}` at 2.6.1. Never `@x402/*`. |
| MainNet CAIP-2 | `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| USDC ASA | MainNet 31566704. TestNet 10458941 (rehearsal only). 6 decimals. |
| Facilitator | `https://facilitator.goplausible.xyz`. Client method `getSupported()`, not `supported()`. |
| Prices (microUSDC) | 1,000 per reviewed package on every route; lockfile 1,000 × reviewed entries, no cap, no discount; 0 reviewed = free |
| Split per 1,000 | Target 300 / 100 / 200 / 250 / 100 / 50. MVP: auditor 300, ops 700 |
| `claim()` floor | `MIN_CLAIM` 100,000 microUSDC; outer fee at least 2,000 microALGO |
| Store | SQLite, one writer (ADR 0001). Docker Compose, one service. Nightly off-host copy. |
| `credit()` | `credit(batchSeq, attributedTotal, unattributedTotal, entries)`, one call per batch (ADR 0005) |
| Review anchor | 0-ALGO self-payment by the auditor, ARC-2 note `aupm:j{...}` (ADR 0007). No `attest()` in the contract. |
| Attestations | DSSE + in-toto Statement v1, ed25519, unfunded service key. Never `algosdk.signBytes`. |
| Single attest | `GET /v1/attest?name=@babel/core&version=7.25.2` (query params; scoped names contain `/`) |

`feePayer` comes from `getSupported()` at boot. Never hardcode it.
The attribution tag applies at settlement and is not retroactive.

## Repo map

| Path | Content | Subagent |
|---|---|---|
| `contracts/` | `PaymentRouter` (Puya-TS) | `algorand-contract-engineer` |
| `proxy/` | Hono overlay, x402 routes, DSSE, SQLite status store, ledger, nightly job | `x402-proxy-engineer` |
| `mcp/`, `cli/` | MCP server and `aupm` CLI: `install`, `attest` (opt-in `--donate`), offline `verify` | `mcp-payer-engineer` |
| `.github/actions/aupm/` | CI Action: installs with npm, pnpm or yarn classic through AuPM, falls back to the public registry, donates on opt-in. An install failure fails the job, as with plain npm. An AuPM failure never fails the job: a registry failure falls back to npm, and a check or donation failure logs a warning. | — |
| `scripts/` | `verify.sh`, `guard.sh`, `e2e.mjs`. Nightly job: `pnpm -C proxy nightly` | `integration-tester` |

Skills: `aupm-x402-flow`, `aupm-audit-status`, `aupm-payment-router`, `aupm-testing`.
Algorand reference skills: `algorand-core`, `algorand-typescript`, `algorand-x402-typescript`,
`algokit-utils-ts`, `algorand-project-setup`.
Scope questions go to `scope-sentinel`. The out-of-scope list is `SPEC.md` §15.

## Commands

```bash
export PATH=$HOME/.local/share/pnpm/bin:$PATH   # pnpm is not on the default agent PATH
pnpm typecheck
pnpm -C proxy test      # also contracts, mcp, cli
bash scripts/verify.sh  # all checks; prints VERIFY: PASS
pnpm exec biome ci .    # zero warnings
prek run --all-files    # the pre-commit and pre-push hooks; CI runs this too
```

One-time setup per clone: `prek install --hook-type pre-commit --hook-type pre-push`.
If `git config core.hooksPath` prints a value, run `git config --unset core.hooksPath` first.

CAUTION: run proxy tests and `verify.sh` with the Bash sandbox disabled.
The sandbox blocks the unix sockets that the subprocess tests use.

CAUTION: contract tests run in JavaScript. They do not prove Puya compilation.
A human runs `algokit project run build` after a contract change.

Never weaken an assertion to make a check pass.

## Working rules

- pnpm only. Pin exact: `pnpm add --save-exact <pkg>@<version>`. Justify each new dependency.
- Run `pnpm audit --audit-level=moderate` after you add a dependency.
- Secrets live in `.env` (gitignored). Cold keys (`payTo`, deployer, admin, auditors) never
  touch the server. The server holds only the crediter key and the unfunded attestation key.
- Never log or hardcode a mnemonic or a private key.
- No AI attribution in code, comments, docs, or commits.
- After a unit of work, run `/handoff`.
  Add a short line to `NOTES.md` only for a merged change with a SHA or txid.
- Redirect long output to `$TMPDIR/<name>.log`. Read the exit code and the last 30 lines.
- Search before you read. Read line ranges, not whole files.

## Orchestration

- One work item per subagent. Give it the spec excerpt, the file list, and the acceptance checks.
- Parallel subagents each get their own worktree (`.claude/worktrees/`, gitignored).
  CAUTION: a new worktree starts from `master`, not from the current branch. `git reset --hard`
  is denied in a subagent. Sync a worktree with `git merge --ff-only <sha>`. A worktree cannot
  check out a commit that changes `.claude/settings.json`; start such agents from `master`.
- A subagent report is at most 15 lines. Line 1 is DONE, BLOCKED or FAILED.
- The orchestrator reruns every acceptance check before it accepts an item.
- If the spec is ambiguous or conflicts with the code, stop and ask. Never guess.
- Log harness changes in `.claude/HARNESS-CHANGELOG.md`: what, why, expected effect.

<!-- rtk-instructions v2 -->
## Command output

`rtk` (`~/.local/bin/rtk`) condenses verbose output: `rtk git diff`, `rtk vitest`,
`rtk tsc`, `rtk err <cmd>`, `rtk test <cmd>`, `rtk log <file>`.

CAUTION: run the raw command when you verify an exact value: a checksum, a signature,
a 402 header, or a test count. Never verify an acceptance check against filtered output.
<!-- /rtk-instructions -->
