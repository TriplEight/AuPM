# AuPM GitHub Action

This Action replaces an `npm ci`, `pnpm install --frozen-lockfile` or
`yarn install --frozen-lockfile` step. It does four things in order:

1. It finds the lockfile and picks npm, pnpm or yarn classic.
2. It installs through the AuPM registry.
3. It falls back to the same command against the public registry if the AuPM
   registry fails.
4. It donates to the reviewed packages in the lockfile, only when `donate` is `'true'`.

Pin the Action to a full 40-character commit SHA of `TriplEight/AuPM`.
Never use a branch name or a short SHA.

## Replace `npm ci`

Before:

```yaml
- run: npm ci
```

After:

```yaml
- uses: TriplEight/AuPM/.github/actions/aupm@<40-character SHA>
  with:
    endpoint: https://aupm.fyi
```

This step pays nothing. The project installs the same packages as with
`npm ci`. The Action looks for `package-lock.json`, `pnpm-lock.yaml` and
`yarn.lock` in the working directory. It uses the one it finds. The Action
writes a signed receipt to `aupm-receipt.json`.

A project in a subdirectory sets `lockfile`. The file name picks the tool:

```yaml
- uses: TriplEight/AuPM/.github/actions/aupm@<40-character SHA>
  with:
    endpoint: https://aupm.fyi
    lockfile: apps/web/pnpm-lock.yaml
```

Set up Node, and pnpm or yarn if the project needs it, before this step. For
example, use `actions/setup-node` and `pnpm/action-setup`. The install step
uses the Node and the package managers of the job.

## Donate to reviewed packages

Use one donor secret for each network. Put the network in the secret name,
for example `AUPM_DONOR_MNEMONIC_MAINNET` and `AUPM_DONOR_MNEMONIC_TESTNET`.
Then a secret cannot pay on the wrong network.

The value of the donor secret is a 25-word Algorand mnemonic of a funded
account. You may use a separate wallet for CI.

`aupm donor init` prints the steps. In bash or zsh, `aupm donor optin` and
`gh secret set AUPM_DONOR_MNEMONIC_MAINNET < "$HOME/.config/aupm/donor.key"`
store the key as a secret. For a separate wallet, put
`XDG_CONFIG_HOME="$HOME/.config/aupm-ci"` before the `aupm` commands and use
that key file. In PowerShell, set `$env:XDG_CONFIG_HOME` the same way, close
the window afterwards, and run
`Get-Content "<key file>" | gh secret set AUPM_DONOR_MNEMONIC_MAINNET`.
For TestNet, name the secret `AUPM_DONOR_MNEMONIC_TESTNET`. Everyone who can
change the workflows of the repository can read the secret.

MainNet pays real USDC. Set `NETWORK: mainnet` in the job's `env:`, so the
network is explicit in the log:

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      NETWORK: mainnet
    steps:
      - uses: actions/checkout@<40-character SHA>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<40-character SHA>
        with:
          node-version: 22
      - name: Install and donate to reviewed packages
        uses: TriplEight/AuPM/.github/actions/aupm@<40-character SHA>
        with:
          endpoint: https://aupm.fyi
          donate: 'true'
          donor-secret: ${{ secrets.AUPM_DONOR_MNEMONIC_MAINNET }}
```

## TestNet rehearsal

A TestNet run uses test USDC. Set `NETWORK: testnet`. Set `endpoint` to
the TestNet server origin. Use the TestNet donor secret.

```yaml
jobs:
  build:
    runs-on: ubuntu-24.04
    env:
      NETWORK: testnet
    steps:
      - uses: actions/checkout@<40-character SHA>
        with:
          persist-credentials: false
      - uses: actions/setup-node@<40-character SHA>
        with:
          node-version: 22
      - name: Install and donate on TestNet
        uses: TriplEight/AuPM/.github/actions/aupm@<40-character SHA>
        with:
          endpoint: ${{ vars.AUPM_TESTNET_ENDPOINT }}
          donate: 'true'
          donor-secret: ${{ secrets.AUPM_DONOR_MNEMONIC_TESTNET }}
```

The [aupm-action-demo](https://github.com/TriplEight/aupm-action-demo)
workflow selects the network with a `workflow_dispatch` input. Its default
is MainNet.

The pinned SHA must contain PR #45 (merge
`ef335ce9a5a3ecd11231831e32241ea505b02bce`) or a later commit. An older SHA
builds the MainNet payment with TestNet parameters, and the facilitator
rejects it.

A run pays 1,000 microUSDC for each lockfile entry that has a review on the
server of that network. The MainNet and TestNet servers have different
review sets, so the same lockfile costs a different amount on each network.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `endpoint` | (required) | URL of the AuPM server. |
| `lockfile` | (empty) | Path to the lockfile. The install command runs in its directory. Empty means the Action uses the one of `package-lock.json`, `pnpm-lock.yaml` and `yarn.lock` in the working directory. |
| `install` | `auto` | `auto` picks the tool from the lockfile name. `npm`, `pnpm` and `yarn` (classic) force one tool. Each installs through the AuPM registry, with fallback to the public registry. `none` skips the install. Any other value fails the step. |
| `donate` | `false` | Set to `true` to donate to the reviewed packages. |
| `donor-secret` | (empty) | The donor mnemonic (25 words) from a GitHub secret. MainNet unless the job sets `NETWORK: testnet`. Read only when `donate` is `true`. |
| `output` | `aupm-receipt.json` | Path where the Action writes the signed receipt. |
| `fail-on-mismatch` | `false` | Set to `true` to fail the step on `integrityMismatch` above zero. |

Upload the receipt file with `actions/upload-artifact` in a later step.

## Outputs

| Output | Description |
| --- | --- |
| `output-path` | Path of the signed receipt. |
| `settlement-txid` | The settlement txid of the donation. Empty when nothing was paid. |
| `donated-micro-usdc` | The donated amount in microUSDC. Empty when nothing was paid. |

## Install and fallback

The install step runs first. It runs in the directory of the lockfile.

### Choose the lockfile and the tool

- `lockfile` set and `install: auto`: the file name picks the tool.
  `package-lock.json` means npm, `pnpm-lock.yaml` means pnpm, and
  `yarn.lock` means yarn. Another file name fails the step.
- `lockfile` empty: the Action looks in the working directory for the three
  file names. One file is the lockfile. No file fails the step, as `npm ci`
  does. Two or more files fail the step. The message names the files and
  tells you to set `lockfile` or `install`.
- `install: npm`, `pnpm` or `yarn` with an empty `lockfile`: the Action uses
  the lockfile name of that tool.

The install step writes the lockfile path to its output. The check step reads
the same path, so both steps use the same file.

### Commands

| Tool | Command |
| --- | --- |
| npm | `npm ci --registry <endpoint>` |
| pnpm | `pnpm install --frozen-lockfile`, with `npm_config_registry=<endpoint>` |
| yarn classic | `yarn install --frozen-lockfile`, with `npm_config_registry=<endpoint>` |

1. If the command fails, the step logs a warning. The step then runs the same
   command against the public registry. This command uses the configuration of
   the project. The warning text is:
   `::warning::AuPM registry install failed; installing from the npm registry instead.`
2. If the second command also fails, the step fails and the job fails. This is
   the same as a plain install step. The donation steps do not run.

An unknown `install` value is a configuration error. The step fails with a
message that names the value.

### Yarn versions

Before a yarn install, the step runs `yarn --version`.

- `1.x.y` is yarn classic. The step uses the commands above.
- Major version 2 or higher is yarn berry. AuPM does not support it yet. The step
  logs `AuPM does not support yarn berry yet; installing without AuPM and
  skipping the check.` It runs `yarn install --immutable` with the configuration
  of the job and skips the check and donation step. A failed install still
  fails the job.
- Any other output, a failed `yarn --version` or a missing yarn fails the step.

## Projects that install another way

Set `install: none` if the project installs in its own step. The Action then
skips the install and only checks the lockfile. The lockfile rules above
apply: set `lockfile`, or keep exactly one lockfile in the working directory.

## What the Action does with the lockfile

The Action runs the published `aupm-cli` package, pinned to an exact
version, with `npm exec --yes --package=aupm-cli@<version> -- aupm attest
<lockfile>`. The version is one constant in `run.mjs`. The command runs in
the working directory of the job, with the Node and npm of the job.
`npm exec` downloads the package from the npm registry.

The Action does not change the Node version or the `PATH` of later steps.
It writes nothing to `GITHUB_PATH` or `GITHUB_ENV`.

The Action never parses or re-serializes the lockfile. The CLI reads it as
raw bytes. The server signs a digest of the exact request body. The signed
receipt is a DSSE envelope that holds an in-toto Statement v1.

A lockfile with zero reviewed packages is free. The CLI exits 0 without
donating.

## Donation

A lockfile with reviewed packages needs payment. Donation is off by
default. Set `donate: 'true'` and pass `donor-secret` (a GitHub secret)
to opt in.

The Action maps `donor-secret` to the CLI's `AUPM_DONOR_MNEMONIC`
environment variable. It maps `donate: 'true'` to the CLI's `--donate`
flag.

A paid run shows the settlement txid in three places:

- A `::notice::` annotation on the run page, for example
  `AuPM donation: 30000 microUSDC, settlement txid <txid> <explorer link>`.
- An "AuPM donation" table in the job summary. The txid links to the Lora
  explorer of the network that `NETWORK` selects.
- The step outputs `settlement-txid` and `donated-micro-usdc`. A later
  step reads them, for example
  `${{ steps.<id>.outputs.settlement-txid }}`. Both are empty when
  nothing was paid.

The donor pays on Algorand MainNet by default. The Action has no network
input. It reads `NETWORK` (`mainnet` or `testnet`) from the job's `env:`.
An unset `NETWORK` means MainNet. If `NETWORK` does not match the server's
network, the 402 does not match the donor's network, and the run pays
nothing.

WARNING: pass `donor-secret` only through a GitHub secret in `with:`. The
Action forwards it through the spawned CLI's environment only. It never
appears in argv, a file, or a log line.

Without `donate: 'true'`, the reviewed entries are withheld, not refused.
The CLI still writes a partial signed receipt and exits 0. The Action reads
the withheld count from the CLI output, logs a `::warning::` that names it,
and exits 0.

The CLI signs a payment locally, inside its own process, before any
network call. The Action never sends a bare mnemonic to any endpoint.

CAUTION: never configure `donor-secret` for an account you cannot afford
to spend from. The CLI enforces two limits:

- It refuses to sign above 1,000 microUSDC per lockfile entry (SPEC.md
  §11.4). There is no fixed cap.
- It refuses any asset other than the USDC ASA of the network.

A compromised `endpoint` input can still misdirect a donated payment.

## Failure policy

An install failure fails the job, as with plain npm. An AuPM failure never
fails the job: a registry failure falls back to the public registry, and a check or
donation failure logs a warning.

WARNING: after the install, each of the following logs a `::warning::` and
exits 0:

- A missing endpoint.
- A failure to start the `aupm` CLI.
- Reviewed entries withheld because `donate` is not set.
- A missing `donor-secret` with `donate` set.
- A facilitator outage or a 5xx response.
- A spend-cap refusal.
- Any other CLI error.

Set `fail-on-mismatch: 'true'` to change this for one case. The step then
exits 1 when the summary reports `integrityMismatch` above zero.

A step that makes someone else's CI fail gets removed from their
repository. This policy keeps the Action safe to adopt.

## Triggers

WARNING: do not add a recurring schedule trigger to the calling workflow.
The facilitator classifies repeating loop patterns, such as cron pings and
health checks, as `DEV` traffic. Trigger on `pull_request` and `push` only.

## Local development

Run the scripts directly with Node. Pass flags in place of workflow
inputs, or set the matching environment variables.

```bash
ENDPOINT=https://aupm.example.com \
LOCKFILE=package-lock.json \
OUTPUT=aupm-receipt.json \
  node run.mjs
```

```bash
ENDPOINT=https://aupm.example.com \
INSTALL=auto \
  node install.mjs
```

Set `donate: 'true'` locally with `DONATE=true` and
`DONOR_SECRET=<mnemonic>` in the environment. There is no
`--donor-secret` flag. A secret does not belong in argv, even for local
development.

`install.mjs` and `run.mjs` use only Node built-in modules. They need no
install step of their own. `run.mjs` spawns the published `aupm`
CLI through `npm exec --package=aupm-cli@<version>`.

## Testing

Run the test suite with Node's built-in test runner.

```bash
node --test *.test.mjs
```

The `run.mjs` tests stub the `aupm` CLI with a fake `npm` executable. Some
`install.mjs` tests stub `npm` the same way. Others inject a fake `spawn`.
Coverage includes:

- An AuPM install that passes, with no fallback.
- An AuPM install that fails and a plain install that passes.
- Both installs failing.
- Lockfile detection: one file, no file, two files, and an unknown file name.
- The commands and the registry environment of npm, pnpm and yarn classic.
- Yarn classic, yarn berry, an invalid yarn version and a missing yarn.
- That the check step uses the lockfile that the install step resolved.
- `install: none` and an unknown `install` value.
- A missing endpoint.
- A spawn failure.
- A withheld-count warning when `donate` is not set.
- A missing `donor-secret` with `donate` set.
- A generic CLI error.
- Both `fail-on-mismatch` outcomes.
- That the donor secret reaches the CLI only through its environment,
  never argv.
