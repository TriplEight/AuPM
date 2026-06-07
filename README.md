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

**Prerequisites:** Node ≥ 20, Docker (running), and AlgoKit (`pipx install algokit`).

```bash
git clone <repo> && cd spm
npm install                 # installs all workspaces (contracts, proxy, mcp, cli)
algokit localnet start      # local Algorand chain in Docker — no faucets, no wallets
```

That's everything for the default **LocalNet** path. LocalNet is the recommended way to
see it work: it's deterministic, instant, and needs no funded accounts.

> Want to watch it settle on a public chain instead? See [TestNet mode](#testnet-mode) below.

## Build & run

One command brings the whole system up on LocalNet — deploys the `SplitRouter` contract,
opts the five payout accounts into a test USDC asset, seeds a couple of demo packages, and
starts the proxy:

```bash
npm run up                  # deploy + opt-in + seed + start proxy  (LocalNet)
```

If you'd rather run the steps yourself:

```bash
npm run deploy:localnet     # compile SplitRouter, deploy, set 5 recipients, opt them into USDC
npm run seed                # 1 audited package (paid) + 1 unreviewed package (free)
npm run proxy               # Hono overlay on http://localhost:8402
```

You now have a working registry overlay at `http://localhost:8402`.

## Demo — see it work

**Fastest proof (one command, fully automated):**

```bash
bash scripts/verify.sh
```

It runs the end-to-end flow and asserts each claim, printing `VERIFY: PASS` when all hold:

```
typecheck                  PASS
unit+integration           PASS
e2e:localnet               PASS
  ✓ unreviewed package installs free (no payment)
  ✓ audited package returns 402 → pays → installs
  ✓ on-chain group has 5 inner transfers 500/200/150/100/50 µUSDC to the 5 recipients
  ✓ GET /api/v1/status returns COMMUNITY_REVIEWED + attestation txid
  ✓ version bump resets status to UNREVIEWED
VERIFY: PASS
```

**Feel it yourself (manual):** point npm at the overlay and install both kinds of package.

```bash
# free tier — identical to npm, no wallet:
npm install is-odd --registry http://localhost:8402

# audited tier — triggers the x402 micropayment + on-chain split:
npm install lodash --registry http://localhost:8402
# check the machine-readable status any time:
curl http://localhost:8402/api/v1/status/lodash/<version>
```

**The agentic path (primary track):** an AI agent calls the MCP tools and pays on its own.

```bash
npm run mcp                 # starts the MCP server (stdio)
# check_audit_status(pkg)         -> free status lookup
# install_audited_package(pkg)    -> hits 402, signs + pays USDC autonomously, returns the tarball
```

### TestNet mode
To watch payments settle on a public chain with a block-explorer link, copy `.env.example`
to `.env`, fund the payer + 5 recipient wallets (ALGO via the Lora faucet, USDC via the
Circle faucet — USDC ASA `10458941`), then:

```bash
NETWORK=testnet npm run deploy:testnet
NETWORK=testnet bash scripts/demo.sh        # runs the full flow, prints DEMO: PASS + a Lora URL
```

Open the printed Lora URL to see the single group transaction fan out into five inner
transfers. The ≈90-second narrated walkthrough is in **`DEMO.md`**.

## Docs
`SPEC.md` (engineering spec) · `SETUP.md` (setup) · `PLAN.md` (12h two-dev plan) ·
`DEMO.md` (runbook) · `docs/scope-map.md` (glossary + vision→MVP map) ·
`docs/test-plan.md` · `docs/goals.md`.
