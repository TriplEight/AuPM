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
- `install_audited_package`: installs a package through AuPM. It donates only when the call sets
  `allowDonation`.
- `attest_lockfile`: asks for one signed attestation for a `package-lock.json` or a
  `pnpm-lock.yaml` (lockfileVersion 9.0, chosen by file name). It donates only when the call
  opts in.

`AUPM_PROXY_URL` sets the registry. It defaults to `https://aupm.fyi`.

## Donation opt-in

Donation is off by default. A donation costs 1,000 microUSDC per reviewed package. A lockfile
costs 1,000 microUSDC times the number of reviewed entries. A package with no review is free.
The donor key is the environment variable `AUPM_DONOR_MNEMONIC`, or the key file that
`aupm donor init` writes (mode 0600). The server uses the key only when the call opts in.

## Where a donation goes

Target split, per 1,000 microUSDC:

| Recipient | Share |
|---|---|
| Auditor | 30% |
| Contributor | 10% |
| Maintainer | 20% |
| Adversarial reviewer pool | 25% |
| Treasury | 10% |
| Ops | 5% |

MVP split: only the auditor and ops roles are onboarded, so the auditor gets 30% and ops gets
70%. Each other role gets its target share once it onboards.

Source, spec and license (AGPL-3.0-only): <https://github.com/TriplEight/AuPM>.
