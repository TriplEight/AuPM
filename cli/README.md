# aupm

`aupm` is the command line for AuPM, an npm-compatible registry overlay on Algorand. Unreviewed
packages pass through to npm for free. A human-reviewed package costs 1,000 microUSDC (0.001
USDC), paid by a donor only when you opt in. Plain `aupm install` stays free.

## Install

Node 22.14.0 or later.

```bash
npm install -g aupm
aupm            # prints usage
```

## Commands

```bash
aupm install ms@2.1.3 [--donate] [--attest-out <path>]   # npm against the AuPM registry
aupm attest package-lock.json [--donate] [--out <path>]  # one signed attestation per lockfile
aupm verify attestation.json [--lockfile <path>] [--keys aupm-keys.json]   # offline
aupm donor init                                          # create a donor key, show a funding QR
aupm donor optin                                         # opt the donor in to USDC
```

Any other first argument goes to npm unchanged. `aupm verify` checks the signed DSSE envelope
offline. It makes no network call.

`AUPM_PROXY_URL` sets the registry. It defaults to `https://aupm.fyi`.

## Donation opt-in

Donation is off by default. Add `--donate` to donate. The donor key is the environment variable
`AUPM_DONOR_MNEMONIC`, or the file that `aupm donor init` writes to
`~/.config/aupm/donor.env` (mode 0600). A donation costs 1,000 microUSDC per reviewed package. A
lockfile costs 1,000 microUSDC times the number of reviewed entries. A lockfile with no reviewed
entry is free.

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
