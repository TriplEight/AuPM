https://github.com/user-attachments/assets/21a37db8-e27c-4132-9ec1-951285fa3149

<h1 align="center">AuPM — audited package manager</h1>

<p align="center"><strong>See which npm packages a human has actually read.</strong></p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/License-AGPL--3.0-00E58B?style=flat-square&labelColor=0B0F19&logo=gnu&logoColor=00E58B"></a>
  <a href="https://www.npmjs.com/package/aupm-cli"><img alt="npm: aupm-cli" src="https://img.shields.io/npm/v/aupm-cli?style=flat-square&labelColor=0B0F19&color=00E58B&label=aupm-cli"></a>
  <a href="https://www.npmjs.com/package/aupm-mcp"><img alt="npm: aupm-mcp" src="https://img.shields.io/npm/v/aupm-mcp?style=flat-square&labelColor=0B0F19&color=00E58B&label=aupm-mcp"></a>
  <a href="https://github.com/TriplEight/AuPM/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/TriplEight/AuPM/ci.yml?branch=main&style=flat-square&labelColor=0B0F19&label=CI&color=00E58B"></a>
</p>

<p align="center">
  <a href="#support-open-source-as-you-go">Support open source</a> ·
  <a href="#try-it-in-30-seconds">Try it</a> ·
  <a href="#for-ai-agents">AI agents</a> ·
  <a href="#install-the-cli">Install</a> ·
  <a href="#how-donations-work">Donations</a> ·
  <a href="#for-auditors">Auditors</a>
</p>

Your project installs hundreds of npm packages. No person has read most of them. Many
companies audit their dependencies internally, but that review work stays private and never
reaches the open-source project.

AuPM is an npm-compatible registry that tells you, for each exact package version, whether a
human auditor has read that tarball. Every answer is a signed attestation that you can verify
offline. Installs stay free. Users and their agents can optionally donate to fund more
reviews.

## Support open source as you go

Open-source funding depends on people who visit a project's page and click "Sponsor". Today,
agents and CI pipelines choose and install most packages, and no person sees that page.

Have you ever thought you can thank the open source you use as you install it, $0.01 at
a time (from $0.001)? Add `--donate` to an install. AuPM pays for a human review of each
reviewed package in your lockfile. The donation pays the auditors of that exact version (40%),
the treasury (20%) and ops (5%). The contributor (10%) and maintainer (25%) shares go to the
treasury until those roles are onboarded. See [How donations work](#how-donations-work).

## Try it in 30 seconds

You need no wallet and no account. Nothing here costs money.

1. Point npm at AuPM. npm works as before, and the integrity hashes are npm's own:

   ```bash
   npm config set registry https://aupm.fyi/
   ```

2. Check one package version:

   ```bash
   curl https://aupm.fyi/api/v1/status/ms/2.1.3
   ```

3. Check a whole project. This writes a signed attestation for your lockfile:

   ```bash
   npx aupm-cli attest package-lock.json
   ```

`UNREVIEWED` is the normal answer today. Auditors have reviewed few packages so far. To go back to the
public registry, run `npm config delete registry`.

## For AI agents

A coding agent can check a package before it adds the package. The MCP server gives it
three tools:

- `check_audit_status` — a free status lookup for one package version.
- `install_audited_package` — installs a package, and donates only with `allowDonation: true`.
- `attest_lockfile` — attests a whole lockfile, and donates only with `allowDonation: true`.

```json
{ "mcpServers": { "aupm": { "command": "npx", "args": ["-y", "aupm-mcp"] } } }
```

An agent without MCP can read [aupm.fyi/llms.txt](https://aupm.fyi/llms.txt). It describes
the HTTP routes and how to read the results.

## Review tiers

The MVP has two tiers:

- `UNREVIEWED` — the default. No auditor has read this exact tarball.
- `COMMUNITY_REVIEWED` — a human auditor read this exact tarball and recorded the review
  publicly (see "For auditors" below).

AuPM also reports two warnings: `INTEGRITY_MISMATCH` and `UNRESOLVABLE`. AuPM always shows
them, and never charges for them.

AuPM plans a tier filter for installs. It has not built that yet: today, `aupm` and the MCP
server install any package, reviewed or not.

## Install the CLI

```bash
npm install -g aupm-cli
```

`aupm` is a drop-in for `npm`. It runs the real npm against the AuPM registry and passes your
arguments and npm's own exit code through unchanged.

```bash
aupm install ms@2.1.3               # installs through the AuPM registry, same as npm
aupm install ms@2.1.3 --donate      # also donates for any reviewed package in the lockfile
aupm pnpm add ms@2.1.3 [--donate]   # pnpm against the AuPM registry; attests pnpm-lock.yaml
aupm npx cowsay hi                  # npx against the AuPM registry; no lockfile, no --donate
aupm config set donate true         # always donate; --no-donate skips it once
```

`aupm attest` and `aupm verify --lockfile` also accept a `pnpm-lock.yaml` (lockfileVersion 9.0,
at most 2 MiB).

`AUPM_PROXY_URL` sets the registry the CLI talks to. It defaults to `https://aupm.fyi`, the
MainNet deployment. For a local proxy, use `http://localhost:4873/`.


### In CI

The `aupm` GitHub Action replaces an `npm ci` step. It installs through the AuPM registry and
falls back to npm. Then it checks the lockfile against the reviewed packages. Pin it to a full
commit SHA. See [.github/actions/aupm/README.md](.github/actions/aupm/README.md). The
[aupm-action-demo](https://github.com/TriplEight/aupm-action-demo) repository runs it on
MainNet.

### Verify an attestation offline

`aupm verify` verifies one signed attestation against a published key. It makes no network
request.

```bash
aupm verify attestation.json --lockfile package-lock.json --keys aupm-keys.json
```

## Early days: come build it with us

AuPM is at an early stage. It runs on Algorand MainNet, and donations settle there. Many
steps are still manual, and only the auditor and ops roles are paid today.
If one of these fits you, please join:

- **Review packages.** Read a tarball, record your review, and get paid for it. See
  "For auditors" below.
- **Maintain a package?** Tell us in an issue. The maintainer share is planned, not live.
  Your input decides how it works.
- **Suggest a change.** Open an issue. The project takes issues only. See
  [CONTRIBUTING.md](CONTRIBUTING.md).
- **Try it.** Point npm at `https://aupm.fyi/` and tell us what breaks.

## How donations work

Everything above is free. This section is for people who want to fund reviews.

A donation pays an auditor to read one exact tarball and match it against the published npm
release. Per reviewed package, the default donation is $0.01 (10,000 microUSDC, x1) and the
minimum is $0.001, in USDC on Algorand, on every paid route. You set a multiplier from x0.1
($0.001) to x100 with `aupm config set multiplier <x>`. A lockfile donation costs the
per-package donation times the number of reviewed packages in that lockfile, with no cap and
no discount. A donation always pays for a reviewed version,
never for an unreviewed one.

Only these opt-ins donate:

- `aupm` with `--donate`, `AUPM_DONATE=true` or `aupm config set donate true`.
- The MCP server's `allowDonation: true`.
- The CI Action's `donate: 'true'` input, with a `donor-secret` secret. The Action donates on
  MainNet unless the job sets `NETWORK: testnet`.

Plain `npm install` through AuPM never donates. To donate, you need a funded Algorand account
holding USDC. See the donor section in [docs/ONBOARDING.md](docs/ONBOARDING.md).

### Why crypto?

We know: the wallet setup is the hardest step in AuPM today. We chose crypto anyway, for
two reasons.

1. **The payment is too small for a card.** Card networks charge a fixed fee on each
   payment, typically tens of cents. That is more than the donation itself: $0.01 by
   default, $0.001 at the minimum. A USDC payment on Algorand costs a small fraction of a
   cent, and the facilitator pays that fee. So even a $0.001 donation arrives in full.
2. **The protocol is an open standard.** AuPM pays over [x402](https://www.x402.org), which
   turns HTTP status 402 "Payment Required" into a working payment flow. The
   [x402 Foundation](https://www.linuxfoundation.org/press/linux-foundation-announces-operational-launch-of-x402-foundation-to-standardize-internet-native-payments-for-ai-agents-and-applications)
   at the Linux Foundation governs it. Its members include Google, AWS, Visa, Stripe and
   Cloudflare. AuPM depends on that open standard, not on one vendor.

### Where the money goes

Split, per donation:

| Recipient | Share |
|---|---|
| Reviewer line (auditors of that exact version) | 40% |
| Contributor (author of a confirmed fix) | 10% |
| Maintainer | 25% |
| Treasury (bounties, arbiters, spot-checks) | 20% |
| Ops | 5% |

Treasury and ops come off the top. The other 75% goes to a pool for the exact package version.
A pool share with no payee goes to treasury, never to ops.

The contributor and maintainer roles are not onboarded yet. Until then, their shares (35%) go to
the treasury. TestNet runs the same split.

### Trust model

The contract admin is a 2-of-3 multisig, not one key. The admin is trusted. Two of the three
signers can together replace the crediter key or lower the payout cap at once. A higher
payout cap, a new ops or treasury address, and a migration to a new contract need a public
announcement, then a 7-day delay, and then must run within the next 7 days or be announced
again. A migration moves no USDC. Held shares and small balances carry over to the next
contract version.

The crediter is a hot key that the nightly job uses. Each night, it pays the matured shares to
the payout addresses in the AuPM ledger, and the ops and treasury shares to their fixed
addresses. The contract trusts the crediter for the payout addresses. It limits the crediter
in two ways:

- It pays out only USDC that arrived and is not paid yet.
- The payouts to payees in one period (about 1 day) total at most `payoutCap`.

A stolen crediter key or a changed ledger can send at most `payoutCap` per period to a wrong
address (up to 2 × `payoutCap` across a period boundary), until the admin lowers the cap or
replaces the crediter. Each payout is a public transfer on chain.

## For auditors

Onboarding is manual in the MVP (planned). The path today:

1. Open an Algorand account and opt it in to USDC.
2. You apply with your GitHub login. The ops check the USDC opt-in and add your address as
   your payout address in the AuPM ledger. The ops also add the address that signs your
   reviews with `pnpm -C proxy auditor add github:<login> <address>`. Logins are lower case.
   If you lose the key or it leaks, tell the ops. They run
   `pnpm -C proxy auditor rotate github:<login> <new-address> [--until <round>]`. The old key
   stays valid for anchors confirmed up to the cutoff round. The new key starts one round later.
3. You read the exact tarball you are reviewing.
4. You anchor the review with a 0-ALGO self-payment to your own address, carrying an ARC-2
   note (`aupm:j{...}`).
5. The operator runs `record-review` against your anchor transaction, which flips the package
   to `COMMUNITY_REVIEWED`.
6. Each donation for that version adds your share to your balance in the ledger. AuPM holds
   each share for 30 days. Then the nightly job pays your balance to your payout address when
   it reaches a payout threshold. You send no transaction. See
   [docs/ONBOARDING.md](docs/ONBOARDING.md#5-auditor).

Attestations use DSSE envelopes with in-toto Statement v1 and ed25519 signatures.

## Links

- [docs/ONBOARDING.md](docs/ONBOARDING.md) — step-by-step onboarding for each user role.
- [docs/API.md](docs/API.md) — the HTTP routes, attestations and the offline check.
- [CONTRIBUTING.md](CONTRIBUTING.md) — how to file issues and report a security problem.
- [Leaderboard](https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&env=mainnet&src=x402-global-challenge)

## License

Licensed under AGPL-3.0-only. See [LICENSE](LICENSE).
