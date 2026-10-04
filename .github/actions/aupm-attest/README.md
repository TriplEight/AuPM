# aupm-attest GitHub Action

This composite action runs the `aupm` CLI's `attest` command against the AuPM
attestation server. It writes the signed envelope to disk for upload as a
build artifact.

## Usage

Add this step to a workflow that triggers on `pull_request` or `push`.
Pin the action to a full 40-character commit SHA of `TriplEight/AuPM`.
Never use a branch name or a short SHA.

```yaml
- uses: TriplEight/AuPM/.github/actions/aupm-attest@<40-character SHA>
  with:
    endpoint: https://aupm.fyi
    lockfile: package-lock.json
    output: aupm-attestation.json
```

Upload the output file with `actions/upload-artifact` in a later step.
Without `donate: 'true'`, the action pays nothing and writes a partial
attestation.

### Donate on MainNet or TestNet

Use one donor secret for each network. Put the network in the secret name,
for example `AUPM_DONOR_MNEMONIC_MAINNET` and `AUPM_DONOR_MNEMONIC_TESTNET`.
Then a secret cannot pay on the wrong network.

MainNet pays real USDC. Set `NETWORK: mainnet` in the job's `env:`, so the
network is explicit in the log:

```yaml
jobs:
  attest:
    name: attest on mainnet
    runs-on: ubuntu-24.04
    env:
      NETWORK: mainnet
    steps:
      - uses: actions/checkout@<40-character SHA>
        with:
          persist-credentials: false
      - name: AuPM attestation (donates on mainnet)
        uses: TriplEight/AuPM/.github/actions/aupm-attest@<40-character SHA>
        with:
          endpoint: https://aupm.fyi
          lockfile: package-lock.json
          donate: 'true'
          donor-mnemonic: ${{ secrets.AUPM_DONOR_MNEMONIC_MAINNET }}
```

For a TestNet rehearsal, set `NETWORK: testnet`, the TestNet server origin
as `endpoint`, and the TestNet donor secret. The
[aupm-action-demo](https://github.com/TriplEight/aupm-action-demo) workflow
selects the network with a `workflow_dispatch` input. Its default is
MainNet.

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
| `endpoint` | (required) | URL of the AuPM attestation server. |
| `lockfile` | `package-lock.json` | Path to the lockfile the action posts. |
| `fail-on-mismatch` | `false` | Set to `true` to fail the step on `integrityMismatch` above zero. |
| `output` | `aupm-attestation.json` | Path where the action writes the signed envelope. |
| `donate` | `false` | Set to `true` to pay for a reviewed lockfile attestation. |
| `donor-mnemonic` | (empty) | A funded donor mnemonic, from a GitHub secret. MainNet unless the job sets `NETWORK: testnet`. Read only when `donate` is `true`. |

## Behavior

The action installs the `aupm` CLI's own dependencies (`cli/`, `mcp/`).
It installs them from this action's own repository checkout, not the
caller's. It then spawns `aupm attest <lockfile>`.

The action never parses or re-serializes the lockfile. The CLI reads it as
raw bytes. The server signs a digest of the exact request body.

A lockfile with zero reviewed packages is free. The CLI exits 0 without
donating.

## Paid attestation (donation)

A lockfile with reviewed packages needs payment. Donation is off by
default. Set `donate: 'true'` and pass `donor-mnemonic` (a GitHub secret)
to opt in.

The action maps `donor-mnemonic` to the CLI's `AUPM_DONOR_MNEMONIC`
environment variable. It maps `donate: 'true'` to the CLI's `--donate`
flag.

A paid run logs a `::notice::` with the amount and the settlement txid,
for example `AuPM donation: 30000 microUSDC, settlement txid <txid>`. It
adds the same line to the job summary.

The donor pays on Algorand MainNet by default. The action has no network
input. It reads `NETWORK` (`mainnet` or `testnet`) from the job's `env:`.
An unset `NETWORK` means MainNet. If `NETWORK` does not match the server's
network, the 402 does not match the donor's network, and the run pays
nothing.

WARNING: pass `donor-mnemonic` only through a GitHub secret in `with:`. The
action forwards it through the spawned CLI's environment only. It never
appears in argv, a file, or a log line.

Without `donate: 'true'`, the reviewed entries are withheld, not refused:
the CLI still writes a partial attestation and exits 0. The action reads
the withheld count from its output, logs a `::warning::` naming it, and
still exits 0.

The CLI signs a payment locally, inside its own process, before any
network call. The action never sends a bare mnemonic to any endpoint.

CAUTION: never configure `donor-mnemonic` for an account you cannot afford
to spend from. The CLI enforces two limits:

- It refuses to sign above 1,000 microUSDC per lockfile entry (SPEC.md
  §11.4) — never a fixed cap.
- It refuses any asset other than the network's USDC ASA.

A compromised `endpoint` input can still misdirect a donated payment.

## Fail-open policy

WARNING: this action fails open by default. Each of the following logs a
`::warning::` and exits 0, never `fail-on-mismatch`:

- A missing endpoint.
- A pnpm or dependency-install failure.
- Reviewed entries withheld because `donate` is not set.
- A missing `donor-mnemonic` with `donate` set.
- A facilitator outage or a 5xx response.
- A spend-cap refusal.
- Any other CLI error.

Set `fail-on-mismatch: 'true'` to change this for one case only. The step
then exits 1 when the summary reports `integrityMismatch` above zero.

An attestation step that reddens someone else's CI gets removed from their
repository the first time it does. Fail-open behavior keeps this action
safe to adopt.

## Triggers

WARNING: do not add a recurring schedule trigger to the calling workflow.
The facilitator classifies repeating loop patterns, such as cron pings and
health checks, as `DEV` traffic. Trigger on `pull_request` and `push` only.

## Local development

Run the wrapper directly with Node. Pass flags in place of workflow inputs,
or set the matching environment variables.

```bash
ENDPOINT=https://aupm.example.com \
LOCKFILE=package-lock.json \
OUTPUT=aupm-attestation.json \
  node attest.mjs
```

`SETUP_OK` defaults to `true`. Set it to `false` to simulate a failed
dependency install.

Set `donate: 'true'` locally with `DONATE=true` and
`DONOR_MNEMONIC=<mnemonic>` in the environment. There is no
`--donor-mnemonic` flag. A secret does not belong in argv, even for local
development.

`attest.mjs` uses only Node built-in modules. It needs no install step of
its own. It spawns the already-installed `aupm` CLI through `pnpm exec`.

## Testing

Run the test suite with Node's built-in test runner.

```bash
node --test attest.test.mjs
```

The tests stub the `aupm` CLI with a fake `pnpm` executable. They place it
first on `PATH`. Coverage includes:

- A missing endpoint.
- A failed dependency setup.
- A withheld-count warning when `donate` is not set.
- A missing `donor-mnemonic` with `donate` set.
- A generic CLI error.
- Both `fail-on-mismatch` outcomes.
- That a donor mnemonic reaches the CLI only through its environment,
  never argv.
