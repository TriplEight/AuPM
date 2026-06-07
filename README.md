# SPM — Secure Package Manager

An **npm-compatible registry overlay** that funds human security review as a public good.
Unreviewed packages are free (same as npm). **Human-audited** packages cost a ~$0.001 USDC
**x402 micropayment** per download on **Algorand**, split on-chain in one **atomic transaction**
50/20/15/10/5 to **auditor / maintainer / adversarial-reviewer / treasury / ops**.

Built for the Algorand x402 hackathon. **Primary track: Agentic Commerce** — the hero path
is an MCP server an AI agent calls and pays for autonomously. Optional bonus: Quantoz EURD.

> Status: 12h MVP on Algorand **TestNet**. Scope is deliberately thin; see `SPEC.md`.

## How it works

```
agent / spm CLI ──install──▶ Hono proxy (audit-status lookup)
   ▲                              │
   │ 402 → sign USDC + appcall    │ status < COMMUNITY_REVIEWED → free passthrough to npm
   │                              │ status ≥ COMMUNITY_REVIEWED → 402 Payment Required
   └──── 200 + tarball ◀──────────┘ verify+settle → SplitRouter (AVM) → 5 inner transfers
```

`$0.001 = 1000 µUSDC` → split `500/200/150/100/50`. A version bump resets status to
UNREVIEWED (where supply-chain attacks inject). Full design in `SPEC.md` / `docs/`.

## Repo layout
- `contracts/` — AlgoKit TS, `SplitRouter` (pay / attest / setRecipients) + deploy scripts
- `proxy/` — Hono overlay: npm passthrough, SQLite audit-status store, x402 gate
- `mcp/` — MCP server: `check_audit_status` (free), `install_audited_package` (x402-gated)
- `cli/` — `spm` wrapper (human path)
- `docs/` — architecture, scope map, test plan, /goal conditions
- `CLAUDE.md`, `.claude/` — Claude Code config (subagents, skills, commands)

## Setup
Full steps in **`SETUP.md`**. Short version:

```bash
# prereqs: pipx install algokit ; npm i -g @anthropic-ai/claude-code ; Docker running
git clone <repo> && cd spm
bash bootstrap.sh                       # scaffolds CLAUDE.md, .claude/, docs/, scripts/
# load Algorand DevRel agent skills + .mcp.json (SETUP.md §2) — primes Claude Code for AVM/x402
# fund TestNet wallets: ALGO (Lora faucet) + USDC (Circle faucet). USDC ASA = 10458941
```

## Build (Claude Code, goal-driven)
This repo is built with Claude Code. Work is split across subagents and driven by
ready-to-paste `/goal` conditions in **`docs/goals.md`** (G1 contract → G5 tested demo).
Loop on LocalNet; reserve TestNet for the final pass.

```bash
claude            # then, e.g.:  /goal <paste G1 from docs/goals.md>
```

## Verify & demo
"Done" is a green command, not a vibe:

```bash
bash scripts/verify.sh                  # typecheck + unit + integration + LocalNet E2E
NETWORK=testnet bash scripts/demo.sh    # full demo path on TestNet + prints the Lora URL
```

Inside Claude Code: `/verify` and `/demo`. The live walkthrough (≈90s) is in **`DEMO.md`**:
free install → agent pays for an audited install → Lora shows 5 inner transfers → version-bump hook.

## Docs
`SPEC.md` (engineering spec) · `SETUP.md` (setup) · `PLAN.md` (12h two-dev plan) ·
`DEMO.md` (runbook) · `docs/scope-map.md` (glossary + vision→MVP map) ·
`docs/test-plan.md` · `docs/goals.md`.
