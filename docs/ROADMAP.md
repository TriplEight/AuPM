# Roadmap

AuPM is at an early stage. This file lists what we plan to build next. These are plans, not
promises: the order can change, and nothing here is live until the changelog
([NOTES.md](../NOTES.md)) says so. [SPEC.md](../SPEC.md) §8 holds the full phase plan.

Help is welcome on every item. Open an issue to say which one you want, or to propose a
change to the plan.

## Today (MVP)

- The npm-compatible registry runs on Algorand MainNet at `https://aupm.fyi`.
- Two review tiers: `UNREVIEWED` and `COMMUNITY_REVIEWED`.
- Opt-in donations from the `aupm` CLI, the MCP server and the GitHub Action.
- The CLI is on npm as `aupm-cli`. The GitHub Action runs it, pinned to one exact version.
- `aupm donor init` creates a donor account. On a terminal it guides the funding step by step
  with QR codes, waits for Enter, and opts in to USDC. Without a terminal it prints the steps.
  `aupm donor optin` opts in to USDC. `aupm donor status` shows the next step. No command uses a
  timer or polls.
- `aupm pnpm`, `aupm yarn` and `aupm npx` run pnpm, yarn classic (v1) and npx against the
  registry. Lockfile attestations read `pnpm-lock.yaml` (lockfileVersion 9.0) and `yarn.lock`
  (v1) as well as `package-lock.json`. Yarn berry is not supported yet.
- The donation split pays two roles: the auditor (30%) and ops (70%).
- Auditor onboarding is manual.

## Next

- **Delta review**: a new version in the same major version needs a review of its diff against
  the last reviewed version.
- **Timelocked admin changes** in a new `PaymentRouter` contract.

## Phase 2: more roles, more funding

- A new contract version with the target split: treasury 20% and ops 5% off the top, and a pool
  per package version that pays the reviewer line 40%, the contributor 10% and the maintainer
  25%. Pool money unlocks after a hold period, so a ruling can still stop a wrong payout.
- Onboard the contributor, maintainer and treasury roles.
- Auditor registration and acceptance: an auditor registers a wallet (`aupm register`) and
  applies. Ops reviews the application and accepts or rejects it. Registration alone does not
  let anyone record a review.
- Review bounties for each new version of a reviewed package.
- Automated scans as an extra signal (`AUTO_SCANNED`), separate from human review.
- Forge integrations: Codeberg and Radicle.

## Later

- Phase 3: `PEER_REVIEWED` (two or more independent auditors), challenges with an
  independent arbiter and treasury bounties, conflict-of-interest rules, and a tier filter for installs (`--audit-level`).
- Phase 4: more ecosystems: PyPI, crates.io, Maven, Docker.
- Phase 5: open governance of the treasury and the fee parameters.
