# aupm-mcp

`aupm-mcp` is the MCP server for AuPM, an npm-compatible registry overlay on Algorand. It lets an
agent check the review status of an npm package and install it through AuPM. The `aupm` command
line uses this package for its donor and attestation code.

## Install

Node 22.14.0 or later. Add the server to an MCP client:

```json
{ "mcpServers": { "aupm": { "command": "npx", "args": ["-y", "aupm-mcp"] } } }
```

## Tools

- `check_audit_status`: free. Returns the review status of one exact package version.
- `install_audited_package`: installs a package through AuPM. It donates only when the donation
  setting is on (see "Donation opt-in").
- `attest_lockfile`: asks for one signed attestation for a `package-lock.json` or a
  `pnpm-lock.yaml` (lockfileVersion 9.0, chosen by file name). It donates only when the donation
  setting is on (see "Donation opt-in").

`AUPM_PROXY_URL` sets the registry. It defaults to `https://aupm.fyi`.

## Donation opt-in

Donation is off by default. A donation per reviewed package is the multiplier times 10,000
microUSDC: minimum $0.001 (x0.1), suggested $0.01 (x1), at most x100. Set it with
`multiplier = "1"` in `$XDG_CONFIG_HOME/aupm/config.toml` or the env var `AUPM_MULTIPLIER`.
Without a multiplier, the donation is x0.1. A lockfile costs that price times the number of
reviewed entries. A package with no review is free. Each result carries a receipt with the base
price, the multiplier and the total.
The donor key is the environment variable `AUPM_DONOR_MNEMONIC`, or the key file that
`aupm donor init` writes (mode 0600). The key is 25 words (Algorand mnemonic) or 24 words
(Pera Universal Wallet phrase, derivation 1). The server uses the key only when the donation
setting is on.

The server and the `aupm` CLI read the same setting. The first item that is set wins:

1. The `allowDonation` argument of the call, `true` or `false`.
2. The environment variable `AUPM_DONATE`, `true` or `false`.
3. The line `donate = true` or `donate = false` in `$XDG_CONFIG_HOME/aupm/config.toml`
   (default `~/.config/aupm/config.toml`). `aupm config set donate true` writes it.
4. Off.

A malformed `AUPM_DONATE` or config file makes the tool call fail with an error that names the
fix. The server does not donate in that case. A call that sets `allowDonation` skips both.

## Where a donation goes

Target split, per 1,000 microUSDC:

| Recipient | Share |
|---|---|
| Reviewer line (auditors of that exact version) | 40% |
| Contributor (author of a confirmed fix) | 10% |
| Maintainer | 25% |
| Treasury (bounties, arbiters, spot-checks) | 20% |
| Ops | 5% |

Treasury and ops come off the top. The other 75% goes to a pool for the exact package version.
A pool share with no payee goes to treasury.

MVP split: only the auditor and ops roles are onboarded, and the live contract pays the auditor
30% and ops 70%. A new contract version moves to the target split.

Source, spec and license (AGPL-3.0-only): <https://github.com/TriplEight/AuPM>.
