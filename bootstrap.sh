#!/usr/bin/env bash
# SPM Claude Code bootstrap. Run from repo root: bash bootstrap.sh
# Idempotent-ish: overwrites the config files it owns. Does NOT touch AGENTS.md/.mcp.json
# (those come from algorand-agent-skills — see SETUP.md step 2).
set -euo pipefail

mkdir -p .claude/agents .claude/commands \
         .claude/skills/spm-split-contract \
         .claude/skills/spm-x402-flow \
         .claude/skills/spm-audit-status \
         docs

###############################################################################
# Root project memory
###############################################################################
cat > CLAUDE.md <<'EOF'
# SPM — Project Memory (Claude Code)

@AGENTS.md
@docs/architecture.md

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
- Split of 1000 µUSDC = 500/200/150/100/50 (sums to 1000, no remainder).
- Contract = Algorand TypeScript (Puya-TS) via AlgoKit; LocalNet then TestNet.

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
  spm-audit-status) and the Algorand DevRel skills before writing AVM/x402 code.
- Pin dep versions on install; avoid API drift.

## Skills available
- spm-split-contract — SplitRouter math + atomic inner-txn pattern.
- spm-x402-flow      — 402 round-trip with @x402-avm + correct ids.
- spm-audit-status   — status tiers, auto-reset rule, SQLite schema, /api contract.
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
You are the E2E verifier for SPM. You do not write application code; you run it and report.

Checklist each run:
1. Free path: install an UNREVIEWED package — must succeed with zero payment.
2. Paid path: install a COMMUNITY_REVIEWED package via the MCP tool — must 402,
   pay, and return a settlement txid.
3. On-chain: confirm the group txn has exactly 5 inner axfers of 500/200/150/100/50
   µUSDC to the 5 recipients (use algosdk / indexer; provide the Lora URL).
4. API: GET /api/v1/status/:pkg/:version returns the expected status + attest txid.
5. Auto-reset: bump version, confirm status flips to UNREVIEWED.
Report failures with the exact failing assertion and suspected owner subagent.
Produce a one-paragraph go/no-go for the demo.
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
- pay(payment: gtxn.AssetTransferTxn, pkg: string, ver: string):
  assert payment.xferAsset == ASSET_ID
  assert payment.assetReceiver == Global.currentApplicationAddress
  assert payment.assetAmount == UNIT
  issue 5 inner AssetTransfer txns of 500/200/150/100/50 to the stored recipients
  log(concat(pkg, "@", ver, " ", payment.sender))   // proxy reads to confirm
- attest(pkg: string, ver: string, status: uint64): assert sender is an allowed auditor;
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
echo "Created: CLAUDE.md, docs/architecture.md, NOTES.md, .claude/{settings.json,agents/*,commands/*,skills/*}"
echo "Reminder: AGENTS.md and .mcp.json come from algorand-agent-skills (SETUP.md step 2)."
