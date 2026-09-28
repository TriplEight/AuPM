# AuPM — Specification

**Audience:** a fresh Claude session with no prior context on this project.
**Repo:** `github.com/TriplEight/SPM` (public, `master`)

Part I is the product: the problem, the model, the roles and the phases. Part II is Phase 1,
the MVP for the Global x402 Challenge on Algorand MainNet. Read the whole document before you
write code. §10 lists the constraints that invalidate parts of the built code.

Terms: `CONTEXT.md`. Decisions: `docs/adr/`. Work items: `docs/TASK.md`.

**Version history**
- **v2 (2026-09-19):** open questions resolved, claims ledger added, Bazaar config confirmed,
  attestation envelope decided, pricing revised, work sequence reordered to qualify early.
- **v3 (2026-09-19):** fee-drain guard; rekey ordering trap; DSSE payload bounded to reviewed
  entries; free-path rate limit; pricing as a measured gate; donor recruitment is P0; the Action
  fails open.
- **v4 (2026-09-20):** implementation corrections: `getSupported()`; the 402 body is `{}` and
  the requirements are in the `PAYMENT-REQUIRED` header; §10.5 ordering resolved from the
  middleware source; `integrity` column; boot-guard error-text risk.
- **v5 (2026-09-22):** merged with the product spec (formerly `docs/AuPM-spec-v4.local.md`) and
  its architecture diagram. Decisions: 6-way split 40/10/20/15/10/5; PaymentRouter with repo
  pools and a trusted crediter replaces SplitRouter `distribute()`; PostgreSQL + Drizzle
  replaces SQLite; `payTo` is a plain account rekeyed to the contract (Variant B); the MVP
  onboards only auditor, ops, donor and free user; the tier name `COMMUNITY_REVIEWED` stays;
  deadline Sept 29. ADRs 0001–0004.
- **v6 (2026-09-22):** grilled for simplification. Qualification no longer waits for
  PaymentRouter: `payTo` takes payments before the rekey. SQLite stays (ADR 0001 rewritten;
  PostgreSQL and Redis dropped). `credit()` takes numbered batches (ADR 0005). A reviewed
  tarball returns 402 only with donation opt-in; attestation routes keep standard x402 and give
  a free partial attestation on explicit opt-out (ADR 0006). The auditor anchors each review
  with a note transaction; `attest()` leaves the contract (ADR 0007). The lockfile costs
  1,000 µUSDC per reviewed package, no discount (ADR 0008). One nightly job reconciles, backs
  up and credits. Harness: prek, Claude Code hooks, one task file. Next-version items: §21.

---

# Part I — Product

## 1. Problem

The npm ecosystem has a structural trust deficit: anyone can publish with no identity
verification, no security review, and no accountability.

Documented incidents:

- **Sept 2025** — phishing campaign compromised popular npm maintainer accounts, injecting
  malicious code into packages with 2B+ weekly downloads combined.
- **Sept 2025** — Lazarus Group published 197+ malicious npm packages ("Operation Dream Job").
- **March 31, 2026** — axios@1.14.1 and axios@0.30.4 published via a hijacked lead-maintainer
  account; phantom dependency `plain-crypto-js@4.2.1` delivered a cross-platform RAT during a
  ~3-hour window, with ~100M weekly downloads downstream. Attributed by Google to UNC1069
  (North Korea).
- **2026** — LiteLLM supply chain incident on PyPI (kept only as evidence of multi-language
  demand; do not publish unverified incident details).

Existing tooling is automated and reactive:

| Tool | What it does | What it doesn't |
|---|---|---|
| npm audit | CVE database lookups | Unknown vulns, malicious intent |
| Socket.dev | Static + behavioral analysis, blocking | Human judgment, accountability |
| Sigstore | Cryptographic provenance | Proves source, not security |
| OpenSSF Scorecard | Automated health metrics | Security review |
| Snyk / Dependabot | CVE scanning, PR automation | Human audits |

None provide human, peer-reviewed audits with economic accountability. Enterprises solve this
privately (internal registries, audit teams, Artifactory/Anaconda-style products); findings
are never published back to the OSS community.

In parallel, OSS funding is collapsing under AI-assisted consumption ("demand diversion"):
downloads rise while documentation/sponsor engagement falls. Donation models (Gitcoin
quadratic funding, Patreon/Ko-Fi) decouple payment from usage; visible projects capture most
funding while critical low-visibility packages (xz failure mode) starve.

## 2. Solution

AuPM is a **registry-compatible proxy overlay** in front of npm that adds:

- **Free by default** — unreviewed packages proxy straight through, zero friction, same as npm
  today.
- **Usage-triggered payment** — only human-reviewed packages (`COMMUNITY_REVIEWED` and above)
  can be paid for: $0.001 USDC per reviewed package via x402 on Algorand. A tarball download is
  paid only when the client opts in to donate; a plain `npm install` stays free (§10.4).
- **Crowdsourced human review** — auditors sign reviews; adversarial peer review is a paid role
  (Phase 3).
- **Machine-readable audit status** on every package version (headers + REST API).
- **On-chain accountability** — every accepted review is anchored on Algorand by a note
  transaction that the auditor signs (review anchor, ADR 0007), bound to the tarball
  `dist.integrity`. IPFS JSON manifests, ARC-19 NFTs
  and independent hash mirroring are additive post-MVP upgrades.
- **Self-sustaining security job market** — revenue split: auditors 40%, contributors 10%,
  maintainers 20%, adversarial pool 15%, treasury 10%, ops 5% (§6).

Adoption path: `registry=https://<domain>` in `.npmrc`, or the `aupm` CLI wrapper that adds it.
No migration, no new tooling. **MVP client support is wrapper-only:** pnpm/yarn/bun plugins
and x402-capable npm plugins are post-MVP.

## 3. Threat model and security properties

- **Supply-chain injection at publish/update time** — every new version automatically resets
  to `UNREVIEWED`. This is the moment attacks are injected (axios, Sept 2025 phishing). A new
  version also creates a review bounty (Phase 2).
- **Fake/captured reviewers** — on-chain reputation (post-MVP); 2nd-reviewer bounties reward
  finding flaws in a 1st review; conflict-of-interest rule (no reviewing your employer's
  packages); append-only public audit log.
- **Cache/mirror bypass** — audit attestation travels with the tarball in response headers,
  not only the registry API. Stripped mirrors lose the attestation chain, which is what
  compliance users pay for.
- **Sybil reviewers** — Phase 2 identity = funded Algorand wallet (~0.1 ALGO min balance per
  identity); Sybil cost scales linearly with funding. Wallet cost alone is weak; stake/identity
  weighting is governance scope (Phase 5). In the MVP the auditors are the team.
- **Standard not fork** — AuPM never replaces npm; a user can always go direct. This bounds
  the attack surface of AuPM as a gatekeeper.

Known-open attack economics (deferred to governance, Phase 5): maintainer↔contributor
collusion to farm the 10% fix line (self-introduced bugs), deliberate sloppiness loops,
sloppy reviews.

## 4. Audit status model

Review tier and flags are orthogonal dimensions. The tier answers "who looked". Flags answer
"what is known".

**MVP builds only `UNREVIEWED` and `COMMUNITY_REVIEWED`.** The other tiers and all flags are
the product model and land in later phases.

### 4.1 Review tier (single value per version)

| Tier | Meaning | Phase |
|---|---|---|
| `UNREVIEWED` | Default on publish | MVP |
| `AUTO_SCANNED` | Passed automated CodeQL / OSV / LLM-agent scan; findings attached as metadata | Phase 2 |
| `COMMUNITY_REVIEWED` | ≥1 registered auditor read that exact tarball and signed a review | MVP |
| `PEER_REVIEWED` | ≥2 independent auditors, findings reconciled | Phase 3 |
| `MISSION_CRITICAL_SAFE` | Highest tier, org-attested process | Phase 3 |

The name `COMMUNITY_REVIEWED` is final. The `reviewer` field makes single-reviewer status
explicit.

### 4.2 Orthogonal flags (multi-value per version, Phase 2)

| Flag | Meaning |
|---|---|
| `cve:[CVE-ID]` | Active known vulnerability (repeatable). IDs are data in a flag list, never in a tier value. Sources: OSV / NVD / GHSA + auto-scan |
| `auto_scan:clean` / `auto_scan:findings` | Machine-scan outcome, superseded (not erased) by human review |
| `adversarial:challenged` | Adversarial reviewer disputes an existing review |
| `deprecated` / `unmaintained` | Post-MVP |

A `PEER_REVIEWED` package can carry `cve:CVE-2026-xxxx` at the same time. Sorting/filtering
works on flags as a set.

### 4.3 Hard rules (MVP)

- Publication of any new version (major/minor/patch) resets the tier to `UNREVIEWED`. Flags
  carry forward (Phase 2). The status store keys on `name@version`, so a new version has no
  review record.
- A review record with no stored `dist.integrity` resolves to `UNREVIEWED` (§12.4).
- AI runs `AUTO_SCANNED` only. AI flags, humans judge. AI never replaces a paid-tier sign-off.
- A tier never carries forward to another version, not even inside one major version. The
  review lineage (§21) shares payments along versions, never the tier.

## 5. Roles

Per-repo roles: auditor, contributor, maintainer, adversarial reviewer. Global roles: treasury,
ops. Callers: donor, free user. Each repo accumulates its own pool strictly from payments for
its packages.

**Forks are standalone repos:** a fork has its own repo pool. If a fork fixes findings from an
upstream audit, the auditor gets paid from the fork's pool (paid by the fork's users). Forks
are indistinguishable from roots at the protocol level. The fork metadata model (attestation,
linkage) is Phase 3.

**MVP onboards only four roles: auditor, ops, donor and free user.** The code is written for
these four only. The shares of the other roles are ops income until those roles launch (§6.2).

| Role | What they do | MVP | Onboarding (target) | How they get paid (target) |
|---|---|---|---|---|
| **Free user** | Installs unreviewed packages; reads status; attests zero-coverage lockfiles | Yes | Set registry or install `aupm` wrapper | — |
| **Donor** | Opts in and pays for reviewed resources (§11.4) | Yes | `--donate`, `allowDonation`, `donate: 'true'` | — |
| **Auditor** | Security-audits a package version; publishes signed review + findings | Yes — the team; admin maps identity → address | Phase 2: register Algorand wallet (`aupm register`, USDC opt-in); GPG tiers later | 40%, claimed from PaymentRouter |
| **Contributor** | Authors the fix PR; PR must reference the audit ID | No | Register wallet; link forge account | 10%, credited on merge of the fix PR. Fix completeness is verified by the maintainer who reviewed, approved and merged the PR |
| **Maintainer** | Reviews/merges code; verifies fix completeness; keeps the package at a high tier | No | Register wallet; prove package ownership | 20% (covers merge-review work) |
| **Adversarial reviewer** | Same mechanics as auditor, distinct flag; finds flaws in existing reviews | No | Same as auditor | 15% pool share; bounty on successful challenge |
| **Treasury** (global) | Grants, bounties, incentivization (high-dep/low-download packages) | No | Multisig-held address; later an elected council | 10% |
| **Ops** (global) | Registry hosting, facilitator fees, gas | Yes | — | 5%; in the MVP also the shares of roles not yet onboarded |

### 5.1 Unclaimed funds

MVP: no expiry. Stated publicly. The 1-year escrow (then → treasury, governance-tunable) is
Phase 5 governance, together with the decline/donate flow.

### 5.2 Abuse vectors

- ❌ Maintainers split projects to inflate repo pools → dependency-graph weighting is Phase 5
  governance scope (cf. thanks.dev), out of MVP.
- ⚠️ Fix farming: controlled by maintainer verification, but maintainer↔contributor collusion
  (self-introduced bug → paid fix) has no mitigation yet → known-open, governance.
- ⚠️ Auditor ↔ adversarial collusion / sloppy work → reputation decay + append-only log;
  dispute resolution, judging and appeal path are governance mechanics (Phase 5).
- ✅ "Paid even when a review finds nothing" — the download split is usage-compensation for the
  work, by design. The unequal-pay-for-unequal-work question is deferred to governance.

## 6. Revenue split

### 6.1 Target split (per payment for a reviewed resource)

| Recipient | Share | Per 1,000 µUSDC | Rationale |
|---|---|---|---|
| Auditor(s) | 40% | 400 | Compensation for audit work. Cut from 50% to fund the contributor line |
| Contributor(s) | 10% | 100 | Author of the merged fix PR; completeness verified by the merging maintainer |
| Maintainer | 20% | 200 | Quality + audit cooperation + merge-review work |
| Adversarial reviewer pool | 15% | 150 | Funds secondary review of existing audits |
| Treasury | 10% | 100 | Bounty subsidies for high-dep/low-download packages (xz mode) |
| Ops | 5% | 50 | Registry hosting, gas |

### 6.2 MVP split

| Recipient | Share | Per 1,000 µUSDC |
|---|---|---|
| Auditor | 40% | 400 |
| Ops (ops 5% + the 55% of roles not yet onboarded) | 60% | 600 |

The 60% is ops income, not a debt owed to anyone (ADR 0003).

**Disclosure rule.** Every public text (README, `og:description`, Bazaar descriptions, the
submission form) shows both splits: "Target split 40/10/20/15/10/5. In the MVP: 40% to the
auditor, 60% to the operator until the other roles launch." Never write "20% goes to
maintainers" while that share is ops income.

Payments are USDC on Algorand MainNet. No other chains or rails in the MVP.

## 7. Bootstrapping (cold start)

1. Seed registry metadata by mirroring the most-depended packages.
2. Auto-populate `cve:*` flags from OSV/NVD/GHSA; automated scans → `AUTO_SCANNED` +
   `auto_scan:*` flags (Phase 2).
3. Commission manual audits of the top-10 most-depended packages (lodash, express, axios…)
   once there is reviewer capacity. The MVP seeds small packages instead (§14).
4. Treasury-subsidized bounties for the first ~50 reviews (Phase 2, when treasury launches).
5. Partner with existing security firms / independent auditors.
6. Maintainer outreach: free initial review + 20% download split as incentive (Phase 2, when
   maintainers are onboarded).

For the demo: the auditor anchors one real review, the operator records it with the
`record-review` tool, and the payment loop runs end-to-end on MainNet from the CLI.

## 8. Phases

### Phase 1 — MVP (Global x402 Challenge)

Part II. The demo loop on MainNet: the auditor reviews and signs a review anchor → the operator
records it → the package flips to `COMMUNITY_REVIEWED` → a donor attests a lockfile or installs
via the CLI with `--donate` → 402 → pay → settled to `payTo` → the nightly job credits a batch
in PaymentRouter → the auditor and ops claim.

### Phase 2 — peer review and funding

GitHub Action pinned to a published CLI; Dependabot/Renovate integration; Stripe x402
subscriptions/donations + business tiers; IDE/MCP status badges; forge integrations (Codeberg,
Radicle) + pay-at-forge; onboarding of contributor, maintainer, adversarial reviewer and
treasury, with balances per `(repo, role, identity)`; wallet registration (`aupm register`),
`aupm audit`, `POST /api/v1/review`; claim registration and GitHub proof verification;
oracle-signed identity binding for claims; on-chain AuditorRegistry; review bounty on each new
version; review lineage with delta review (§21); `aupm donor init` (§21); `AUTO_SCANNED`
pipeline and flags; IPFS/ARC-19/mirror manifest upgrades;
AI-skills/MCP-plugin publishing; opt-in maintainer notifications; provenance-verified
maintainer mapping; L2 online verification.

### Phase 3 — cross-signing and ecosystem

`PEER_REVIEWED` (≥2 independent auditors), `MISSION_CRITICAL_SAFE`; adversarial review
bounties + pool distribution; conflict-of-interest enforcement; `--audit-level` filters;
reverse-dep bounty pool funding; GPG attestation tiers (① wallet registration → ② GPG
fingerprint linkage → ③ GPG-signed manifests + on-chain fingerprint attestation); fork metadata
model.

### Phase 4 — scale

PyPI, crates.io, Maven, Docker; PostgreSQL when a second proxy instance runs (ADR 0001).
`aupm` stays the umbrella brand across all ecosystems — no per-ecosystem sub-brands.

### Phase 5 — governance

Elected-council treasury; DAO for fee parameters/tier thresholds; reputation mechanics —
stake/identity weighting, dispute resolution, repairable reputation, judging and appeal path;
dependency-graph fair-split weighting for popular-vs-transitive packages (study thanks.dev
first); bounty marketplace; 1-year escrow for unclaimed funds; collusion/sloppiness economics
from §5.2.

---

# Part II — Phase 1: MVP for the Global x402 Challenge

## 9. Context

AuPM won the Algorand x402 Ideathon and has a working TestNet MVP. It is entering the **Global
x402 Challenge**. The team is registered for the challenge (confirmed 2026-09-19).

### 9.1 Challenge requirements (hard gates)

| Requirement | Detail |
|---|---|
| Network | Algorand **MainNet**. TestNet does not count. |
| USDC ASA | **31566704** (MainNet). TestNet 10458941 for pre-flight only. |
| Network id | `ALGORAND_MAINNET_CAIP2` = `algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=` |
| Facilitator | **GoPlausible, mandatory** — `https://facilitator.goplausible.xyz`. No local facilitator, no direct submission. |
| Hosting | Public HTTPS domain. Localhost settlements are filed under the `DEV` source and do not count. |
| payTo | One MainNet address for the whole competition — it is the leaderboard key. It never changes after the first USDC arrives. Opted into USDC 31566704 (§10.2). |
| Discovery | Bazaar discovery extension on every paid route |
| Tag | `tag: "x402-global-challenge"` in the route's `accepts.extra`. **Attribution is written at settlement time and is not retroactive** — the tag must be present before the first real payment. |
| Proof of life | ≥1 real MainNet payment settled, paid response returned, USDC in payTo, endpoint in Bazaar + challenge leaderboard |
| Submission | Form asks what the payment unlocks **and proof of who is paying for it** |
| Repo | Public, submitted to Electric Capital (`electric-capital/open-dev-data`) |

**Domain rule:** one merchant ↔ one root domain. Never share a payTo across root domains.

**What does not count (DEV bucket):** the facilitator classifies localhost traffic and repeating
loop patterns (cron pings, health checks, bots, retry storms, self-payment loops) as `DEV`, even
when they are real MainNet settlements. Stub-account self-payments prove the pipeline works;
they will not move the challenge leaderboard.

### 9.2 Timeline

- **Sept 22** (v5) — 7 days to the deadline.
- **Sept 25** — first real MainNet payment to `payTo` (§17 Q). Qualification does not depend
  on PaymentRouter: `payTo` receives USDC before the rekey, and the address does not change.
- **Before the first claim** — PaymentRouter passes the TestNet rehearsal (§17 R0), then
  `payTo` is rekeyed on MainNet and the backlog is credited.
- **Sept 27** — submit the form with whatever is live. The form does not reopen.
- **Sept 29** — deadline. The volume engine (GitHub Action, third-party donors) is live by then.
- **"Through early October"** — organisers' wording for real-usage accrual. Volume is measured
  over an **unannounced window** and the leaderboard has been live since July.
- **Early November** — 10 finalists (drawn from the top 50) present at Devcon 8, India. Top 20
  endpoints share 500K ALGO.

Judging: real usage, use-case quality, technical execution, long-term potential.

### 9.3 Leaderboard reality check (snapshot 2026-09-19, `src=x402-global-challenge`, range `24h`)

25 challenge-attributed merchants. #1 ≈ $515 / 4,618 settles. #2 ≈ $53. #5 ≈ $16.5. #10 ≈
$1.36. Most entries have single-digit settles. **The bar for top-20 is low; the constraint is
getting any real third-party callers, not price.** Re-check before relying on this:
`https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&env=mainnet&src=x402-global-challenge`.

### 9.4 Ground truth — what is built (2026-09-22)

Nothing is deployed to MainNet.

**Built and kept:**
- `proxy/` — Hono overlay on `paymentMiddlewareFromHTTPServer` and the `onProtectedRequest`
  free-tier grant. Routes: `POST /v1/attest/lockfile` and `GET /v1/attest`
  (`proxy/src/routes/attest.ts`), DSSE + in-toto signing (`proxy/src/attest/dsse.ts`),
  `GET /.well-known/aupm-keys.json`. No `settle.ts`, no EURD path.
- The SQLite status store and ledger (`better-sqlite3`). They stay (ADR 0001).
- `mcp/` — MCP server: `check_audit_status` (free), `install_audited_package` (x402-gated,
  MainNet/TestNet selectable, `wrapFetchWithPayment`), `attest_lockfile` (donation opt-in,
  `mcp/src/donor.ts`, §11.4).
- `cli/` — `aupm status`, `aupm install`, `aupm verify` (offline L1),
  `aupm attest <lockfile> [--donate] [--out <path>]` (§11.4).
- `.github/actions/aupm-attest/` — composite Action (`action.yml`, `attest.mjs`). It runs
  `aupm attest` from its own checkout and sends no wallet credential unless `donate` is `'true'`.
- `scripts/verify.sh`, `scripts/guard.sh`, `scripts/e2e.mjs`, `scripts/payout.ts`,
  `scripts/demo.sh` — `verify.sh` prints PASS, FAIL, or SKIP per check. It never passes silently.

**Built and replaced in v5:**
- `contracts/` — `SplitRouter` (Puya-TS) with `distribute()` to five role-pool accounts at
  50/20/15/10/5. **Replace it with PaymentRouter (§10.1).** It is not on the qualification
  path (§9.2).
- `proxy/src/claims/` claim registration (`POST /api/v1/claims`) and GitHub proof verification
  (`github.ts`). **Delete** (Phase 2).

**Stack:** pnpm workspaces, TypeScript, Hono, `@x402-avm/{core,avm,hono,fetch,extensions}` 2.6.1,
`@noble/ed25519`, `@algorandfoundation/algokit-utils@10.0.0-alpha.39`, SQLite (`better-sqlite3`).

**Note on x402-avm ≥2.6:** the packages dropped `algosdk` in favour of
`@algorandfoundation/algokit-utils@10.0.0-alpha.39`. Signer code written against algosdk types
must use the 2.6 signer helpers (`toClientAvmSigner`). algosdk stays in the repo for
contract/deploy scripts only.

## 10. Blockers and design constraints

### 10.1 The facilitator forbids a contract call in the payment group → PaymentRouter

The AVM `exact` payload is `{ paymentGroup: string[], paymentIndex: number }`. The facilitator
expects a **2-txn group**: Txn 0 = client's axfer to `payTo` (`fee=0`); Txn 1 = fee-payer
self-payment (from == to == facilitator fee payer, amount 0, no rekey/close-to). The facilitator
signs Txn 1 and submits. No config flag allows an app call in that group.

Consequence: a payment is a plain USDC axfer to `payTo`. The contract is not called at
settlement, and nothing on-chain says which repo a payment is for (ADR 0002).

**Resolution — PaymentRouter with a trusted crediter:**

```
donor ──facilitator──▶ payTo (plain account, rekeyed to PaymentRouter)
                           │ USDC accrues, unallocated
                           ▼
   nightly job (crediter hot key) ── credit(batchSeq, …) once per batch
                           │ contract: one balance per identity (auditor, or "ops")
                           ▼
   auditor / ops ── claim(identity) ≥ MIN_CLAIM ──▶ inner axfer, sender = payTo
```

**PaymentRouter rules:**
- `credit(batchSeq, attributedTotal, unattributedTotal, entries)` — callable only by the
  crediter key (ADR 0005). One call credits one batch of settled payments. `entries` is the list
  of auditor amounts `(repo, identity, amount)`, summed per `(repo, identity)` over the batch.
  The contract asserts:
  - `batchSeq` is exactly one more than the last credited batch (global state; no box per
    payment);
  - the entries sum to exactly `attributedTotal × 400 / 1000` (every attributed price is a
    multiple of 1,000 µUSDC, so this is exact);
  - `attributedTotal + unattributedTotal` is not above the unallocated balance of `payTo`.

  It credits each auditor `identity`'s balance directly, and credits `attributedTotal −
  sum(entries) + unattributedTotal` to the `"ops"` identity's balance. `unattributedTotal` is
  USDC that reached `payTo` with no ledger attribution (§13.2 reconciliation). The 40/60 split
  is enforced on-chain per batch. There is no rounding: each reviewed package in each payment
  credits exactly 400 µUSDC. Balances are keyed by identity, not by address and not by
  `(repo, identity)`: the per-repo breakdown lives in the off-chain ledger only (§13.2). An
  identity credit()s before the admin maps it to an address; it just cannot claim() yet.
- The admin maps each identity (an auditor's `identity`, or the fixed `"ops"` identity) to an
  address. The admin also sets the crediter key.
- `claim(identity)` — the address mapped to `identity` claims that identity's whole balance.
  `MIN_CLAIM` = 100,000 µUSDC ($0.10). A claim costs 2,000 µALGO (the app call + one inner
  axfer). Inner fees are 0 and the claimant pools the fee
  (`assert(Global.currentApplicationCall.fee >= 2000)`), so the contract pays no fee. At ALGO
  $0.11 (2026-09-22) the fee is ≈0.2% of `MIN_CLAIM`. A later admin remap of `identity` moves
  future claims to the new address; it never touches a balance already claimed.
- The contract keeps a running total of credited, unclaimed balances, so it can compute the
  unallocated balance as the USDC balance of `payTo` minus that total.
- Admin-gated `releaseAuthority(to)` carries over from SplitRouter. Planned for the MainNet
  build (P8): it is replaced by `announceRelease(to)` and `executeRelease()`, a two-step flow
  with a compiled-in delay (§10.2a, ADR 0010). `attest()` and `setAttestationKey()` do not:
  reviews are anchored by the auditor (§14, ADR 0007).
- Amount-agnostic: no assertion on a fixed payment amount.
- Every price is a multiple of 1,000 µUSDC, so every attributed credit splits exactly.

**Trust story:** "Payment settles instantly to one fixed address. A credit key attributes
revenue to repos in nightly batches. Each payee withdraws its own balance; nobody can withhold it." Do
**not** say "in the same transaction". Do not say "permissionless" about `credit()`.

**Why not per-payment splitting or crediting:** a per-payment fan-out is several txns per
$0.001 payment, and the facilitator forbids the app call anyway. A per-payment `credit()` costs
a 1,000 µALGO fee (about 11% of a $0.001 payment) plus a replay record (ADR 0005).

### 10.2 payTo is a plain account rekeyed to PaymentRouter (Variant B, ADR 0004)

`payTo` is a plain account. PaymentRouter issues the inner axfers with `sender = payTo`. A later
contract takes over with `releaseAuthority(newApp)` (§10.2a, ADR 0010), and `payTo` stays the
same.

**Order is not reversible: opt into USDC 31566704 *before* rekeying.** A rekeyed account cannot
sign anything with its own key, including its own asset opt-in, and the app cannot opt it in
before the rekey exists. Getting this backwards on MainNet strands the address and forces a new
payTo — after the first settled payment, that restarts the leaderboard entry. Rehearse the full
sequence (opt-in → pay → rekey → `credit()` → `claim()` with inner axfer from the rekeyed
sender) on TestNet (§17 R0) before the MainNet rekey.

**Before the rekey,** `payTo` is a plain account that holds real USDC, and its key can move
it. Keep that key cold and offline, and use it for exactly two actions: the USDC opt-in and the
rekey. After the rekey the key has no signing power over `payTo`.

### 10.2a Contract admin policy and migration (ADR 0010)

`Global.creatorAddress` is a 2-of-3 Algorand multisig address, not one key. No single lost or
leaked key can call `setCrediter`, `setIdentity`, `announceRelease`, or `executeRelease`.

Planned for the MainNet build (P8): `releaseAuthority(to)` is replaced by two admin methods.
- `announceRelease(to)` records `to` and the current round in global state.
- `executeRelease()` runs only after a compiled-in delay of about 7 days (216,000 rounds) from
  the announced round. In order, it: (1) issues one inner USDC transfer of `creditedUnclaimed`
  from `payTo` to the address mapped to identity `"treasury"` — it fails if `"treasury"` is not
  mapped; (2) sets `creditedUnclaimed` to 0; (3) marks the app retired, so `credit()` and
  `claim()` both fail on it from then on; (4) rekeys `payTo` to `to`. `payTo`'s address does not
  change; the rekey changes the authorizer, not the address (invariant 1 holds).

Before `announceRelease`, run the migration runbook procedure (`docs/RUNBOOK-mainnet-launch.md`):
a final credit batch, an announcement to payees, a claim window, and stopping the nightly job
against the old app id before `executeRelease` runs. After `executeRelease`, the treasury pays
each swept balance to its payee off-chain, on request. The old app's balance boxes stay in place
as proof of the amount owed.

Public texts say the treasury role is onboarded only once `"treasury"` is mapped with
`setIdentity` (invariant 8, CLAUDE.md). Before that, `executeRelease` cannot run.

### 10.3 SQLite is the store (ADR 0001)

- SQLite (`better-sqlite3`) holds the status store and the ledger. One proxy process is the
  only writer.
- Docker Compose in development and in production, with one service. The SQLite file lives on a
  named volume.
- Money columns are `INTEGER` micro-units. Never `REAL`, never floats.
- Reviews store the npm `dist.integrity` (sha512) and the review anchor txid.
- Backup: the nightly job (§13.2) first writes `VACUUM INTO` a dated copy and moves it off the
  host. Only then does it credit a batch.
- PostgreSQL is the next step when a second proxy instance runs. Redis is not planned.

### 10.4 Tarballs: free by default, 402 only with donation opt-in (ADR 0006)

`paymentMiddleware` route config is static: a matching route always demands payment. npm cannot
pay a 402, and the seed list (`ms`, `once`, `inherits`) is in almost every lockfile. So a
reviewed tarball is **free unless the request carries `X-AuPM-Donate: 1`**. Every tarball
response carries `X-AuPM-Tier: <tier>`. A free reviewed tarball also carries
`X-AuPM-Donate-Hint: 1000` (the price in µUSDC).

**Fix:** use `paymentMiddlewareFromHTTPServer` and the documented `onProtectedRequest` hook:

```ts
httpServer.onProtectedRequest(async (ctx) => {
  if (!isTarballPath(ctx.path)) return undefined          // other routes: normal flow
  const { name, version } = parseTarballPath(ctx.path)    // handles @scope/name
  const s = await statusStore.get(name, version)
  if (s.tier === 'UNREVIEWED') return { grantAccess: true }
  return ctx.adapter.getHeader('x-aupm-donate') === '1' ? undefined : { grantAccess: true }
})
```

Test three cases: unreviewed tarball → 200; reviewed tarball, no header → 200 with
`X-AuPM-Tier`; reviewed tarball with `X-AuPM-Donate: 1` → 402. An unreviewed tarball never
returns 402, with or without the header.

### 10.5 Handler/settlement ordering — resolved

Confirmed by reading `proxy/node_modules/@x402-avm/hono/dist/esm/index.mjs`:
1. **A failed settlement discards the handler's body.** Lines 176–182 rebuild the response from
   the settlement error. A signed attestation cannot leak on a failed settle.
2. **Settlement is skipped when the handler returns ≥400.** Lines 164–166 return before
   settlement is ever called.

Keep the pre-middleware 400 validation anyway: a caller never builds and signs a payment for a
request that cannot succeed.

### 10.6 USDC must be explicit; fee payer must be advertised

GoPlausible's docs show `price: "$0.01"` with no `extra.asset` resolving to **ALGO**. Every paid
route sets `extra.asset: USDC_MAINNET_ASA_ID`. The documented challenge config also sets
`extra.feePayer`. Read it from `getSupported()` at boot — do not hardcode (current MainNet value
`ZMFK2OI7ZBD2U27ISERZC4S6LKM6WMFJPZQ4MYNJDZ2VNBNMBA67RA22AA`).

### 10.7 Scoped package names break `:pkg` path params

`@babel/core` contains `/`. `GET /v1/attest/:pkg/:ver` cannot route it, and the x402 route
matcher has the same problem. **Single-package attestation uses query params:**
`GET /v1/attest?name=@babel/core&version=7.25.2`. That also maps directly to Bazaar's
`queryParams` schema. The tarball route keeps npm's path layout and parses scoped paths
explicitly (`/@scope/name/-/name-1.0.0.tgz`).

## 11. Architecture

```
┌───────────────────────────────────── Clients ─────────────────────────────────────┐
│ npm CLI (aupm wrapper) · AI agents · IDE / MCP · CI/CD (aupm CLI, aupm-attest Action) │
│ · browser                                                                          │
└──────────────────────────────────────────┬────────────────────────────────────────┘
                                           │ HTTPS (x402), one root domain
┌──────────────────────────────────────────▼────────────────────────────────────────┐
│ AuPM proxy (Hono + @x402-avm/hono, paymentMiddlewareFromHTTPServer)                  │
│  npm proxy (registry overlay) · x402 payment middleware · attestation routes        │
│  Audit status API: GET /api/v1/status · earnings: GET /api/v1/earnings/...          │
│  Core: metadata cache · audit status store · auditor identity map ·                 │
│        accruals ledger · nightly job (reconcile → backup → credit batch)             │
└──────┬─────────────────────┬─────────────────────────┬──────────────────────┬──────┘
       │                     │                         │ verify / settle      │ credit / read
┌──────▼───────┐  ┌──────────▼───────────┐  ┌──────────▼───────────┐  ┌───────▼──────────────┐
│ npm upstream │  │ SQLite               │  │ GoPlausible x402     │  │ Algorand MainNet     │
│ registry     │  │ (one file, one       │  │ facilitator          │  │ payTo → PaymentRouter│
│              │  │ writer; nightly      │  │ (mandatory)          │  │ auditor balances per │
│              │  │ off-host copy)       │  │                      │  │ (repo, identity),    │
│              │  │                      │  │                      │  │ ops balance, claims; │
│              │  │                      │  │                      │  │ review anchors (txns)│
└──────────────┘  └──────────────────────┘  └──────────────────────┘  └───────┬──────────────┘
                                                                         ┌ ─ ─ ▼ ─ ─ ─ ─ ─ ─ ─ ┐
                                                                           post-MVP:
                                                                         │ AuditorRegistry SC · │
                                                                           ARC-19 · IPFS
                                                                         └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘
```

### 11.1 Routes and why the lockfile route leads

| Route | Price |
|---|---|
| `POST /v1/attest/lockfile` | $0.001 × reviewed entries (free if 0 — pre-middleware) ← volume driver |
| `GET /v1/attest?name=&version=` | $0.001, free unless reviewed |
| `GET /<pkg>/-/<tarball>` | $0.001 only with `X-AuPM-Donate: 1` and a reviewed version; else free |
| `GET /api/v1/status/...` | free |
| `GET /api/v1/earnings/github/:login` | free (ledger read) |
| `GET /.well-known/aupm-keys.json` | free (attestation pubkeys) |

**Entry type: Composite.** All routes share one payTo → one merchant entry, each route listed in
the Bazaar.

At $0.001/download, volume requires thousands of developers to change `.npmrc` — the
highest-friction ask AuPM has. `POST /v1/attest/lockfile` takes a `package-lock.json` and returns
a signed attestation for the whole tree; one integration in CI produces a call per PR. It
matches Algorand's published use-case list ("paid endpoints for trust scores, proofs, audit
trails… validation services before an agent or user takes action") and it is the SOC2 CC9.1 /
ISO 27001 A.15 evidence artifact the enterprise pitch claims.

The tarball route stays — it is the differentiator and the narrative. Just don't point it at a
volume leaderboard.

### 11.2 Pricing (ADR 0008)

**Rule: one reviewed package costs 1,000 µUSDC, on every route. No cap, no bulk discount.**

| Route | Price | µUSDC |
|---|---|---|
| `POST /v1/attest/lockfile` (N ≥ 1 reviewed entries) | **$0.001 × N** | 1,000 × N |
| `POST /v1/attest/lockfile` (0 reviewed entries) | **free** (signed, returned without 402) | 0 |
| `POST /v1/attest/lockfile` with `X-AuPM-Donate: 0` | **free** partial attestation (§12.3) | 0 |
| `GET /v1/attest?name=&version=` (unreviewed version) | **free** | 0 |
| `GET /v1/attest?name=&version=` (reviewed version) | $0.001 | 1,000 |
| `GET /v1/attest?…` (reviewed) with `X-AuPM-Donate: 0` | **free** partial attestation | 0 |
| Tarball, reviewed version, `X-AuPM-Donate: 1` | $0.001 | 1,000 |
| Tarball, any other case | **free** | 0 |

N counts entries whose tier is `COMMUNITY_REVIEWED` and whose integrity matches. An
`INTEGRITY_MISMATCH` or `UNRESOLVABLE` entry is never charged. The route computes N with the same
code that builds the attestation, so the price and the attestation cannot disagree. The lockfile
route uses a `DynamicPrice` function (`@x402-avm/core` 2.6.1 resolves `price` per request; the
Hono adapter implements `getBody()`).

**Why keep the lockfile route:** one settlement per CI run, not N. That is faster and cheaper,
and a burst of N payments from one wallet looks like a loop to the facilitator's `DEV`
heuristics. It also gives one signed artifact bound to the lockfile digest.

**Dominance:** `/api/v1/status` is free and each reviewed package costs the same 1,000 µUSDC on
every route, so no route is a premium or a discount against another.

- **Buyer threshold.** A repo with 15 reviewed dependencies at ~30 CI runs/day spends
  ≈ $13.50/month.
- **Invariant:** every price is a multiple of 1,000 µUSDC, so credits split exactly.
- The free paths are rate-limited (§12.3), so none is an unpriced signing oracle.

The measurement of reviewed packages per lockfile (`scripts/hit-rate.mjs`) is no longer a price
gate. It still picks the seed list (§14).

### 11.3 Middleware + Bazaar

Confirmed against GoPlausible's troubleshooting guide (algorand.co, 2026-08-13) and
`getSupported()`:
- Import `declareDiscoveryExtension` from **`@x402-avm/extensions`**, pinned to the same version
  as the other `@x402-avm/*` packages.
- Attach per route as `extensions: declareDiscoveryExtension({...})`. **No `registerExtension`
  call needed** — the Hono binding detects the `bazaar` key and registers the server extension
  on the first paid request.
- `declareDiscoveryExtension` always returns its result under the key `bazaar`.
  `validateDiscoveryExtension` takes `declaration.bazaar`, not the wrapping record.
- A malformed declaration fails **silently**: payments still settle, the catalog row never
  appears. Validate in a unit test: `validateDiscoveryExtension(decl.bazaar).valid === true`.
- The catalog row is created **when a client pays**, from the payment payload. The facilitator
  does not crawl the host.
- Merchant branding comes from `og:site_name`, `og:title`, `og:description`, `og:image` at the
  domain root (§6.2 disclosure rule applies). Trigger one more payment after changing them.

```ts
import { Hono } from 'hono'
import {
  paymentMiddlewareFromHTTPServer, x402ResourceServer, x402HTTPResourceServer,
} from '@x402-avm/hono'
import { HTTPFacilitatorClient } from '@x402-avm/core/server'
import { registerExactAvmScheme } from '@x402-avm/avm/exact/server'
import { ALGORAND_MAINNET_CAIP2, USDC_MAINNET_ASA_ID } from '@x402-avm/avm'
import { declareDiscoveryExtension } from '@x402-avm/extensions'

const facilitator = new HTTPFacilitatorClient({ url: process.env.FACILITATOR_URL! })
const kinds = (await facilitator.getSupported()).kinds
// CAUTION: the method is getSupported(), not supported().
const FEE_PAYER = kinds.find(k => k.network === ALGORAND_MAINNET_CAIP2 && k.scheme === 'exact')
  ?.extra?.feePayer
if (!FEE_PAYER) throw new Error('facilitator does not support algorand mainnet exact')

const PAY_TO = process.env.PAY_TO_ADDRESS!

const accepts = (price: string) => ({
  scheme: 'exact',
  network: ALGORAND_MAINNET_CAIP2,
  payTo: PAY_TO,
  price,
  maxTimeoutSeconds: 120,
  extra: {
    asset: USDC_MAINNET_ASA_ID,          // never omit — default may resolve to ALGO
    feePayer: FEE_PAYER,
    tag: 'x402-global-challenge',        // attribution; not retroactive
  },
})

const routes = {
  'POST /v1/attest/lockfile': {
    // DynamicPrice: 1,000 µUSDC × reviewed entries (§11.2). Zero entries and X-AuPM-Donate: 0
    // never reach the middleware (pre-middleware free paths).
    accepts: accepts(reviewedEntriesPrice),
    description:
      'Signed in-toto attestation for every package in a package-lock.json: ' +
      'human review tier, reviewer, tarball integrity match, and the Algorand ' +
      'txid anchoring each review. $0.001 per reviewed package; free when none is reviewed.',
    mimeType: 'application/json',
    extensions: declareDiscoveryExtension({
      bodyType: 'json',
      input: { lockfileVersion: 3, packages: { 'node_modules/ms': { version: '2.1.3', integrity: 'sha512-…' } } },
      inputSchema: {
        properties: { lockfileVersion: { type: 'integer' }, packages: { type: 'object' } },
        required: ['lockfileVersion', 'packages'],
      },
      output: { example: { summary: { total: 512, reviewed: 14, unreviewed: 497, integrityMismatch: 0 },
                           attestation: { payloadType: 'application/vnd.in-toto+json', payload: '…', signatures: [{ keyid: 'AuPM…', sig: '…' }] } } },
    }),
  },
  'GET /v1/attest': {
    // accepts('$0.001') applies only to a reviewed version.
    // Free tier for an unreviewed version via onProtectedRequest (§10.4).
    accepts: accepts('$0.001'),
    description: 'Signed human-review attestation for one npm package version (query: name, version).',
    mimeType: 'application/json',
    extensions: declareDiscoveryExtension({
      input: { name: 'ms', version: '2.1.3' },
      inputSchema: { properties: { name: { type: 'string' }, version: { type: 'string' } }, required: ['name', 'version'] },
      output: { example: { tier: 'COMMUNITY_REVIEWED', attestation: { /* DSSE */ } } },
    }),
  },
  // tarball route: same accepts('$0.001'); 402 only with X-AuPM-Donate: 1, via
  // onProtectedRequest (§10.4)
}

const server = new x402ResourceServer(facilitator)
registerExactAvmScheme(server)
const httpServer = new x402HTTPResourceServer(server, routes)
httpServer.onProtectedRequest(/* §10.4 */)
app.use(paymentMiddlewareFromHTTPServer(httpServer))
```

`PAY_TO_ADDRESS` holds the rekeyed `payTo` account (§10.2), not the application address. It
replaces `SPLIT_APP_ADDRESS`, which is removed completely. Admin and crediter scripts read the
application ID from `PAYMENT_ROUTER_APP_ID`.

**The 402 JSON body is `{}`.** Payment requirements arrive base64-encoded in the
**`PAYMENT-REQUIRED` response header**, not in the body. A decoded example:
```json
{"scheme":"exact","network":"algorand:wGHE2...","amount":"1000","asset":"31566704",
 "payTo":"<PAY_TO>","maxTimeoutSeconds":60,
 "extra":{"name":"USDC","decimals":6,"asset":"31566704","feePayer":"<feePayer>","tag":"x402-global-challenge"}}
```
Check `bazaar` and `tag` against the decoded header, never against the body.

**Check commands (from GoPlausible):**
```bash
# -i prints response headers, which is why this grep finds anything at all.
curl -i https://<domain>/v1/attest?name=ms\&version=2.1.3 | grep -i "PAYMENT-REQUIRED"
curl -sI https://<domain>/v1/attest?name=ms\&version=2.1.3 \
  | awk -F': ' '/^payment-required/{print $2}' | base64 -d | jq .
curl -s "https://facilitator.goplausible.xyz/discovery/resources?limit=1000" | jq '.items[] | select(.resourceUrl|contains("<domain>"))'
for s in x402-global-challenge bazaar direct dev; do
  curl -s "https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&limit=200&range=all&env=mainnet&src=$s" \
  | jq --arg a "$PAY_TO" '.items[] | select(.address==$a) | {rank,settles,volume}'; done
```
If volume lands under `dev` or `direct`, attribution is broken.

### 11.4 Client donation opt-in

The CLI, the MCP server, and the Action share one behaviour. Donation is off by default.

Opt-in names: CLI `--donate`, MCP argument `allowDonation: true`, Action input `donate: 'true'`.
It applies to reviewed tarball installs and to lockfile and single attestation.

On the wire (ADR 0006):
- With the opt-in, a client sends `X-AuPM-Donate: 1` and pays the 402.
- Without the opt-in, a client sends `X-AuPM-Donate: 0`. The tarball comes back free. An
  attestation route returns a free partial attestation (§12.3). The CLI prints how many reviewed
  entries it withheld and exits 0. The MCP tool returns the partial attestation with
  `status: 'donation_required'`, the price and the resource. The Action passes and prints the
  count.
- A generic x402 client that sends neither header gets standard x402: a 402 for reviewed
  content on the attestation routes, and a free tarball.

Key: env `AUPM_DONOR_MNEMONIC`, for a dedicated donor account (`CONTEXT.md`). No stored
credential file.

Spend cap: a client refuses to sign above 1,000 µUSDC × the number of entries in the lockfile
it sends (1,000 µUSDC for a tarball or a single attestation), or for any asset other than the
network's USDC ASA. There is no config knob. The real limit is the donor account balance.

**Donor setup (MVP, documented in README):** create a fresh account. Fund it with about 0.3 ALGO
(0.1 ALGO base plus 0.1 ALGO for the USDC opt-in, plus margin) and a few dollars of USDC on
Algorand. Opt in to USDC 31566704. The facilitator pays payment fees, so the ALGO covers only
the minimum balance. A wallet with an in-app USDC purchase (for example Pera) avoids an exchange
withdrawal.

Reason: a lockfile that pins a reviewed version must work the same way on every surface.

## 12. Attestations

### 12.1 Is a signature needed at all?

For the immediate HTTP caller, TLS already authenticates the response. The signature matters for
**every consumer after that**: compliance evidence checked months later (must verify after the
database has changed or AuPM is gone); agent-to-agent handoff; CI artifacts attached to a
release. An unsigned "attestation" is a JSON report anyone can edit. Offline verification means
**pubkey only, no network** — ed25519.

### 12.2 Key: dedicated service key, not an auditor key

The lockfile attestation is AuPM's statement *aggregating* many reviewers' on-chain review
anchors, so it is signed by an **AuPM attestation key**:
- ed25519, generated as an Algorand account so `keyid` is a familiar 58-char address. **Never
  funded, never used on-chain.**
- Hot key on the server by necessity. Separate from payTo/admin/crediter keys.
- Published at `/.well-known/aupm-keys.json`: `[{ keyid, publicKey, validFrom, validUntil }]`.
  Rotation = append.

Auditor keys never live on the server.

### 12.3 Envelope: DSSE + in-toto Statement v1

DSSE signs exact payload bytes, so **no JSON canonicalisation** is needed.

```json
{
  "payloadType": "application/vnd.in-toto+json",
  "payload": "<base64(Statement JSON bytes)>",
  "signatures": [{ "keyid": "<AuPM attestation key address>", "sig": "<base64 ed25519>" }]
}
```
`sig = ed25519_sign(PAE)`, where `PAE = "DSSEv1" SP len(type) SP type SP len(payload) SP payload`.

**Do not use `algosdk.signBytes`** — it prepends `MX` and breaks standard DSSE verifiers. Sign
PAE with raw ed25519 (`@noble/ed25519`) using the 32-byte seed from the account secret key.

**Lockfile statement:**
```json
{
  "_type": "https://in-toto.io/Statement/v1",
  "subject": [{ "name": "package-lock.json", "digest": { "sha256": "<hex of exact request body bytes>" } }],
  "predicateType": "https://<domain>/attestation/lockfile/v1",
  "predicate": {
    "issuer": "https://<domain>",
    "issuedAt": "2026-09-25T12:00:00Z",
    "network": "algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=",
    "lockfileVersion": 3,
    "summary": { "total": 512, "reviewed": 14, "unreviewed": 497, "unresolvable": 1, "integrityMismatch": 0 },
    "packages": [{
      "name": "ms", "version": "2.1.3",
      "integrity": "sha512-…",
      "tier": "COMMUNITY_REVIEWED",
      "reviewer": "github:<login>",
      "reviewScope": "full-source+install-scripts",
      "anchorTxid": "…",
      "integrityMatch": true
    }]
  }
}
```

**Single-package statement:** subject
`{ "name": "pkg:npm/ms@2.1.3", "digest": { "sha512": "<hex from integrity>" } }`, same predicate
shape with one package.

**Rules:**
- The subject digest is over the **raw request body**. The CLI and Action POST file bytes
  unchanged.
- `integrityMatch: false` → tier reported as `INTEGRITY_MISMATCH`, never `COMMUNITY_REVIEWED`.
- Git, tarball-URL, or non-npm `resolved` entries → `UNRESOLVABLE`.
- Limits: body ≤ 5 MB, ≤ 10,000 entries, `lockfileVersion` 2 or 3; otherwise 400
  (pre-middleware, before any 402 — §10.5).
- **`predicate.packages` lists only reviewed, `INTEGRITY_MISMATCH`, and `UNRESOLVABLE` entries.**
  `summary` carries the counts; `predicate.absentMeans: "UNREVIEWED"`.
- `anchorTxid` is the review anchor (§14): a transaction whose sender is the auditor's address.
- **Partial attestation** (request with `X-AuPM-Donate: 0`, ADR 0006): the same statement, with
  every reviewed entry whose integrity matches left out of `predicate.packages`.
  `predicate.withheld` is the number left out, and `predicate.absentMeans` is
  `"UNREVIEWED_OR_WITHHELD"`. `INTEGRITY_MISMATCH` and `UNRESOLVABLE` entries are always listed:
  AuPM never charges for a security warning. A full attestation has `predicate.withheld: 0`.
- Response: `{ summary, attestation }`. `summary` is an unsigned convenience copy; verifiers use
  `attestation`.
- **Free paths are rate-limited** per IP (e.g. 20/hour, 429 beyond): the zero-coverage path
  and the partial path.
- **Every lockfile request is also rate-limited** per IP (e.g. 120/hour, 429 beyond), paid or
  free, checked before the body is read. Without this, a lockfile with at least one reviewed
  entry could spend server CPU (a parse, status lookups, a signature) on every request at no
  cost — the free-path limit above never sees the priced branch.

**Verification levels:**
- **L1 (offline, MVP):** `aupm verify att.json --lockfile package-lock.json` — checks the ed25519
  signature against keyid ∈ pinned or `.well-known` keys, and the sha256 of the local file
  against the subject.
- **L2 (online, Phase 2):** fetch each `anchorTxid` from the indexer and confirm that its note
  matches the entry and its sender is the auditor's published address.

### 12.4 Integrity binding

An attestation binds to a specific tarball. The status store carries `dist.integrity`.

**A review record with no stored integrity is not a complete review.** It resolves to
`UNREVIEWED`.

WARNING: without this rule the signed statement reports `integrityMatch: true` having compared
nothing. That is a fabricated field in a paid security claim.

## 13. Revenue attribution and claims

**Principle:** revenue attributable to an auditor accrues from the first payment, also before
PaymentRouter exists. The auditor claims it on-chain from PaymentRouter. Everything else is ops
income in the MVP (§6.2).

### 13.1 Repo key

A repo pool is keyed by the GitHub `owner/repo` from the `repository` field of the npm packument
for the reviewed version. If the field is missing or not on GitHub, the key is `npm:<name>`. The
`record-review` tool resolves and stores the key when it records the review. No fetch happens
at payment time, and unreviewed packages never trigger a fetch.

### 13.2 Off-chain ledger (SQLite)

```sql
accruals(settle_txid, route, pkg, version, repo, role, identity, amount_micro INTEGER,
         batch_seq, created_at,
         PRIMARY KEY (settle_txid, role, pkg, version))   -- idempotent
batches(batch_seq PRIMARY KEY, attributed_micro INTEGER, unattributed_micro INTEGER,
        credit_txid, created_at)
```

The ledger is the crediter's input queue and the audit trail. PaymentRouter holds the balances.

**Attribution rules:**
- The ledger records all six target roles for each payment, so Phase 2 can add roles with no
  data loss.
- **auditor** → `github:<reviewer>` from the review record, repo from §13.1. Credited on-chain.
- **contributor, maintainer, adversarial reviewer, treasury, ops** → recorded with identity
  `unassigned` (ops: `ops`). Credited on-chain to the ops balance.
- **Every route:** each reviewed package in a payment carries exactly 1,000 µUSDC (§11.2), so
  each package gets exact role shares (400 / 100 / 200 / 150 / 100 / 50). No division, no
  remainder.

**Write path:** a Hono middleware registered *outside* the payment middleware. After `next()`, if
the response carries `PAYMENT-RESPONSE` with success, decode the settle txid and write accruals
from attribution data the handler put on the context (`c.set('attribution', …)`).

**Nightly job (one job, in-process):** the proxy process itself runs it, daily at 03:17 UTC, and
catches up once at start when the last successful run is more than 24 hours old or none exists
(ADR 0009). `AUPM_NIGHTLY=off` disables the schedule. `nightly-main.ts` stays the manual entry
point for an operator-run pass. In order:
1. **Reconcile.** List USDC axfers into `payTo` (indexer, `INDEXER_URL`) and compare them with
   ledger `settle_txid`s. An unmatched inflow (crash between settle and write, direct deposit)
   is ledgered as `unassigned` ops income. Skip inflows confirmed less than 900 seconds ago
   (`MIN_INFLOW_AGE_SECONDS`).
2. **Back up.** `VACUUM INTO` a dated copy of the SQLite file in `BACKUP_DIR`. If this fails,
   stop: do not credit. The host's own backup (restic) ships `BACKUP_DIR` off the host once a
   day, after the job. AuPM does not check that backup; its error alert goes to the operator.
   A lost host loses at most one day of attribution. Reconcile rebuilds those inflows as
   `unassigned` ops income.
3. **Credit.** If `PAYMENT_ROUTER_APP_ID` is unset or `payTo` is not yet rekeyed, stop here.
   Else put every uncredited accrual into batch `last + 1`, sum auditor entries per
   `(repo, identity)`, and call `credit()` with the crediter key (`CREDITER_MNEMONIC`). Record
   the credit txid on the batch. A batch whose txid is recorded is never sent again.

The crediter key is a hot key that can call only `credit()`. It is never the deployer, the
admin, the donor or `payTo`.

### 13.3 Claim flow (MVP)

1. `GET /api/v1/earnings/github/:login` — public, free: accrued and credited per role from the
   ledger, claimed from PaymentRouter state.
2. The admin maps the auditor identity to an Algorand address in PaymentRouter: the same
   address that signs the auditor's review anchors (§14). The address must be opted into USDC
   31566704.
3. The auditor calls `claim()` when the balance is ≥ `MIN_CLAIM`. Ops claims the ops balance the
   same way.

### 13.4 Notification (MVP = manual only)

- **No automated issues, PRs, or emails to third-party repos.** Bot-opened issues on popular
  repos read as spam and risk GitHub AUP enforcement and reputational damage to a security
  product. Unsolicited commercial email is restricted under German UWG §7.
- Phase 2: opt-in notifications.

**Legal note before the first third-party payout:** paying third parties from funds AuPM
attributes to them may touch payment-services regulation (ZAG) for a German operator. Get a
lawyer's read before any role other than the team's auditors and ops is paid. In the MVP only
the team claims.

## 14. Honesty constraints for seeded data

A paid security attestation on MainNet that claims a human review that did not happen is a
fabricated record.

- **Every `COMMUNITY_REVIEWED` record is a real review** of that exact tarball (integrity-bound),
  with `reviewer` and `reviewScope` recorded, and a review anchor on-chain (ADR 0007).

**Review flow (MVP):**
1. The auditor reviews the tarball, then signs and sends the review anchor from their own
   machine: a 0-ALGO payment from their address to itself, with the ARC-2 note
   `aupm:j{"v":1,"name":…,"version":…,"integrity":…,"reviewer":"github:<login>","scope":…}`.
   The auditor key never touches the server.
2. The operator runs `record-review <anchorTxid>` on the server. The tool reads the anchor from
   the indexer, checks that the sender is the auditor's address in the server's auditor map
   (`AUDITORS`, `github:<login>=<address>`), checks that the note integrity equals npm
   `dist.integrity` for that exact version, resolves the repo key (§13.1), prints all fields,
   and requires an interactive `yes`. Only then does it write the row.
3. The admin sets the same auditor map in PaymentRouter when it is deployed (§13.3).

No other code path writes a review row: not CI, not a fixture, not a seed script.
- **Seed selection:** small, ubiquitous transitive dependencies that a human can genuinely review
  in 15–30 minutes and that appear in most lockfiles (such as `ms`, `inherits`, `once`,
  `wrappy`, `balanced-match`, `escape-string-regexp` — confirm by frequency across real
  lockfiles). Big packages (lodash, react) are out until there is reviewer capacity.
- **Target 15–30 packages.** The team's auditors split the reviews.
- Qualification payments from team wallets are labelled as such in `NOTES.md` and the
  submission. The "who is paying" answer must rest on third-party donors (§17 P0).

## 15. Do not build (MVP)

GPG identity · ARC-19 NFTs · IPFS manifests · PostgreSQL · Drizzle · Redis · Litestream ·
reputation scoring · peer review / cross-signing · adversarial-review UX · governance/DAO ·
CodeQL auto-scan · `AUTO_SCANNED` pipeline and flags · Dependabot/Renovate integrations ·
PyPI/crates.io · Stripe pre-funding · subscriptions · EURD/Quantoz · direct-submit settlement
fallback · `PEER_REVIEWED` / `MISSION_CRITICAL_SAFE` tiers · onboarding of contributor,
maintainer, adversarial reviewer or treasury · wallet registration (`aupm register`),
`aupm audit`, `POST /api/v1/review` · claim registration and GitHub proof verification ·
on-chain AuditorRegistry · `attest()` or `setAttestationKey()` in PaymentRouter · per-payment
`credit()` · review bounties · review lineage and delta review · `aupm donor init` ·
automated maintainer notifications · automated payouts · L2 online verification · bulk
discounts or price caps · 1-year escrow.

Use the `scope-sentinel` subagent before anything sizable.

## 16. Canonical facts

- Packages: `@x402-avm/{core,avm,hono,fetch,extensions}`, all pinned to 2.6.1. Not `@x402/*`.
- MainNet USDC **31566704**; TestNet **10458941**. 6 decimals.
- `ALGORAND_MAINNET_CAIP2 = algorand:wGHE2Pwdvd7S12BL5FaOP20EGYesN73ktiC1qzkkit8=`.
- Scheme `exact`. Middleware price is a USD string; on-chain amounts are integer µ-units.
  **Never floats.** Every price is a multiple of 1,000 µUSDC.
- Price: 1,000 µUSDC per reviewed package on every route. The lockfile price is
  1,000 × reviewed entries, no cap, no discount; free at zero.
- `extra = { asset, feePayer, tag: "x402-global-challenge" }` on every paid route.
- Target split **40/10/20/15/10/5** → per 1,000 µUSDC: 400/100/200/150/100/50.
- MVP split **40/60** → per 1,000 µUSDC: auditor 400, ops 600.
- `credit(batchSeq, attributedTotal, unattributedTotal, entries)`, one call per nightly batch.
- `MIN_CLAIM` = 100,000 µUSDC. A claim's fee (2,000 µALGO) is pooled by the claimant.
- Facilitator `https://facilitator.goplausible.xyz`, mandatory. It pays network fees for
  donors; `credit()` fees are the crediter's; `claim()` fees are the claimant's.
- `payTo` = plain account, opted into USDC, takes payments, then is rekeyed to PaymentRouter
  before the first claim.
- Store: SQLite, one writer. Money columns `INTEGER` micro-units. Nightly off-host copy.
- Unreviewed content never returns 402. A reviewed tarball returns 402 only with
  `X-AuPM-Donate: 1`. Attestation routes return 402 for reviewed content unless the request
  sends `X-AuPM-Donate: 0`, which gets a free partial attestation.
- Version bump → `UNREVIEWED`. The narrative spine. A tier never carries forward.
- Reviews: anchored by the auditor's own note transaction (ARC-2 `aupm:j`).
- Attestations: DSSE + in-toto Statement v1, ed25519, dedicated unfunded service key.
- pnpm only, `pnpm add --save-exact`.
- Append a dated `NOTES.md` entry after each unit of work (`/handoff`).

## 17. Work sequence

The work items with acceptance checks are in `docs/TASK.md`. This section fixes the order and
the gates.

**P0. Recruit third-party donors (spans the whole plan; owner: the team).** Line up 3–10
external repos that will run `aupm-attest` **with their own donor accounts**. Each one passes
`donate: 'true'` and its own `donor-mnemonic` secret. Each needs a MainNet Algorand account
with about 0.3 ALGO (minimum balance for the USDC opt-in), a USDC opt-in, and a few dollars of
USDC on Algorand (§11.4). **Acquiring Algorand-native USDC is the bottleneck** — an exchange
withdrawal or bridge hop takes days; an in-app wallet purchase is faster. Chase every 3 days.
*Check:* ≥3 external addresses are funded and opted in, confirmed on-chain, by Sept 27.

**Q. Qualification (does not need PaymentRouter; first real payment by Sept 25).**
1. Provision MainNet: `payTo` (plain account, USDC opt-in only, key cold and offline), auditor
   addresses (funded with ALGO for anchor fees, opted into USDC), attestation key (unfunded).
   Cold keys never touch the server.
2. MainNet config; the server refuses to boot if `getSupported()` lacks MainNet `exact` with
   `x402Version` 2, and logs the resolved `feePayer`.
3. Deploy with Docker Compose on the production host; `og:*` metadata at the domain root.
   *Check:* `curl -sI -H 'X-AuPM-Donate: 1' "https://<domain>/v1/attest?name=ms&version=2.1.3"`
   → 402 once `ms@2.1.3` is reviewed.
4. Auditors anchor 3–5 real reviews; the operator records each with `record-review` (§14).
5. Bazaar + tag: decode `PAYMENT-REQUIRED` and confirm `bazaar` and `tag`.
6. First real MainNet payment → `/discovery/resources` → merchant under
   `src=x402-global-challenge`. *Check:* settle txid, the ledger row and the leaderboard output
   in `NOTES.md`. **The entry qualifies here.**

**R0. PaymentRouter (parallel track; done before the first claim).** PaymentRouter replaces
SplitRouter; the nightly job gets its credit step. *Gate:* the full sequence passes on
TestNet: `payTo` opt-in → pay through GoPlausible → rekey → nightly job credits batch 1 →
`claim()`. Then on MainNet: deploy PaymentRouter, set the crediter key and the auditor map,
rekey `payTo`, and let the nightly job credit the backlog. *Check:* credit and claim txids in
`NOTES.md`.

PaymentRouter test vectors:
- One batch of one tarball payment (1,000 µUSDC, one reviewed package) → auditor 400, ops 600.
- One batch of one lockfile payment with 3 reviewed packages (3,000 µUSDC) → auditor entries
  400 / 400 / 400, ops 1,800. Sums equal 3,000 exactly.
- One batch of two payments for the same `(repo, identity)` → one entry of 800.
- `unattributedTotal` 5,123 with `attributedTotal` 0 → ops 5,123, no entries.
- Entries that do not sum to exactly `attributedTotal × 400 / 1000` → `credit()` fails.
- `batchSeq` not equal to last + 1 (a repeat or a gap) → `credit()` fails.
- `attributedTotal + unattributedTotal` above the unallocated balance → fails.
- A balance of 99,999 → `claim()` fails. 100,000 → succeeds.

CAUTION: contract tests run under `algorand-typescript-testing`, in JavaScript. They do not
prove the contract compiles under Puya or runs on the AVM. A human runs
`algokit project run build`. See `docs/RUNBOOK-contract-build.md`.

**Volume (in parallel, by Sept 29):** measure reviewed-package frequency across real lockfiles
(`scripts/hit-rate.mjs`) to pick the seed list, then seed 15–30 reviewed packages (§14); the
Action on external repos with `donate: 'true'`; MCP server on MainNet. Submit the form on
Sept 27 and the repo to Electric Capital.

**Do not manufacture volume.** Self-payment loops land in `DEV` anyway, and judges weigh real
usage.

## 18. Remaining risks

- **DEV classification heuristics** are not published. Mitigation: event-triggered CI only (no
  `schedule:`), one donor account per adopting team, one settlement per CI run (lockfile
  route), no retries on 402 beyond the protocol's single retry.
- **`payTo` key custody before the rekey.** Until the rekey, the `payTo` key can move all USDC.
  Mitigation: the key stays cold and offline and signs only the opt-in and the rekey.
- **Ledger loss before a credit.** The SQLite file is the only record of which auditor a payment
  was for. Mitigation: the nightly local copy runs before every credit, and the host's backup ships
  it off the host daily; reconcile can rebuild inflows from the chain, but only as `unassigned`
  ops income.
- **Crediter trust.** A compromised crediter key can misattribute revenue between the auditor and
  ops balances, bounded by the unallocated balance. It cannot move funds out.
- **Facilitator boot-guard/route-validation mismatch.** `resolveFeePayer` accepts a
  supported-kind that omits `x402Version`; the route validation requires it. Both fail before the
  port binds, but the error text misleads.

## 19. Definition of done

**Qualification (by Sept 27, hard deadline Sept 29):**
- [ ] Public HTTPS endpoint on MainNet. Unreviewed tarballs return 200 free. A reviewed tarball
      returns 200 free without `X-AuPM-Donate: 1` and 402 with it
- [ ] Payments verified and settled through GoPlausible; `extra.asset` = 31566704 in a settled
      txn
- [ ] `x402-global-challenge` tag present before the first real payment; Bazaar row exists
- [ ] ≥1 real MainNet payment; paid response returned; USDC in payTo; ledger row written
- [ ] Merchant visible under `src=x402-global-challenge` (not `dev`/`direct`)
- [ ] Attestation verifies offline with `aupm verify`
- [ ] SplitRouter, claim registration and GitHub proofs gone; `scripts/verify.sh` green
- [ ] Public texts show both splits (§6.2)
- [ ] Form submitted; repo submitted to Electric Capital

**Placement (by Sept 29, running into early October) — in priority order:**
- [ ] **≥3 external donors funded, opted in, and settling from their own donor accounts** (P0)
- [ ] `aupm-attest` Action running on those repos, failing open
- [ ] Lockfile route live with per-package price, zero-coverage free path and partial path
- [ ] 15–30 genuinely reviewed packages, each with a review anchor on MainNet
- [ ] PaymentRouter deployed, `payTo` rekeyed, `credit()` and `claim()` executed on MainNet;
      verified on Lora
- [ ] Nightly job running: reconcile, off-host backup, credit

## 20. Post-MVP TODO

1. Publish the CLI to npm. The Action then runs a pinned published package, not a build from
   source.

## 21. Next version (v7 candidates)

Decided in the v6 review. Not in the MVP.

- **Review lineage and delta review.** A later version inside the same major version becomes
  `COMMUNITY_REVIEWED` only after a delta review of the diff against the last reviewed version
  in the lineage. Payments for a version in the lineage split between the original auditor and
  the delta reviewers. The tier never carries forward; a patch release is the moment attacks are
  injected (axios 1.14.1). Each new version creates a delta-review bounty (Phase 2).
- **`aupm donor init` / `aupm donor optin`.** Create a donor account, print the address and a
  funding QR code, wait for funds, opt in to USDC.
- **Reviews as a file in git.** The review records live in the repo, signed and anchored
  on-chain; SQLite keeps only the ledger.
- **Litestream** replication of the ledger, if the nightly copy is not enough.
- **PostgreSQL** when a second proxy instance runs (ADR 0001).
