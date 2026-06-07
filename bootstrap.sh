#!/usr/bin/env bash
# SPM Claude Code bootstrap. Run from repo root: bash bootstrap.sh
# Idempotent-ish: overwrites the config files it owns. Does NOT touch AGENTS.md/.mcp.json
# (those come from algorand-agent-skills — see SETUP.md step 2).
set -euo pipefail

mkdir -p .claude/agents .claude/commands \
         .claude/skills/spm-split-contract \
         .claude/skills/spm-x402-flow \
         .claude/skills/spm-audit-status \
         .claude/skills/spm-testing \
         docs scripts

###############################################################################
# Root project memory
###############################################################################
cat > CLAUDE.md <<'EOF'
# SPM — Project Memory (Claude Code)

@AGENTS.md
@docs/architecture.md
@docs/scope-map.md
@docs/test-plan.md
@docs/goals.md

## What we are building (12h hackathon MVP)
An npm-compatible **registry overlay** where **human-audited** packages cost a
**~$0.001 USDC x402 micropayment per download on Algorand**, split on-chain
50/20/15/10/5 among auditor/maintainer/adversarial-reviewer/treasury/ops via
one **atomic group transaction**. Unreviewed packages are free.
**Primary track: Agentic Commerce.** The hero path is an MCP server an AI agent
calls and pays for autonomously.

## HARD CONSTRAINTS — do not violate
- 2 devs, ~12h, Algorand **TestNet only**, **TypeScript everywhere**.
- The demo MUST show: agent → 402 → autonomous USDC payment → 5 inner transfers
  visible on Lora → tarball installs.
- **Out of scope (do NOT build):** GPG keys, ARC-19 NFTs, Postgres/Redis (use
  SQLite), reputation scoring, adversarial-review UX, governance/DAO, CodeQL
  auto-scan, Dependabot/Renovate, multi-language, Stripe pre-funding.
- Do NOT add tracks beyond Agentic Commerce (+ optional Quantoz EURD bonus).
- When unsure whether something is in scope, ask the `scope-sentinel` subagent.

## Canonical facts (verified — use these literally)
- x402 packages are scoped **`@x402-avm/*`** (core, avm, express, axios,
  extensions). NOT `@x402/avm`.
- Network ids are CAIP-2: import `ALGORAND_TESTNET_CAIP2` from `@x402-avm/avm`.
- TestNet USDC ASA id = **10458941** (`USDC_TESTNET_ASA_ID`), 6 decimals.
- x402 scheme = `"exact"`. Amounts are micro-units strings. $0.001 = "1000".
- Split of 1000 µUSDC = 500/200/150/100/50 (auditor/maintainer/adversarial/treasury/ops).
  CANONICAL split is **50/20/15/10/5**. The source doc also shows a stale **70/20/10**
  three-way split — that is OBSOLETE; always use the five-way 50/20/15/10/5.
- Contract = Algorand TypeScript (Puya-TS) via AlgoKit; LocalNet then TestNet.
- Adoption mechanic ("no migration") = point npm at the proxy: `.npmrc` `registry=<proxy>`
  or `npm install --registry <proxy>`. The proxy is the overlay; npm is unchanged.
- A package gets PAID status only via an on-chain `attest()`; SQLite mirrors it. See the
  audit lifecycle in docs/scope-map.md. For the demo we seed both (DB row + attest box).

## Repo map
- `contracts/` AlgoKit TS — `SplitRouter` (pay/attest/setRecipients) + scripts.
- `proxy/`     Hono overlay: npm passthrough, SQLite status store, x402 gate.
- `mcp/`       MCP server: `check_audit_status`, `install_audited_package`.
- `cli/`       `spm` wrapper (secondary human path).

## Conventions
- Money is always integer micro-units. Never use floats for amounts.
- Every payment-path change must keep the free tier free (status < COMMUNITY_REVIEWED).
- After finishing a unit of work, append a dated entry to `NOTES.md` (use /handoff).
- Prefer the relevant SPM skill (spm-split-contract / spm-x402-flow /
  spm-audit-status / spm-testing) and the Algorand DevRel skills before writing code.
- Pin dep versions on install; avoid API drift.

## Verification (this is how "done" is judged — read before goal mode)
- Single source of truth for "working": **`bash scripts/verify.sh` exits 0** and prints
  every check `PASS`. It runs typecheck + unit + integration + a LocalNet E2E.
- **`bash scripts/demo.sh` exits 0** runs the documented demo path end-to-end against the
  configured network and prints the Lora URL. The demo is not "done" until this is green.
- Test/loop on **LocalNet** (instant, deterministic). Reserve **TestNet** for the final
  E2E pass + the live stage demo — never run goal loops against TestNet.
- See docs/test-plan.md for the full matrix and docs/goals.md for ready-to-paste /goal
  conditions. A goal condition must be something a command's transcript output proves.

## Skills available
- spm-split-contract — SplitRouter math + atomic inner-txn pattern.
- spm-x402-flow      — 402 round-trip with @x402-avm + correct ids.
- spm-audit-status   — status tiers, auto-reset rule, SQLite schema, /api contract.
- spm-testing        — test stack, LocalNet fixtures, how to assert the 5-way split, harness.
- (Algorand DevRel skills, copied into .claude/skills/ — AVM/x402/AlgoKit knowledge.)
EOF

###############################################################################
# Imported architecture memory
###############################################################################
cat > docs/architecture.md <<'EOF'
# SPM Architecture (imported into project memory)

Flow: agent/CLI → Hono proxy. Proxy looks up audit status in SQLite.
- status < COMMUNITY_REVIEWED → transparent passthrough to registry.npmjs.org (FREE).
- status >= COMMUNITY_REVIEWED → 402 with x402 PaymentRequirements (exact/USDC/Algorand).
Client builds an ATOMIC GROUP: [USDC AssetTransfer -> app addr] + [appcall pay(pkg,ver)],
signs, sends X-PAYMENT header on retry. Proxy verifies+settles (GoPlausible facilitator,
or direct algosdk submit as fallback), waits confirmation, returns 200 + tarball +
X-AUDIT-ATTESTATION.

SplitRouter (ARC-4 app):
- pay(payment, pkg, ver): assert asset/receiver/amount; emit 5 inner axfers
  500/200/150/100/50 µUSDC; log pkg@ver + sender.
- attest(pkg, ver, status): sender-gated; write box attest:<pkg>@<ver>.
- setRecipients(...): admin bootstrap (5 addresses + asset id).

Pre-demo: app account + all 5 recipients opt into USDC ASA (10458941). Automated in
contracts/scripts/setup.ts. EURD bonus = same contract with a second ASA + opt-ins.

Status tiers (subset): UNREVIEWED(default,free) → AUTO_SCANNED(free) →
COMMUNITY_REVIEWED(paid) → PEER_REVIEWED(paid). Version bump auto-resets to UNREVIEWED.

API: GET /api/v1/status/:pkg/:version → { status, auditor_addr, attest_txid, ts }.

Adoption ("no migration"): consumers point npm at the proxy via `.npmrc`
`registry=<proxy-url>` or `npm install --registry <proxy-url>`. Packages resolve through
the overlay; free-tier installs are byte-identical to npm. The MCP/CLI just target the
proxy URL. For the demo the proxy is localhost.

Audit lifecycle and how on-chain attest() relates to the SQLite row: see
docs/scope-map.md ("Audit lifecycle"). Short version: attest() writes the box (source of
truth); the proxy mirrors status into SQLite for hot-path reads; install reads SQLite.
EOF

###############################################################################
# Vision -> MVP map, glossary, audit lifecycle (imported into project memory)
###############################################################################
cat > docs/scope-map.md <<'EOF'
# SPM scope map, glossary & lifecycle (imported into project memory)

## One-paragraph why (so micro-decisions land right)
npm has no identity, no security review, no accountability — supply-chain attacks
(Axios, xz, Lazarus) are cheap to run. Meanwhile OSS maintainers are unfunded because
usage no longer drives engagement/donations. SPM funds *human* security review as a
public good: audited packages cost a tiny usage-triggered micropayment, split on-chain
to the people who did the work. The hackathon proves ONE mechanic end-to-end: an agent
autonomously pays an x402 micropayment to install an audited package, and five parties
get paid in one atomic transaction.

## Glossary
- **Overlay / proxy** — an npm-compatible registry in front of npmjs. Adopt by pointing
  npm at it (`registry=`); no migration, packages resolve normally.
- **Audit status** — machine-readable, per-version flag on a package (see tiers below).
- **Auditor** — a human (identified by an Algorand address) who signs an attestation that
  a specific package version was reviewed. Earns 50% of that version's micropayments.
- **Adversarial reviewer** — secondary reviewer who finds flaws in existing audits. Earns
  15%. (MVP: just a recipient slot; no review UX is built.)
- **Maintainer** — the package author; earns 20% for keeping code auditable. (MVP: a
  recipient slot.)
- **Attestation** — the signed record that an audit happened. On-chain in MVP = a box
  entry on SplitRouter keyed `attest:<pkg>@<ver>`. (Full vision = ARC-19 NFT — deferred.)
- **x402** — HTTP 402 payment protocol; server returns payment requirements, client pays,
  retries with a payment header. On Algorand via `@x402-avm/*`.
- **SplitRouter** — our AVM app: receives the USDC payment, fans it out 50/20/15/10/5.

## Audit status tiers (MVP subset)
UNREVIEWED (default, FREE) -> AUTO_SCANNED (FREE) -> COMMUNITY_REVIEWED (PAID) ->
PEER_REVIEWED (PAID). Skipped for MVP: MISSION_CRITICAL_SAFE, CVE_KNOWN:[id].
Payment triggers at COMMUNITY_REVIEWED and above. Everything below is free.

## Audit lifecycle (THE thing that was under-specified — build to this)
1. **Publish / unknown version** -> status defaults to `UNREVIEWED` (free). The proxy
   synthesizes UNREVIEWED for any version it has no row for (auto-reset rule).
2. **Auditor reviews** -> calls `attest(pkg, ver, status)` on SplitRouter. The contract
   asserts the sender is a registered auditor and writes box `attest:<pkg>@<ver>` =
   {auditor, txid, status, ts}.
3. **Proxy syncs** -> on attest (or via a small sync/seed step) the proxy upserts the
   SQLite `audit_status` row to `COMMUNITY_REVIEWED` with auditor_addr + attest_txid.
   SQLite is the hot-path read; the box is the source-of-truth attestation.
4. **Install** -> proxy reads SQLite. >= COMMUNITY_REVIEWED => 402 => payment => 200 +
   `X-AUDIT-ATTESTATION` (the box value / attest txid).
5. **Version bump** -> new version has no row -> back to UNREVIEWED -> new review needed.
   (Narrative: that gap is exactly where supply-chain attacks inject.)

**Demo shortcut:** seed step 1-3 directly — insert the SQLite row AND (optionally) write
the attest box — so the install in step 4 is the live, paid, on-chain moment on stage.
Showing a live `attest()` -> status flip is a strong *optional* extra (MCP `submit_audit`
tool or `spm audit`), but the required demo is the paid install + 5-way split.

## Auditor identity (MVP — concrete)
No GPG, no reputation scoring in MVP. Identity = an **Algorand address registered as an
auditor**. Simplest sufficient mechanism: an `authorizedAuditor` (or a small set) stored
in SplitRouter global state at deploy; `attest()` asserts `Txn.sender == authorizedAuditor`.
The seeded demo auditor's address is one of the 5 recipients (the auditor slot). Sybil
resistance (1 wallet per reviewer, stake-weighted reputation) is the full-vision story —
deferred; state it in the pitch, do not build it.

## Full vision -> MVP substitute (do NOT rebuild the left column)
| Full SPM | MVP build | Why |
|---|---|---|
| PostgreSQL + Drizzle + Redis | SQLite single table | 12h; status store is tiny |
| ARC-19 NFT attestation | SplitRouter box entry | NFT minting is scope; box proves the point |
| GPG + Algorand wallet identity | Algorand address only, sender-gated attest | identity that pays = identity that signs |
| On-chain auditor registry + reputation | 1 authorizedAuditor in global state | enough to gate attest() and route the 50% |
| Bounty subsidy pool (treasury auto-disburse) | treasury is just a recipient slot | no disbursement logic in 12h |
| CodeQL/OSV AUTO_SCANNED tier | tier exists in enum; no scanner wired | scanning is its own project |
| GitHub Action / Dependabot / Renovate | none | not on the demo path |
| Stripe enterprise pre-funding | none | agent pays directly from a funded wallet |
| Multi-language registries | npm/JS only | one ecosystem proves the overlay |
| `spm register` / `spm audit` CLI | optional; install + status are required | seed covers status for the demo |
| 70/20/10 split (stale doc variant) | **50/20/15/10/5** | five-way is canonical |
| ~$0.01 (old figure) | **$0.001 = 1000 µUSDC** | matches current doc + x402-avm units |

## Bonus track (conditional)
Quantoz EURD: same SplitRouter with a second ASA + recipient opt-ins + a EURD-priced
route (`@ever_amsterdam/x402-euro-eurd` patterns). Only if S4 is green and it's <=30 min.
EOF

###############################################################################
# Test plan (imported into project memory)
###############################################################################
cat > docs/test-plan.md <<'EOF'
# SPM test plan (imported into project memory)

Goal-mode judges "done" by command output in the transcript. Every component below
has tests that a single harness runs. Loop on LocalNet; TestNet only for the final pass.

## Stack
- Contract: vitest + @algorandfoundation/algokit-utils against AlgoKit LocalNet.
- Proxy: vitest + Hono's built-in test client (`app.request(...)`). SQLite in a temp file.
- MCP/CLI: vitest; drive the MCP tools against a local proxy + LocalNet app.
- E2E/demo: `scripts/e2e.mjs` (node, tsx-runnable) driving the real flow + on-chain asserts.

## Required npm scripts (wire in root package.json)
- `test`       -> run all workspace vitest suites (unit + integration).
- `typecheck`  -> `tsc -b` (or per-package `tsc --noEmit`).
- (Optional) `lint`.
`scripts/verify.sh` calls these + a LocalNet E2E. `scripts/demo.sh` runs E2E on $NETWORK.

## Unit tests
### contracts/ (SplitRouter)
- split-sum: a pay() of UNIT (1000) emits exactly 5 inner axfers 500/200/150/100/50 to the
  5 configured recipients; their sum == UNIT.
- reject wrong-asset: pay() with a non-ASSET_ID axfer fails.
- reject wrong-amount: pay() with amount != UNIT fails.
- reject wrong-receiver: payment not addressed to the app fails.
- attest-auth: attest() from a non-authorizedAuditor fails; from authorizedAuditor writes
  box `attest:<pkg>@<ver>` with the expected fields.
### proxy/
- free passthrough: GET an UNREVIEWED package -> 200 + tarball, no 402, no wallet.
- paid gate: GET a COMMUNITY_REVIEWED package -> 402 with PaymentRequirements
  (scheme "exact", asset "10458941", payTo app addr, maxAmountRequired "1000").
- status API: GET /api/v1/status/:pkg/:version returns the row shape; unknown -> UNREVIEWED.
- auto-reset: a version with no row resolves to UNREVIEWED.
### mcp/ + cli/
- check_audit_status returns status without payment.
- install_audited_package on a 402 builds an atomic group [USDC axfer->app]+[appcall pay]
  with correct asset/amount/args (assert the constructed group, signed locally).

## Integration / system tests (LocalNet)
- proxy <-> contract: a real pay() group submitted via the proxy settles; proxy confirms
  the 5 inner txns before returning 200.
- mcp <-> proxy <-> contract: install_audited_package end-to-end returns tarball +
  X-AUDIT-ATTESTATION; balances of the 5 recipients increased by 500/200/150/100/50.
- attest -> status flip: attest() then GET status shows COMMUNITY_REVIEWED + attest_txid.

## E2E (scripts/e2e.mjs) — the goal/demo gate
Runs against --network localnet (default for loops) or testnet (final/demo). Asserts:
1. Free install of an UNREVIEWED package succeeds with zero payment.
2. install_audited_package on the seeded COMMUNITY_REVIEWED package returns a tarball.
3. The settlement group on-chain has exactly 5 inner axfers 500/200/150/100/50 to the 5
   recipients (read via algosdk/indexer). Print the group txid + Lora URL.
4. GET /api/v1/status returns COMMUNITY_REVIEWED + attest_txid.
5. Version bump -> status resolves to UNREVIEWED.
Exit 0 only if all pass; print `E2E: PASS` / `E2E: FAIL <reason>`.

## Definition of done (per sync point)
- S2: `npm test` green for contracts split/reject/attest + proxy gate tests (LocalNet).
- S3: contract on TestNet; integration tests green on LocalNet; MCP builds the real group.
- S4: `bash scripts/verify.sh` exits 0 AND `bash scripts/demo.sh` exits 0 on TestNet.
EOF

###############################################################################
# Ready-to-paste /goal conditions (imported into project memory)
###############################################################################
cat > docs/goals.md <<'EOF'
# /goal conditions for SPM (Claude Code v2.1.139+)

How to use: enable auto mode (so each turn runs unattended), trust the workspace, then
paste ONE condition with `/goal <condition>`. The evaluator only sees what's in the
transcript, so each condition names a command whose output proves it. Each ends with a
turn bound. Run the right subagent first (it scopes files + skills).

Loop on LocalNet. Do not point a goal loop at TestNet.

## G1 — SplitRouter (algorand-contract-engineer)
/goal `npm -w contracts test` exits 0 with the split-sum, reject-wrong-asset,
reject-wrong-amount, reject-wrong-receiver, and attest-auth tests all passing on LocalNet;
inner amounts are exactly 500/200/150/100/50 µUSDC; do not modify proxy/ mcp/ cli/;
stop after 25 turns.

## G2 — Proxy + x402 gate (x402-proxy-engineer)
/goal `npm -w proxy test` exits 0 with free-passthrough, paid-402, status-API, and
auto-reset tests passing; the 402 uses scheme "exact", asset "10458941", and amount
"1000"; the free tier never returns 402; do not modify contracts/; stop after 25 turns.

## G3 — MCP hero path (mcp-payer-engineer)
/goal `npm -w mcp test` exits 0 proving check_audit_status needs no payment and
install_audited_package builds a correct atomic group [USDC axfer->app]+[appcall pay];
do not change the split or the contract ABI; stop after 20 turns.

## G4 — Full system on LocalNet (integration-tester)
/goal `bash scripts/verify.sh` exits 0 and its output shows every check PASS, including
the LocalNet E2E asserting 5 inner transfers 500/200/150/100/50 to the 5 recipients;
do not weaken any assertion to make it pass; stop after 30 turns.

## G5 — Tested demo on TestNet (integration-tester)
/goal `NETWORK=testnet bash scripts/demo.sh` exits 0, prints `DEMO: PASS`, and prints a
Lora URL for the settlement group showing the 5 inner transfers; the free-install step
completes with no payment; do not mock the chain; stop after 20 turns.

## Tips
- If a goal stalls, run `/goal` (no arg) to read the evaluator's last reason, fix scope.
- Keep conditions to one measurable end state + the check command + constraints + bound.
EOF

###############################################################################
# Settings
###############################################################################
cat > .claude/settings.json <<'EOF'
{
  "permissions": {
    "allow": [
      "Bash(algokit:*)",
      "Bash(npm:*)",
      "Bash(npx:*)",
      "Bash(node:*)",
      "Bash(tsx:*)",
      "Bash(git:*)",
      "Bash(curl:*)",
      "Bash(sqlite3:*)",
      "Read",
      "Write",
      "Edit",
      "Grep",
      "Glob"
    ],
    "deny": [
      "Bash(rm -rf /*)",
      "Bash(git push --force:*)"
    ]
  },
  "enableAllProjectMcpServers": true,
  "env": {
    "USDC_ASA_ID": "10458941",
    "ALGOD_SERVER": "https://testnet-api.algonode.cloud"
  }
}
EOF

###############################################################################
# Subagents
###############################################################################
cat > .claude/agents/algorand-contract-engineer.md <<'EOF'
---
name: algorand-contract-engineer
description: >
  Use for ALL Algorand AVM smart-contract work: writing/editing/testing the
  SplitRouter contract, atomic group + inner transactions, ARC-4 ABI methods,
  box storage, ASA opt-ins, AlgoKit LocalNet/TestNet deploy and typed clients.
  Owns contracts/. Invoke proactively whenever the task touches TEAL/Puya-TS,
  algosdk transaction construction on the contract side, or deployment scripts.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
---
You are the contract engineer for SPM (track: Agentic Commerce, Algorand TestNet).

Authoritative knowledge: load the `spm-split-contract` skill and the Algorand
DevRel skills before writing code. Use Algorand TypeScript (Puya-TS) via AlgoKit.

Non-negotiables:
- Amounts are integer micro-units. $0.001 USDC = 1000 µUSDC. Split = 500/200/150/100/50.
  Add a unit test asserting the five inner amounts sum to the received payment.
- pay(payment, pkg, ver) MUST assert: payment.xferAsset == ASSET_ID,
  payment.assetReceiver == app address, payment.assetAmount == UNIT. Reject otherwise.
- ASSET_ID is configurable via setRecipients so the same contract serves USDC or EURD.
- attest() is sender-gated and writes box attest:<pkg>@<ver>.
- Provide contracts/scripts/setup.ts that deploys, sets recipients, and opts the app
  + all 5 recipient accounts into the USDC ASA (10458941). Opt-ins must be automated.
- Build on LocalNet, then deploy to TestNet. Print APP_ID + APP_ADDRESS for the .env.
Hand off APP_ID, APP_ADDRESS and the ABI to x402-proxy-engineer at the hr8 sync.
Keep everything in scope (see CLAUDE.md). If asked for ARC-19/reputation/governance, decline and note it's post-hackathon.
EOF

cat > .claude/agents/x402-proxy-engineer.md <<'EOF'
---
name: x402-proxy-engineer
description: >
  Use for the Hono registry overlay: transparent npm passthrough, SQLite audit-
  status store, the /api/v1/status endpoint, and the x402 402-gate / verify /
  settle path using @x402-avm/*. Owns proxy/. Invoke for any HTTP, header,
  facilitator, or audit-status-lookup work on the server side.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
---
You are the proxy engineer for SPM.

Authoritative knowledge: load `spm-x402-flow` and `spm-audit-status` skills first.

Non-negotiables:
- Use scoped packages @x402-avm/core, @x402-avm/avm (NOT @x402/avm). Import
  ALGORAND_TESTNET_CAIP2 and USDC_TESTNET_ASA_ID ("10458941") from @x402-avm/avm.
- scheme = "exact"; price for paid tier = "1000" µUSDC; maxTimeoutSeconds 60.
- FREE TIER IS SACRED: status < COMMUNITY_REVIEWED => passthrough to
  registry.npmjs.org with no payment, no wallet. Never gate the free tier.
- Settlement path A: GoPlausible facilitator via HTTPFacilitatorClient +
  registerExactAvmScheme. Path B fallback: submit signed group with algosdk +
  waitForConfirmation when FACILITATOR_URL is blank. Implement A behind a flag, B as default-safe.
- Verify the on-chain split actually happened (read the pay() log / inner txns) before 200.
- Storage is SQLite only. Implement the auto-reset rule (new version => UNREVIEWED).
Consume APP_ID/APP_ADDRESS/ABI from algorand-contract-engineer. Stay in scope.
EOF

cat > .claude/agents/mcp-payer-engineer.md <<'EOF'
---
name: mcp-payer-engineer
description: >
  Use for the agentic-commerce hero path: the MCP server exposing
  check_audit_status (free) and install_audited_package (x402-gated, pays
  autonomously), plus the spm CLI wrapper. Owns mcp/ and cli/. Invoke for any
  agent-side payment construction, MCP tool schema, or CLI 402->pay->retry work.
tools: Read, Write, Edit, Bash, Grep, Glob
model: sonnet
---
You are the agent/MCP engineer for SPM. This is the primary-track surface — make it crisp.

Authoritative knowledge: load `spm-x402-flow` first.

Build:
- An MCP server (stdio) with two tools:
  * check_audit_status({pkg, version}) -> status JSON. FREE. No payment.
  * install_audited_package({pkg, version}) -> on 402, build the atomic group
    [USDC axfer -> app] + [appcall pay(pkg,ver)] with @x402-avm/avm + algosdk,
    sign with PAYER_MNEMONIC, retry with X-PAYMENT, return tarball path +
    attestation txid. The AGENT pays without human steps — that is the demo.
- A `spm` CLI mirroring the same flow for the human path (spm install / status).

Non-negotiables: micro-unit integers only; correct @x402-avm/* package names;
surface the settlement txid so the demo can open it in Lora. Stay in scope.
EOF

cat > .claude/agents/integration-tester.md <<'EOF'
---
name: integration-tester
description: >
  Use to run and verify the end-to-end flow on TestNet without modifying source:
  start proxy, drive the MCP/CLI, confirm 402 -> payment -> 5 inner transfers ->
  tarball, and fetch the txn on Lora. Invoke at sync points hr3/hr8/hr10 and
  before the demo. Read/run only — does not edit application code.
tools: Read, Bash, Grep, Glob
model: sonnet
---
You are the E2E verifier for SPM. You do not write application code; you run the harness,
report, and (only) author/fix the verification scripts and tests.

Primary tools: `bash scripts/verify.sh` (LocalNet, the G4 gate) and
`NETWORK=testnet bash scripts/demo.sh` (the G5 demo gate). Keep both green.

Checklist each run (mirrors scripts/e2e.mjs):
1. Free path: install an UNREVIEWED package — must succeed with zero payment.
2. Paid path: install a COMMUNITY_REVIEWED package via the MCP tool — must 402,
   pay, and return a settlement txid.
3. On-chain: confirm the group txn has exactly 5 inner axfers of 500/200/150/100/50
   µUSDC to the 5 recipients (algosdk/indexer); provide the Lora URL.
4. API: GET /api/v1/status/:pkg/:version returns the expected status + attest txid.
5. Auto-reset: bump version, confirm status flips to UNREVIEWED.
Report failures with the exact failing assertion and suspected owner subagent. Never
weaken an assertion to pass. Produce a one-paragraph go/no-go for the demo.
EOF

cat > .claude/agents/scope-sentinel.md <<'EOF'
---
name: scope-sentinel
description: >
  Read-only guard against scope creep and spec drift in a 12h hackathon. Invoke
  before starting any sizable new piece of work, or when a request smells like
  out-of-scope (ARC-19, Postgres, reputation, governance, extra tracks). Flags
  risk, does not implement.
tools: Read, Grep, Glob
model: sonnet
---
You enforce the SPM hackathon scope defined in CLAUDE.md. You never write code.

When consulted, answer three things tersely:
1. In scope or out? (cite the CLAUDE.md "Out of scope" list if out.)
2. Does it threaten the demo thesis (agent -> 402 -> 5-way on-chain split -> install)?
3. Cheapest path that still demos the point, or a clean "cut it" recommendation.
Also catch correctness traps: wrong package name (@x402/avm vs @x402-avm/*),
float money, split not summing to the payment, gating the free tier, mainnet usage.
Bias hard toward shipping the thesis over completeness.
EOF

###############################################################################
# Slash commands
###############################################################################
cat > .claude/commands/seed.md <<'EOF'
---
description: Seed the SQLite audit_status table with demo packages
argument-hint: "[optional package@version to add as COMMUNITY_REVIEWED]"
allowed-tools: Read, Write, Edit, Bash
---
Seed proxy/ SQLite `audit_status` for the demo:
- one COMMUNITY_REVIEWED package (paid path) — use $ARGUMENTS if given, else a pinned lodash version
- one or two UNREVIEWED packages (free path)
Set auditor_addr to the deployed auditor recipient and, if SPLIT_APP_ID is set, also call
attest(pkg, ver, COMMUNITY_REVIEWED) so the on-chain box matches the DB (full-loop demo).
Then print the rows so we can confirm the two-branch demo story.
EOF

cat > .claude/commands/deploy.md <<'EOF'
---
description: Compile + deploy SplitRouter to TestNet and opt-in all recipients
allowed-tools: Read, Write, Edit, Bash
---
Use the algorand-contract-engineer subagent to:
1. Build SplitRouter on LocalNet, run the split-sum unit test.
2. Deploy to TestNet via contracts/scripts/setup.ts.
3. setRecipients(...) and opt the app + 5 recipients into USDC ASA 10458941.
4. Print APP_ID and APP_ADDRESS and write them into .env.
EOF

cat > .claude/commands/e2e.md <<'EOF'
---
description: Run the full agent -> 402 -> pay -> split -> install end-to-end check
allowed-tools: Read, Bash, Grep, Glob
---
Use the integration-tester subagent to run its full checklist against TestNet and
return a go/no-go for the demo, including the Lora URL for the settlement txn.
EOF

cat > .claude/commands/handoff.md <<'EOF'
---
description: Append a dated handoff entry to NOTES.md for the other dev
argument-hint: "[short summary of what you just finished]"
allowed-tools: Read, Edit, Bash
---
Append a timestamped entry to NOTES.md with: what changed ($ARGUMENTS), files
touched, current APP_ID/state if relevant, what's blocked, and the single next
action for whoever picks this up. Keep it under 8 lines.
EOF

cat > .claude/commands/verify.md <<'EOF'
---
description: Run the full verification harness (typecheck + unit + integration + LocalNet E2E)
allowed-tools: Read, Bash, Grep, Glob
---
Run `bash scripts/verify.sh` and show the full output. Report which checks PASS/FAIL and
the exit code. If anything FAILs, summarize the first failing check and the likely owner
subagent. Do not modify tests to make them pass. This is the G4 completion signal.
EOF

cat > .claude/commands/demo.md <<'EOF'
---
description: Run the documented, tested demo path end-to-end and print the Lora URL
argument-hint: "[network: localnet|testnet, default testnet]"
allowed-tools: Read, Bash, Grep, Glob
---
Run `NETWORK=${ARGUMENTS:-testnet} bash scripts/demo.sh`, show the output, and confirm it
printed `DEMO: PASS` plus a Lora URL for the settlement group with 5 inner transfers.
Then echo the demo runbook steps from DEMO.md so the operator can follow along live.
EOF

###############################################################################
# SPM skills
###############################################################################
cat > .claude/skills/spm-split-contract/SKILL.md <<'EOF'
---
name: spm-split-contract
description: >
  How to build the SPM SplitRouter AVM contract — the atomic 5-way revenue
  split. Use when writing or editing the contract, its inner transactions,
  ABI methods, box attestation, or the deploy/opt-in script.
---
# SplitRouter

ARC-4 app (Algorand TypeScript / Puya-TS). Receives a USDC AssetTransfer grouped
immediately before the app call, then fans out via inner transactions.

## Unit
$0.001 USDC, 6 decimals => UNIT = 1000 µUSDC.
Split: auditor 500, maintainer 200, adversarial 150, treasury 100, ops 50. Sum = 1000.
If you later parametrize the amount, give treasury the integer remainder.

## ABI
- setRecipients(auditor, maintainer, adversarial, treasury, ops, assetId): admin only.
  Store the 5 addresses + ASSET_ID in global state. (assetId param enables USDC or EURD.)
  Also store `authorizedAuditor` (MVP: the auditor recipient address) for attest() gating.
- pay(payment: gtxn.AssetTransferTxn, pkg: string, ver: string):
  assert payment.xferAsset == ASSET_ID
  assert payment.assetReceiver == Global.currentApplicationAddress
  assert payment.assetAmount == UNIT
  issue 5 inner AssetTransfer txns of 500/200/150/100/50 to the stored recipients
  log(concat(pkg, "@", ver, " ", payment.sender))   // proxy reads to confirm
- attest(pkg: string, ver: string, status: uint64):
  assert Txn.sender == authorizedAuditor   // MVP identity: registered Algorand address
  write box "attest:"+pkg+"@"+ver = pack(sender, Txn.txId, status, Global.latestTimestamp).

## Opt-ins (critical)
The app account AND all 5 recipient accounts must opt into ASSET_ID before any pay().
Do this in contracts/scripts/setup.ts, automated, before the demo. For EURD bonus,
opt the same accounts into the EURD ASA too and call setRecipients with that assetId.

## Tests
- split-sum: inner amounts sum to UNIT.
- reject wrong asset / wrong amount / wrong receiver.
Build LocalNet first; only then TestNet. Print APP_ID + APP_ADDRESS.
EOF

cat > .claude/skills/spm-x402-flow/SKILL.md <<'EOF'
---
name: spm-x402-flow
description: >
  How SPM does the x402 402->pay->retry round-trip on Algorand with the
  @x402-avm packages. Use for the proxy gate, the MCP/CLI payer, payment
  requirements, headers, and facilitator vs direct-submit settlement.
---
# x402 on Algorand for SPM

## Packages (scoped — exact names)
@x402-avm/core, @x402-avm/avm, @x402-avm/express (Hono/Express middleware patterns),
@x402-avm/axios (client auto-handles 402). NOT "@x402/avm".

From @x402-avm/avm import: ALGORAND_TESTNET_CAIP2, USDC_TESTNET_ASA_ID ("10458941").

## Server: PaymentRequirements for a paid package
scheme: "exact"
network: ALGORAND_TESTNET_CAIP2
payTo: SPLIT_APP_ADDRESS
asset: USDC_TESTNET_ASA_ID          // "10458941"
maxAmountRequired: "1000"           // 1000 µUSDC = $0.001
maxTimeoutSeconds: 60
extra: { name: "USDC", decimals: 6, appMethod: "pay", args: [pkg, ver] }

Gate logic: status < COMMUNITY_REVIEWED -> passthrough (free). Else respond 402 with
the requirements above. Free tier must never require a wallet.

## Client (agent / CLI)
On 402, decode requirements, build an ATOMIC GROUP:
  [0] USDC AssetTransfer: payer -> SPLIT_APP_ADDRESS, amount 1000, asset 10458941
  [1] ApplicationCall: pay(pkg, ver) on SPLIT_APP_ID, with [0] as the payment arg
Sign both, base64-encode per x402, retry the GET with the X-PAYMENT header.

## Settlement (server)
Path A: HTTPFacilitatorClient({url: FACILITATOR_URL}) + registerExactAvmScheme on the
resource server (GoPlausible). Path B (FACILITATOR_URL blank): submit the signed group
with algosdk and waitForConfirmation yourself. Confirm the 5 inner transfers before 200.

Return 200 + tarball + X-AUDIT-ATTESTATION: <attest box value or txid>.

## Money rule
All amounts are integer micro-unit strings. Never floats.
EOF

cat > .claude/skills/spm-audit-status/SKILL.md <<'EOF'
---
name: spm-audit-status
description: >
  SPM audit-status model: the tier subset, the auto-reset rule, the SQLite
  schema, and the machine-readable status API. Use for the status store and
  the /api/v1/status endpoint.
---
# Audit status

## Tiers (MVP subset only)
UNREVIEWED       default on publish        FREE
AUTO_SCANNED     passed automated checks   FREE
COMMUNITY_REVIEWED  >=1 signed review      PAID (triggers x402)
PEER_REVIEWED    >=2 independent reviews   PAID
(Skip MISSION_CRITICAL_SAFE and CVE_KNOWN for the hackathon.)

Payment triggers for COMMUNITY_REVIEWED and above. Everything below is free.

## Auto-reset rule
A new package version starts at UNREVIEWED and must be re-reviewed. When the proxy
sees a version it hasn't recorded, default it to UNREVIEWED. This is a demo beat:
"the version bump is exactly where supply-chain attacks inject."

## Lifecycle (how a row gets its status)
1. Unknown version -> synthesize UNREVIEWED (free). Never store-then-block; just default.
2. Auditor calls SplitRouter.attest(pkg, ver, status) on-chain (box = source of truth).
3. Proxy mirrors that into this SQLite row: status=COMMUNITY_REVIEWED, auditor_addr,
   attest_txid. SQLite is the hot-path read; the box is canonical. (Demo: seed both.)
4. Install reads SQLite. >= COMMUNITY_REVIEWED -> 402. Else passthrough (free).
5. Version bump -> no row -> UNREVIEWED again. (See docs/scope-map.md for the full flow.)

## Storage (SQLite — no Postgres/Redis)
CREATE TABLE audit_status (
  pkg TEXT, version TEXT, status TEXT,
  auditor_addr TEXT, attest_txid TEXT, ts INTEGER,
  PRIMARY KEY (pkg, version)
);

## API
GET /api/v1/status/:pkg/:version
-> 200 { pkg, version, status, auditor_addr, attest_txid, ts }
-> unknown version => synthesize { status: "UNREVIEWED" } per the auto-reset rule.
EOF

cat > .claude/skills/spm-testing/SKILL.md <<'EOF'
---
name: spm-testing
description: >
  SPM test stack, LocalNet fixtures, the verification harness, and how to assert the
  5-way on-chain split. Use whenever writing tests, the e2e/demo scripts, or wiring
  scripts/verify.sh — and before setting any /goal condition.
---
# Testing SPM

## Principle
"Done" = a command exits 0 with PASS in its output. Goal-mode's evaluator reads the
transcript, not the filesystem, so always run the check and let the result print.

## Where tests run
- Loop/dev on **LocalNet** (`algokit localnet start`) — instant + deterministic.
- **TestNet** only for the final E2E pass and the live demo (`scripts/demo.sh`).

## Stack
- contracts: vitest + @algorandfoundation/algokit-utils; deploy to LocalNet in beforeAll,
  fund test accounts, opt them into a locally-created USDC-like ASA.
- proxy: vitest + Hono `app.request()`; SQLite in a tmp file seeded per test.
- mcp/cli: vitest; spin the proxy + LocalNet app, drive the tools, assert built groups.

## Asserting the split (the key test)
After a pay() group is confirmed, read the txn's inner-transactions (algosdk
`pendingTransactionInformation` / indexer) and assert exactly 5 inner AssetTransfers with
amounts [500,200,150,100,50] to [auditor,maintainer,adversarial,treasury,ops]. Equivalent:
each recipient's ASA balance delta equals its share. Compare integer micro-units, never floats.

## Harness
- `scripts/verify.sh` — typecheck + `npm test` + LocalNet E2E; per-check PASS/FAIL; nonzero
  if any FAIL. This is the G4 goal condition.
- `scripts/e2e.mjs` — free install, paid install, on-chain split assert, status API,
  auto-reset. `--network localnet|testnet`. Prints `E2E: PASS|FAIL`.
- `scripts/demo.sh` — runs e2e on $NETWORK (default testnet), prints the Lora URL. G5 gate.
Stubs ship failing ("not implemented") so a /goal loop has a red target. Never weaken an
assertion to pass a goal — fix the code.
EOF

###############################################################################
# Verification harness stubs (ship failing so /goal has a red target)
###############################################################################
cat > scripts/verify.sh <<'EOF'
#!/usr/bin/env bash
# SPM verification harness. Exit 0 only if every check passes. The G4 /goal gate.
# Loops should run this against LocalNet. Prints PASS/FAIL per check.
set -uo pipefail
fail=0
run() { # name | command
  printf '%-26s ' "$1"
  if eval "$2" >"/tmp/spm_verify_${1// /_}.log" 2>&1; then echo PASS; else echo "FAIL  (see /tmp/spm_verify_${1// /_}.log)"; fail=1; fi
}
echo "== SPM verify (LocalNet) =="
run "typecheck"        "npm run -s typecheck"
run "unit+integration" "npm test --silent"
run "e2e:localnet"     "node scripts/e2e.mjs --network localnet"
echo "==========================="
if [ "$fail" -eq 0 ]; then echo "VERIFY: PASS"; else echo "VERIFY: FAIL"; fi
exit "$fail"
EOF
chmod +x scripts/verify.sh

cat > scripts/e2e.mjs <<'EOF'
#!/usr/bin/env node
// SPM end-to-end check. Drives the real flow and asserts the on-chain 5-way split.
// Usage: node scripts/e2e.mjs --network localnet|testnet
// Implement against docs/test-plan.md "E2E". MUST exit nonzero until real.
const net = (process.argv.find(a => a.startsWith('--network')) || '').split('=')[1]
         || process.argv[process.argv.indexOf('--network') + 1] || 'localnet';

async function main() {
  // TODO(mcp-payer-engineer + integration-tester): implement these against ${net}
  //  1. free install of an UNREVIEWED package -> succeeds, NO payment
  //  2. install_audited_package(seeded COMMUNITY_REVIEWED) -> tarball returned
  //  3. read settlement group inner-txns -> EXACTLY [500,200,150,100,50] to 5 recipients
  //  4. GET /api/v1/status -> COMMUNITY_REVIEWED + attest_txid
  //  5. version bump -> status resolves to UNREVIEWED
  //  print the group txid + Lora URL.
  throw new Error('E2E not implemented');
}
main()
  .then(() => { console.log('E2E: PASS'); process.exit(0); })
  .catch((e) => { console.error('E2E: FAIL', e.message); process.exit(1); });
EOF
chmod +x scripts/e2e.mjs

cat > scripts/demo.sh <<'EOF'
#!/usr/bin/env bash
# Runs the documented demo path end-to-end and prints the Lora URL. The G5 demo gate.
# NETWORK defaults to testnet (the live stage network).
set -uo pipefail
NETWORK="${NETWORK:-testnet}"
echo "== SPM demo ($NETWORK) =="
if node scripts/e2e.mjs --network "$NETWORK"; then
  echo "DEMO: PASS"
  echo "Follow DEMO.md for the live walkthrough. Open the printed Lora URL on stage."
  exit 0
else
  echo "DEMO: FAIL — see DEMO.md fallback (play the recorded video)."
  exit 1
fi
EOF
chmod +x scripts/demo.sh

###############################################################################
# Demo runbook (documented + tested via scripts/demo.sh)
###############################################################################
cat > DEMO.md <<'EOF'
# SPM demo runbook (documented + tested)

The demo is "done" only when `NETWORK=testnet bash scripts/demo.sh` exits 0 and prints
`DEMO: PASS` + a Lora URL. Rehearse it; record a backup video. ~90 seconds on stage.

## Pre-stage checklist
- [ ] SplitRouter deployed to TestNet; APP_ID/APP_ADDRESS in `.env`.
- [ ] 5 recipients + app opted into USDC ASA 10458941; payer wallet funded (ALGO + USDC).
- [ ] DB seeded: one COMMUNITY_REVIEWED package (paid) + one UNREVIEWED (free) — `/seed`.
- [ ] `bash scripts/verify.sh` green on LocalNet; `NETWORK=testnet bash scripts/demo.sh` green.
- [ ] Lora open; backup video on disk.

## Script (what you say + do)
1. **Free tier.** Agent calls `check_audit_status` then installs an UNREVIEWED package.
   Instant, no wallet. "Unreviewed packages are free — same as npm today."
2. **Paid, agentic.** Agent calls `install_audited_package("lodash","<ver>")`. It hits
   402, signs+pays USDC autonomously, install completes. "The agent paid — no human, no
   subscription, no API key."
3. **On-chain proof.** Open the printed Lora URL: one group txn, five inner transfers
   500/200/150/100/50 µUSDC to auditor/maintainer/adversarial/treasury/ops. "Five parties
   paid atomically, per download."
4. **The hook.** `curl /api/v1/status/lodash/<ver>` shows the status + attestation txid;
   then note a version bump resets to UNREVIEWED. "That bump is exactly where supply-chain
   attacks inject — and where the next bounty appears."
5. (Optional) Live `submit_audit` flip, or the Quantoz EURD-denominated install.

## Fallbacks
- TestNet slow/flaky: switch the narration to the recorded video; still open a prior Lora txn.
- Facilitator down: proxy uses direct algosdk submit (default). No demo change.
- Anything red in `scripts/demo.sh`: do NOT demo live — play the video.
EOF

###############################################################################
# Handoff log seed
###############################################################################
cat > NOTES.md <<'EOF'
# SPM build log (two-dev handoff)

Use `/handoff <summary>` to append entries. Newest at top.

## <date> bootstrap
- Repo scaffolded; Algorand agent skills + .mcp.json in place; SPM Claude config written.
- Next: Dev A -> proxy passthrough (hr1 sync); Dev B -> SplitRouter on LocalNet.
EOF

echo "SPM bootstrap complete."
echo "Created: CLAUDE.md, docs/{architecture,scope-map,test-plan,goals}.md, DEMO.md, NOTES.md,"
echo "         scripts/{verify.sh,e2e.mjs,demo.sh} (stubs), .claude/{settings.json,agents/*,commands/*,skills/*}"
echo "Verify gate: bash scripts/verify.sh   |   Demo gate: NETWORK=testnet bash scripts/demo.sh"
echo "Goal conditions: docs/goals.md (G1..G5).   Run /verify and /demo inside Claude Code."
echo "Reminder: AGENTS.md and .mcp.json come from algorand-agent-skills (SETUP.md step 2)."
