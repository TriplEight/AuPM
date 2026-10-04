https://github.com/user-attachments/assets/f7fec474-bfa1-4453-812c-a7dfe773142a

<h1 align="center">AuPM — audited package manager</h1>

<p align="center"><strong>Audited Package Manager.</strong> A package manager that crowdfunds
supply chain security.</p>

<p align="center">
  <a href="LICENSE"><img alt="License: AGPL-3.0" src="https://img.shields.io/badge/License-AGPL--3.0-00E58B?style=flat-square&labelColor=0B0F19&logo=gnu&logoColor=00E58B"></a>
  <a href="https://www.x402.org"><img alt="Built on x402" src="https://img.shields.io/badge/built%20on-x402-22D3EE?style=flat-square&labelColor=0B0F19"></a>
  <a href="https://github.com/TriplEight/AuPM/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/TriplEight/AuPM/ci.yml?branch=master&style=flat-square&labelColor=0B0F19&label=CI&color=00E58B"></a>
</p>

Many companies audit their open-source dependencies internally. That review work never
reaches the open-source project. AuPM gives security auditors, open-source supporters and
package maintainers a way to publish that work and get paid for it. Users and their agents
donate to the packages they use, as they install them.

AuPM is an npm-compatible registry overlay on Algorand MainNet. It looks up the review status
of a package before it serves it. An unreviewed package installs free, exactly like plain
npm. A reviewed package also installs free. A donor can also pay to fund the review, in USDC,
on top of that install.

Caution: no MainNet deployment exists yet. See [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
for the current build and deployment status.

## Review tiers

The MVP has two tiers:

- `UNREVIEWED` — the default. No auditor has read this exact tarball.
- `COMMUNITY_REVIEWED` — a human auditor read this exact tarball and anchored the review
  on-chain (see "For auditors" below).

AuPM plans a tier filter for installs. It has not built that yet: today, `aupm` and the MCP
server install any package, reviewed or not. Only the donation is tier-aware. A donation
always pays for a reviewed version, never for an unreviewed one.

## What a donation pays for

A donation pays an auditor to read one exact tarball and match it against the published
npm release. It costs $0.001 (1,000 microUSDC) per reviewed package, in USDC on Algorand, on every
paid route. A lockfile donation costs $0.001 times the number of reviewed packages in that
lockfile, with no cap and no discount. Installing without `--donate` stays free, always.

Target split, per $0.001 donated:

| Recipient | Share |
|---|---|
| Auditor | 30% |
| Contributor | 10% |
| Maintainer | 20% |
| Adversarial reviewer pool | 25% |
| Treasury | 10% |
| Ops | 5% |

MVP split. So far, the split pays only the auditor and ops roles:

| Recipient | Share |
|---|---|
| Auditor | 30% |
| Ops | 70% |

The MVP's 70% is ops income now, not a debt owed to the other roles. Each role gets its
target share once it onboards. TestNet runs the same split. See
[ADR 0011](docs/adr/0011-split-30-10-20-25-10-5.md) for the split rationale.

### Trust model

The contract admin is a 2-of-3 multisig, not one key. The admin is trusted: two of the three
signers can together redirect any credited balance and the unallocated USDC at any time, with
no delay, because remapping an identity or changing the crediter key takes effect at once.
A migration to a new contract needs a public announcement, then a 7-day delay, and then must
run within the next 7 days or be announced again. The delay gives payees a warning window
for a migration. It does not limit what the multisig can do. Any balance still unclaimed at
migration moves to the treasury account, which pays it to the payee on request. See
[ADR 0010](docs/adr/0010-contract-change-policy.md) for the full design.

## For users and donors

`aupm` is a drop-in for `npm`. It runs the real npm against the AuPM registry and passes your
arguments and npm's own exit code through unchanged.

```bash
aupm install ms@2.1.3               # installs through the AuPM registry, same as npm
aupm install ms@2.1.3 --donate      # also donates for any reviewed package in the lockfile
```

`AUPM_PROXY_URL` sets the registry the CLI talks to. It defaults to `https://aupm.fyi`, the
MainNet deployment. You do not need to clone this repository to use `aupm`: after the first npm
release, `npm install -g aupm` installs it. Until then, run it from a clone. See
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Plain npm also works, and stays free:

```bash
npm config set registry https://aupm.fyi/
```

For a local proxy, use `http://localhost:4873/`.

This never donates. Only `aupm --donate`, the MCP server's `allowDonation`, and the CI Action's
`donate: 'true'` do.

An agent can call the MCP server directly: `check_audit_status` for a free status lookup, and
`install_audited_package` with `allowDonation: true` to pay and install in one step. For a
whole project, `attest_lockfile` with `allowDonation: true` donates once for every reviewed
entry in the lockfile.

The `aupm-attest` GitHub Action runs `aupm attest` against a repository's lockfile in CI. Set
its `donate: 'true'` input and a `donor-mnemonic` secret to donate from CI. Pin it to a full
commit SHA. It donates on MainNet unless the job sets `NETWORK: testnet`. See
[.github/actions/aupm-attest/README.md](.github/actions/aupm-attest/README.md). The
[aupm-action-demo](https://github.com/TriplEight/aupm-action-demo) repository runs it on MainNet.

To donate, you need a funded Algorand account holding USDC. See "Donor account setup" in
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## For auditors

Onboarding is manual in the MVP (planned). The path today:

1. Open an Algorand account and opt it in to USDC.
2. The admin maps your identity on-chain with `setIdentity`.
3. You read the exact tarball you are reviewing.
4. You anchor the review with a 0-ALGO self-payment to your own address, carrying an ARC-2
   note (`aupm:j{...}`, see [ADR 0007](docs/adr/0007-auditor-anchors-review.md)).
5. The operator runs `record-review` against your anchor transaction, which flips the package
   to `COMMUNITY_REVIEWED`.
6. The nightly batch credits your balance in PaymentRouter.
7. You call `claim()` once your balance reaches `MIN_CLAIM`.

## Verify an attestation offline

`aupm verify` verifies one DSSE envelope against a published key. It makes no network request.

```bash
aupm verify attestation.json --lockfile package-lock.json --keys aupm-keys.json
```

## Links

- [SPEC.md](SPEC.md) — the authoritative specification.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — build, run and deploy this repository.
- [docs/adr/](docs/adr/) — design decisions.
- [Leaderboard](https://facilitator.goplausible.xyz/data/leaderboards?cat=merchants&env=mainnet&src=x402-global-challenge)

## License

Licensed under AGPL-3.0-only. See [LICENSE](LICENSE).
