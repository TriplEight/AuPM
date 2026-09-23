# spm-attest GitHub Action

This composite action runs the `spm` CLI's `attest` command against the SPM
attestation server. It writes the signed envelope to disk for upload as a
build artifact.

## Usage

Add this step to a workflow that triggers on `pull_request` or `push`.

```yaml
- uses: ./.github/actions/spm-attest
  with:
    endpoint: ${{ vars.SPM_ENDPOINT }}
    lockfile: package-lock.json
    fail-on-mismatch: 'false'
    output: spm-attestation.json
```

Upload the output file with `actions/upload-artifact` in a later step.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `endpoint` | (required) | URL of the SPM attestation server. |
| `lockfile` | `package-lock.json` | Path to the lockfile the action posts. |
| `fail-on-mismatch` | `false` | Set to `true` to fail the step on `integrityMismatch` above zero. |
| `output` | `spm-attestation.json` | Path where the action writes the signed envelope. |
| `donate` | `false` | Set to `true` to pay for a reviewed lockfile attestation. |
| `donor-mnemonic` | (empty) | A funded MainNet donor mnemonic, from a GitHub secret. Read only when `donate` is `true`. |

## Behavior

The action installs the `spm` CLI's own dependencies (`cli/`, `mcp/`).
It installs them from this action's own repository checkout, not the
caller's. It then spawns `spm attest <lockfile>`.

The action never parses or re-serializes the lockfile. The CLI reads it as
raw bytes. The server signs a digest of the exact request body.

A lockfile with zero reviewed packages is free. The CLI exits 0 without
donating.

## Paid attestation (donation)

A lockfile with reviewed packages needs payment. Donation is off by
default. Set `donate: 'true'` and pass `donor-mnemonic` (a GitHub secret)
to opt in.

The action maps `donor-mnemonic` to the CLI's `SPM_DONOR_MNEMONIC`
environment variable. It maps `donate: 'true'` to the CLI's `--donate`
flag.

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
ENDPOINT=https://spm.example.com \
LOCKFILE=package-lock.json \
OUTPUT=spm-attestation.json \
  node attest.mjs
```

`SETUP_OK` defaults to `true`. Set it to `false` to simulate a failed
dependency install.

Set `donate: 'true'` locally with `DONATE=true` and
`DONOR_MNEMONIC=<mnemonic>` in the environment. There is no
`--donor-mnemonic` flag. A secret does not belong in argv, even for local
development.

`attest.mjs` uses only Node built-in modules. It needs no install step of
its own. It spawns the already-installed `spm` CLI through `pnpm exec`.

## Testing

Run the test suite with Node's built-in test runner.

```bash
node --test attest.test.mjs
```

The tests stub the `spm` CLI with a fake `pnpm` executable. They place it
first on `PATH`. Coverage includes:

- A missing endpoint.
- A failed dependency setup.
- A withheld-count warning when `donate` is not set.
- A missing `donor-mnemonic` with `donate` set.
- A generic CLI error.
- Both `fail-on-mismatch` outcomes.
- That a donor mnemonic reaches the CLI only through its environment,
  never argv.
