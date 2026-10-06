# aupm

`aupm` is the command line for AuPM, an npm-compatible registry overlay on Algorand. Unreviewed
packages pass through to npm for free. A human-reviewed package costs 1,000 microUSDC (0.001
USDC), paid by a donor only when you opt in. Plain `aupm install` stays free.

## Install

Node 22.14.0 or later.

```bash
npm install -g aupm-cli
aupm            # prints usage
```

## Commands

```bash
aupm install ms@2.1.3 [--donate|--no-donate] [--attest-out <path>]   # npm against the AuPM registry
aupm pnpm add ms@2.1.3 [--donate|--no-donate] [--attest-out <path>]  # pnpm against the AuPM registry
aupm npx cowsay hi                                       # npx against the AuPM registry
aupm attest package-lock.json [--donate|--no-donate] [--out <path>]  # one signed attestation per lockfile
aupm attest pnpm-lock.yaml [--donate|--no-donate] [--out <path>]     # lockfileVersion 9.0, at most 2 MiB
aupm verify attestation.json [--lockfile <path>] [--keys aupm-keys.json]   # offline
aupm config set donate <true|false>                      # always donate, or never
aupm config get donate                                   # effective value and its source
aupm donor init [--yes]                                  # create a donor key; guided on a terminal
aupm donor optin                                         # opt the donor in to USDC (one check)
aupm donor status                                        # balances and the next step (read-only)
```

After `install`, `i` and `add`, `aupm pnpm` attests `pnpm-lock.yaml` and prints the same summary
line as `aupm install`. `aupm npx` has no lockfile: `--donate`, `--no-donate` and `--attest-out` exit 2. Any
other first argument goes to npm unchanged. `aupm verify` checks the signed DSSE envelope
offline. It makes no network call.

`AUPM_PROXY_URL` sets the registry. It defaults to `https://aupm.fyi`.

## Donation opt-in

Donation is off by default. Add `--donate` to donate. To donate on every run, set
`AUPM_DONATE=true` or run `aupm config set donate true`. That writes `donate = true` to
`~/.config/aupm/config.toml`. Precedence: `--donate` or `--no-donate`, then `AUPM_DONATE`,
then the file, then off. Any other `AUPM_DONATE` value, or a malformed config line, is an
error. Only the `aupm` command reads this setting. Plain `npm install` stays free.
After an install, `aupm` prints how many packages are audited, not audited, integrity
mismatch and unresolvable. `--donate` pays for every audited package in the whole lockfile. The donor key is the environment variable
`AUPM_DONOR_MNEMONIC`, or the file that `aupm donor init` writes to
`~/.config/aupm/donor.key` (mode 0600; the 25 words and a newline). A donation costs 1,000 microUSDC per reviewed package. A
lockfile costs 1,000 microUSDC times the number of reviewed entries. A lockfile with no reviewed
entry is free.

On a terminal, `aupm donor init` guides you one step at a time. It asks you to type `yes` when
the 25 words are on paper. It waits for Enter after you send the ALGO. Then it checks the balance
once and opts in to USDC. It uses no timer. Press Ctrl-C to stop. Run `init` again to continue
from the state of the wallet. It never prints the 25 words and never overwrites the key file.
Without a terminal, or with `--yes`, `init` prints the steps and exits. With an existing key file
it prints the address and the next step.

For CI, `aupm donor init --yes` prints the commands. You may use a separate wallet: put
`XDG_CONFIG_HOME="$HOME/.config/aupm-ci"` before the onboarding commands. Then
`gh secret set AUPM_DONOR_MNEMONIC_MAINNET < "$HOME/.config/aupm/donor.key"` stores the key as a
GitHub secret. Back up each key file offline: write the 25 words on paper, or copy the file to
an external drive.

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
