# spm-attest GitHub Action

This composite action posts a lockfile to the SPM attestation server. It
writes the signed envelope to disk for upload as a build artifact.

## Usage

Add this step to a workflow that triggers on `pull_request` or `push`.

```yaml
- uses: ./.github/actions/spm-attest
  with:
    endpoint: ${{ vars.SPM_ENDPOINT }}
    lockfile: package-lock.json
    wallet-secret: ${{ secrets.SPM_WALLET_SECRET }}
    fail-on-mismatch: 'false'
    output: spm-attestation.json
```

Upload the output file with `actions/upload-artifact` in a later step.

## Inputs

| Input | Default | Description |
| --- | --- | --- |
| `endpoint` | (required) | URL of the SPM attestation server. |
| `lockfile` | `package-lock.json` | Path to the lockfile the action posts. |
| `wallet-secret` | (empty) | Wallet secret used to retry a paid attestation. |
| `fail-on-mismatch` | `false` | Set to `true` to fail the step on `INTEGRITY_MISMATCH`. |
| `output` | `spm-attestation.json` | Path where the action writes the signed envelope. |

## Behavior

The action reads the lockfile as raw bytes. It posts those bytes unchanged.
It never parses or re-serializes the lockfile. The server signs a digest of
the exact request body. A re-serialized body breaks that digest.

A lockfile with zero reviewed packages is free. The server returns 200
without a 402. The action needs no wallet secret for this case.

A lockfile with reviewed packages triggers a 402 response. The action
retries the request exactly once. It adds a payment header built from
`wallet-secret` on that one retry.

CAUTION: the action never retries a 402 more than once. The facilitator
classifies repeating retries as `DEV` traffic. `DEV` traffic does not count
toward review funding.

## Fail-open policy

WARNING: this action fails open by default. A network failure, a DNS
failure, a 5xx response, a missing wallet secret, a missing lockfile, or a
malformed response logs a `::warning::` and exits 0.

Set `fail-on-mismatch: true` to change this for one case only. The step
then exits 1 when the summary reports `integrityMismatch` above zero.

An attestation step that reddens someone else's CI gets removed from their
repository the first time it does. Fail-open behavior keeps this action
safe to adopt.

## Triggers

WARNING: do not add a recurring schedule trigger to the calling workflow.
The facilitator classifies repeating loop patterns, such as cron pings and
health checks, as `DEV` traffic. Trigger on `pull_request` and `push` only.

## Local development

Run the script directly with Node. Pass flags in place of workflow inputs.

```bash
node attest.mjs \
  --endpoint https://spm.example.com \
  --lockfile package-lock.json \
  --wallet-secret "$WALLET_SECRET" \
  --output spm-attestation.json
```

`attest.mjs` uses only Node built-in modules. It needs no install step.

## Testing

Run the test suite with Node's built-in test runner.

```bash
node --test attest.test.mjs
```

The tests start local stub HTTP servers with `node:http`. They cover the
free-lockfile path, a 5xx response, the single 402 retry, both
`fail-on-mismatch` outcomes, and exact-byte-equality of the posted body.
