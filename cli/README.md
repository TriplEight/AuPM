# aupm

`aupm` is the command line for AuPM, an npm-compatible registry overlay on Algorand. Unreviewed
packages pass through to npm for free. A human-reviewed package costs at least 0.001 USDC (suggested 0.01 USDC), paid by a donor only when you opt in. Plain `aupm install` stays free.

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
aupm yarn add ms@2.1.3 [--donate|--no-donate] [--attest-out <path>]  # yarn classic (v1) against the AuPM registry
aupm npx cowsay hi                                       # npx against the AuPM registry
aupm attest package-lock.json [--donate|--no-donate] [--out <path>]  # one signed attestation per lockfile
aupm attest pnpm-lock.yaml [--donate|--no-donate] [--out <path>]     # lockfileVersion 9.0, at most 2 MiB
aupm attest yarn.lock [--donate|--no-donate] [--out <path>]          # yarn classic v1 only, at most 2 MiB
aupm verify attestation.json [--lockfile <path>] [--keys aupm-keys.json]   # offline
aupm config set donate <true|false>                      # always donate, or never
aupm config get donate                                   # effective value and its source
aupm donor init [--yes]                                  # create a donor key; guided on a terminal
aupm donor optin                                         # opt the donor in to USDC (one check)
aupm donor status                                        # balances and the next step (read-only)
```

After `install`, `i` and `add`, `aupm pnpm` attests `pnpm-lock.yaml` and prints the same summary
line as `aupm install`. After `install`, `add` and a bare `yarn`, `aupm yarn` attests `yarn.lock`.
`aupm yarn` supports yarn classic (v1) only. Before it installs, it runs `yarn --version` with
the same environment and directory. A yarn berry (2 or later) project, or any failed check,
exits 2 before the install and before any donation. `aupm npx` has no lockfile: `--donate`, `--no-donate` and `--attest-out` exit 2. Any
other first argument goes to npm unchanged. `aupm verify` checks the signed DSSE envelope
offline. It makes no network call.

`aupm verify` needs the verification keys. Download them from the server that signed the
attestation, then pass the file with `--keys`:

```bash
curl -o aupm-keys.json https://aupm.fyi/.well-known/aupm-keys.json
aupm verify attestation.json --keys aupm-keys.json
```

`AUPM_PROXY_URL` sets the registry. It defaults to `https://aupm.fyi`.

### What the npm passthrough changes

- `aupm <npm args>`, `aupm pnpm`, `aupm yarn` and `aupm npx` inherit stdio. They pass argv and
  the exit code of the tool through.
- AuPM removes `--donate`, `--no-donate` and `--attest-out <path>` from argv. A `--` ends that
  removal.
- AuPM sets the registry through `npm_config_registry`. A `--registry` flag from you wins.
- After a successful install-like command, AuPM prints the lockfile summary lines (`aupm: ...`).
- `attest`, `verify`, `donor`, `auditor` and `config` are AuPM commands. They do not go to npm.

`aupm config` manages AuPM settings only. Today the only setting is `donate`. For npm settings,
run `npm config`.

## Donation opt-in

Donation is off by default. Add `--donate` to donate. To donate on every run, set
`AUPM_DONATE=true` or run `aupm config set donate true`. That writes `donate = true` to
`~/.config/aupm/config.toml`. Precedence: `--donate` or `--no-donate`, then `AUPM_DONATE`,
then the file, then off. Any other `AUPM_DONATE` value, or a malformed config line, is an
error. Only the `aupm` command reads this setting. Plain `npm install` stays free.
After an install, `aupm` prints how many packages are reviewed, not reviewed, integrity
mismatch and unresolvable. `--donate` pays for all reviewed packages in the lockfile, not only the
package you named. The donor key is the environment variable
`AUPM_DONOR_MNEMONIC`, or the file that `aupm donor init` writes to
`~/.config/aupm/donor.key` (mode 0600; the words and a newline). The key is 25 words (Algorand mnemonic) or 24 words
(Pera Universal Wallet phrase, derivation 1). `aupm donor init` makes a 25-word key. A donation per reviewed package is the multiplier times 10,000
microUSDC: minimum $0.001 (x0.1), suggested $0.01 (x1), at most x100. Set it with
`aupm config set multiplier <x>` or the env var `AUPM_MULTIPLIER`. `aupm donor init` asks for it
on a terminal. Without a multiplier, the donation is x0.1, and each receipt says so. A lockfile
costs that price times the number of reviewed entries. A lockfile with no reviewed entry is free.

On a terminal, `aupm donor init` guides you one step at a time. It shows the 25 words one time
and asks you to type `yes` when they are on paper. It saves the key file only after `yes`, and
never overwrites it. Ctrl-C or another answer saves nothing: the next `init` makes a new key. It
waits for Enter after you send the ALGO and after you send the USDC. It checks the balance once
for each Enter and opts in to USDC. It uses no timer. Run `init` again to continue from the
state of the wallet. When the wallet can donate, `init` prints a short summary.
Without a terminal, or with `--yes`, `init` saves the key file, never prints the words, prints
the steps and exits. With an existing key file it prints the address and the next step.

For CI, `aupm donor init --yes` prints the commands. You may use a separate wallet: put
`XDG_CONFIG_HOME="$HOME/.config/aupm-ci"` before the onboarding commands. Then
`gh secret set AUPM_DONOR_MNEMONIC_MAINNET < "$HOME/.config/aupm/donor.key"` stores the key as a
GitHub secret. Back up each key file offline: write the 25 words on paper, or copy the file to
an external drive.

## Auditors

An auditor anchors a human review and claims the credited USDC. The commands that sign ask for
the key on a hidden prompt each time. The key is 25 words (Algorand mnemonic) or 24 words
(Pera Universal Wallet phrase). There is no key file, no environment variable and no key flag.
The commands need a terminal.

```sh
aupm auditor review <name>@<version> [--login <github-login>]   # four questions, then a 0-ALGO anchor
aupm auditor balance <github-login>                             # credited balance, minimum claim, next step
aupm auditor claim [--login <github-login>]                     # one claim() call
aupm auditor status <github-login>                              # your reviews on the server
```

`review` shows every field and sends the anchor only after you type `yes`. An unread review
is allowed on TestNet only. The app id and the `payTo` address come from the server
(`GET /api/v1/contract`). `claim` refuses below the minimum claim (100,000 microUSDC), without the USDC opt-in,
and when the key address is not the address that the ops linked to `github:<login>`.

A 24-word phrase derives its account with ARC-52 at `m/44'/283'/n'/0/0`. The default is
`n = 1`, the first named account in Pera. `n = 0` is the wallet root. `review` and `claim`
accept `--derivation <n>` to pick another `n`, or `--address <address>` to search `n = 0`
to `19` for that address. Use one flag, not both. Both flags are an error with a 25-word key.

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

## Troubleshooting

`npm install -g aupm-cli` can fail with `ENOVERSIONS`. This happens when the `before` or
`min-release-age` setting of npm hides every version. Run
`npm install -g aupm-cli --min-release-age=0`, or wait until the versions are old enough.
