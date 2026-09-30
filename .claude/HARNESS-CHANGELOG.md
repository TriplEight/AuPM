# Harness change log

Each entry states what changed, why it changed, and the expected effect.
Newest first.

---

## 2026-09-30 — Remove the dead MainNet runbook reference from `CLAUDE.md`

**`CLAUDE.md` operator procedures line.**
- What: replaced `docs/RUNBOOK-mainnet-launch.md` with `docs/DEPLOY-GUIDE.local.md`, and named
  the separate operator repo `aupm-mainnet` for the MainNet scripts and the deployment log.
- Why: `docs/RUNBOOK-mainnet-launch.md` never existed. The MainNet launch ran from the operator
  repo's scripts, `RUN.md` and `DEPLOYMENT.md`.
- Expected effect: an agent that looks for the MainNet procedure finds a file that exists.

---

## 2026-09-29 — Bring the `aupm-payment-router` skill up to date (audit L3)

**`.claude/skills/aupm-payment-router/SKILL.md` rewrite.**
- What: replaced the 40/60 split with 30/70 and the 40/10/20/15/10/5 target with
  30/10/20/25/10/5. Replaced `releaseAuthority` with `announceRelease`/`executeRelease`,
  including the execute window. Added the admin-trust warning (the delay does not limit
  `setIdentity`/`setCrediter`), the rekey-script build checks, batch splitting in the nightly
  job, and the unsandboxed Puya build. Added a rule: the source wins over this file.
- Why: the pre-MainNet audit found the skill described a superseded contract. An agent that
  followed it could reintroduce the old split or the old release method.
- Expected effect: agents that load the skill get the contract that ships on MainNet.

---

## 2026-09-21 — Align the harness with the MainNet design

**`CLAUDE.md` rewrite.**
- What: cut from 158 lines to about 100. Removed the `@AGENTS.md` import (211 lines of
  generic Algorand text). Removed the dependency-security block that `AGENTS.md` repeats.
  Added a numbered invariant list, a facts table, a command block, sandbox cautions, and
  orchestration rules.
- Why: every session loaded about 370 lines, and most of it did not apply to the task.
- Expected effect: a smaller fixed context per session. Facts appear in one place only.

**Skills.**
- What: rewrote `spm-split-contract` and `spm-testing`. Removed hackathon text from
  `spm-audit-status`.
- Why: `spm-split-contract` taught the deleted per-payment `pay()` split, which breaks
  invariant 2. `spm-testing` described LocalNet and TestNet gates that no longer exist.
- Expected effect: agents that load these skills get the current design.

**Subagents.**
- What: rewrote `algorand-contract-engineer`, `integration-tester`, `mcp-payer-engineer`
  and `scope-sentinel` for MainNet. Added a 15-line report format with a status first line
  and a BLOCKED rule to every implementing agent.
- Why: the old definitions said "12h hackathon", "TestNet", "hr8 sync" and `pay()`.
- Expected effect: short reports and no drift back to the TestNet design.

**Commands.**
- What: deleted `/demo`, `/deploy`, `/e2e` and `/seed`. Rewrote `/verify`.
- Why: `/seed` told an agent to create a `COMMUNITY_REVIEWED` row without a human
  review, which breaks invariant 5. The other three targeted TestNet and `DEMO.md`.
- Expected effect: no command runs a superseded flow.

**Other.**
- What: deleted `bootstrap.sh`. Added `.claude/worktrees/` to `.gitignore`.
- Why: `bootstrap.sh` overwrote the harness with the hackathon versions. Biome reads
  `.gitignore`, so an ignored worktree directory keeps `biome ci .` from linting it.
- Expected effect: no accidental harness rollback, and a clean lint during parallel work.

**Worktree base caution.**
- What: `CLAUDE.md` tells the orchestrator to put `git reset --hard <HEAD sha>` first in
  every worktree subagent prompt.
- Why: `isolation: worktree` checked out `master`. Two subagents first saw hackathon-era
  files and spent turns repairing their base.
- Expected effect: subagents start on the correct commit.

**Not changed (write-protected; needs a human).** `.claude/settings.json` sets
`USDC_ASA_ID=10458941` and a TestNet `ALGOD_SERVER` in every session's environment. It
also allows `npm:*` and `npx:*`, which conflicts with the pnpm-only rule.

---

## 2026-09-19 — Install `rtk` and document its use

**What.** Installed `rtk` v0.49.0 to `~/.local/bin/rtk`, pinned by `RTK_VERSION`.
Ran `rtk init`, which appended a marker-guarded block to `CLAUDE.md` and created
`.rtk/filters.toml`. Rewrote that block to describe explicit use, list the
subcommands that help this repository, and forbid verifying an acceptance check
against filtered output.

**Why.** `rtk` condenses verbose command output before it reaches the context
window. Diff review is the single largest recurring token cost in this workflow.

**Vetting.** The installer is the primary distribution path and runs as
`curl | sh`, which is the anti-pattern this project exists to fight. The script
was downloaded and read in full before execution. It verifies a SHA-256 checksum
against a published `checksums.txt` and refuses to install on mismatch, rejects
archive entries containing absolute paths or `..`, installs under `$HOME`
without sudo, and makes no telemetry call. CAUTION: repository metadata could
not be verified. The GitHub API is scope-gated in this environment and returned
403, so the star count shown on the project page is unconfirmed.

**Expected effect.** Measured on this repository: `git diff` output fell from
70,192 to 29,258 bytes, a 58% reduction. Small outputs pass through unchanged.

**Deliberate omission.** The global auto-hook (`rtk init -g`) is **not**
installed. It would filter every command in every session. This orchestrator
verifies subagent claims by reading raw command output, and filtered output
could hide a detail that a verification depends on.

---

## 2026-09-19 — Add Biome, an invariant guard, git hooks, and CI

**What.** Added `biome.json`, `scripts/guard.sh`, `.githooks/pre-commit`, and
`.github/workflows/ci.yml`. Set `core.hooksPath` to `.githooks`.

**Why.** The repository had no linter, no formatter, no pre-commit gate, and no
continuous integration. Several project invariants existed only as prose in
`CLAUDE.md`, so nothing detected a violation until a human read the diff.

**Design note.** `husky` and `lint-staged` were rejected. Both add postinstall
scripts, and `CLAUDE.md` blocks postinstall scripts. A plain `core.hooksPath`
needs no dependency at all.

**Expected effect.** The guard script turns seven prose invariants into exit
codes, including the deleted settlement bypass, the `algosdk.signBytes` trap,
float arithmetic on money, and committed secret material.

---

## 2026-09-19 — Repair stale agent and skill directives

**What.** Rewrote the non-negotiables in
`.claude/agents/x402-proxy-engineer.md` and most of
`.claude/skills/spm-x402-flow/SKILL.md`.

**Why.** Both still described the 12h hackathon design. The agent directive
required a direct-submit settlement fallback as "default-safe", named TestNet
constants, and named a single price tier. The skill described the obsolete
`[axfer, appcall pay(...)]` payment group.

**Observed failure this caused.** The proxy work item refused its task twice and
returned BLOCKED with zero file changes. It was correct to refuse: the task
contradicted its standing directive. The drift, not the agent, was the defect.

**Expected effect.** A proxy work item no longer receives contradictory
instructions, so it no longer stalls. The directive now forbids reintroducing a
direct-submit path, which is the security regression that matters most.

---

## 2026-09-19 — Rewrite project memory for MainNet, drop stale doc imports

**What.** Rewrote `CLAUDE.md`. Removed the `@docs/architecture.md`,
`@docs/scope-map.md`, `@docs/test-plan.md`, and `@docs/goals.md` imports. Added
an INVARIANTS section. Copied the v3 specification into the repository as
`SPEC-v3.md`.

**Why.** `CLAUDE.md` declared "Algorand TestNet only" and "do not add tracks",
both of which contradict the MainNet specification. The four imported documents
described the finished hackathon MVP and were injected into every subagent's
context on every run.

**Expected effect.** Two effects. Correctness: subagents stop receiving
instructions that contradict the specification. Cost: four stale documents no
longer load into every subagent context, which removes roughly 300 lines of
misleading text from every run.

**Note.** The specification is now a tracked file, so a subagent can read the
relevant section directly instead of having it pasted into its prompt.

## 2026-09-20 — Close the CI test-gate gap

**What.** Added `pnpm -C cli test` and
`node --test .github/actions/spm-attest/attest.test.mjs` to
`.github/workflows/ci.yml`. Rewrote the root `test` script in `package.json` to
run the same five suites.

**Why.** CI ran proxy, contracts and mcp only. The cli suite and the action
suite were unreachable from any gate. The action suite asserts that no wallet
credential reaches the network, so it is a security gate that nothing ran.

**Expected effect.** A regression in the cli or the action now fails CI. A local
`pnpm test` and a CI run now check the same set, so a passing local run no
longer hides a CI failure.

## 2026-09-22 — v6 harness sync and one task file

**What.** Updated the agents `x402-proxy-engineer`, `algorand-contract-engineer`,
`scope-sentinel` and `mcp-payer-engineer`, and the skills `spm-payment-router`,
`spm-audit-status`, `spm-x402-flow` and `spm-testing` to SPEC v6. Deleted
`docs/HANDOFF-next-session.md`. The untracked `docs/TASK-testnet-readiness.local.md`
became the tracked `docs/TASK.md`. `CLAUDE.md` now points at `docs/TASK.md` and lists
the correct worktree sync rule (`git merge --ff-only`, not `git reset --hard`).
Planned in `docs/TASK.md`: prek (H1), Claude Code hooks (H2), removal of five unused
Algorand skills (H3).

**Why.** Three agents still described SQLite-as-replaced, SplitRouter and
`distribute()`. `scope-sentinel` cited the wrong spec section. The handoff file
contradicted v5 (Variant A). The task file was invisible to the other developer
because `.git/info/exclude` ignored it. `CLAUDE.md` and the task file disagreed on
how a worktree syncs.

**Expected effect.** A subagent loads a description that matches the spec. There is
one "what next" document, and every developer sees it.

## 2026-09-22 — `/next` command and definition of done

**What.** Added `.claude/commands/next.md`. It holds the session protocol: scope, index-level
read, plan approval gate, one Sonnet subagent per item, acceptance against the definition of
done. `docs/TASK.md` § Done became § Definition of done, with per-item and per-session lists
and the two-fix-attempts escalation rule. Accepted items get `— DONE <sha>` on the heading.

**Why.** The user pasted a long orchestration prompt at the start of each session. Most of it
duplicated `CLAUDE.md`. The rest (plan gate, fix limit, per-item done criteria) lived nowhere.

**Expected effect.** A session starts with `/next` or `/next Q1 Q5`. Item status survives
across sessions in `docs/TASK.md`, so no item is done twice.

## 2026-09-22 — Claude Code hooks (H2) and unused skills removed (H3)

**What.** `.claude/settings.json` registers two hooks. `PreToolUse` on `Bash` runs
`.claude/hooks/bash-guard.sh`. It blocks a command that can print a `*_MNEMONIC` value
(a `$X_MNEMONIC` expansion, `printenv` or `env` with `MNEMONIC`, a `.env` read with
`MNEMONIC`), and a `git push` to `master` or `main` or while on `master`. `PostToolUse` on
`Edit|Write` runs `.claude/hooks/biome-format.sh`: `biome check --write` on JS, TS, JSON and
CSS files. It exits 2 with the Biome errors when a lint error remains. There is no `Stop`
hook. H3 removed the Python, frontend and ecosystem skills and their references.

**Why.** The mnemonic and push rules lived only in prose. Biome errors surfaced only at commit.
SPM uses TypeScript only, so the removed skills were noise in the skill list.

**Expected effect.** An agent cannot print a mnemonic or push to `master` by mistake. Edited
files arrive formatted. The guard matches text, not shell syntax: a command whose text contains
`git push origin master` or a `MNEMONIC` variable expansion is blocked, also inside quotes or a
heredoc. That is on purpose. Write such text with the Edit tool.

## 2026-09-29 — invariant 5 TestNet exception (ADR 0012)

**What.** `CLAUDE.md` invariant 5 gains a TestNet-only exception. An unread review uses the
normal anchor and `record-review.mjs` path, with a scope that starts with `unread`, on a server
with a TestNet issuer origin. `record-review.mjs` refuses an `unread` scope off TestNet.

**Why.** A TestNet rehearsal needs 15–30 reviewed packages. A human read of each one costs more
than the rehearsal needs. The operator chose the exception.

**Expected effect.** Agents may help seed unread reviews on TestNet through the normal path.
They still never write a review record in code, a fixture, or a seed script in the repo, and
never record an `unread` scope for MainNet.
